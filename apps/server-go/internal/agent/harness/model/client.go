package model

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const MaxResponseBytes = 512 * 1024
const maxRequestBytes = 16 * 1024 * 1024

// responseBytesPerToken 每个输出 token 预留的原始响应字节：供应商按小段增量逐帧发送，
// SSE 与 JSON 分帧的包装开销远大于正文本身。
const responseBytesPerToken = 512

// responseLimit 原始响应字节上限：基础上限加按输出上限预留的分帧开销，
// 思考模式的长回答不因逐帧包装被判超限；目录与未声明输出上限的读取沿用基础上限。
func responseLimit(maxTokens int) int {
	if maxTokens < 1 {
		return MaxResponseBytes
	}
	return MaxResponseBytes + maxTokens*responseBytesPerToken
}

type httpClient struct{ client *http.Client }

// NewClient 复制传入客户端，强制禁止重定向与 Cookie；请求只发送一次，不重试。
// nil 使用两分钟总时限；父进程仍应设置每次调用的 context 时限。
func NewClient(client *http.Client) Client {
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	copy := *client
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	copy.Jar = nil
	return &httpClient{client: &copy}
}

func (c *httpClient) Complete(ctx context.Context, p Profile, input Request) (Response, error) {
	if ctx == nil {
		return Response{}, problem(400, "invalid-model-request", "模型请求缺少上下文")
	}
	if err := validateProfile(p); err != nil {
		return Response{}, err
	}
	adapter, err := resolveProtocol(p.APIFormat)
	if err != nil {
		return Response{}, err
	}
	prepared, err := adapter.prepare(p, input)
	if err != nil {
		return Response{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, prepared.endpoint, bytes.NewReader(prepared.body))
	if err != nil {
		return Response{}, problem(400, "invalid-model-request", "模型请求地址无效")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if input.OnReasoning != nil || input.OnContent != nil {
		req.Header.Set("Accept", "text/event-stream, application/json")
	}
	for name, value := range prepared.headers {
		req.Header.Set(name, value)
	}
	limit := responseLimit(input.MaxTokens)
	if input.OnReasoning != nil || input.OnContent != nil {
		return c.stream(ctx, req, p.APIFormat, prepared.decode, input.OnReasoning, input.OnContent, limit)
	}
	body, err := c.send(ctx, req, limit)
	if err != nil {
		return Response{}, err
	}
	return prepared.decode(body)
}

// send 是生成与目录读取共用的传输边界，错误不包含上游正文或凭据。
func (c *httpClient) send(ctx context.Context, req *http.Request, limit int) ([]byte, error) {
	response, err := c.client.Do(req)
	if err != nil {
		return nil, requestError(ctx, err)
	}
	defer response.Body.Close()
	if err := responseStatusError(response.StatusCode); err != nil {
		return nil, err
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, int64(limit)+1))
	if err != nil {
		return nil, requestError(ctx, err)
	}
	if len(body) > limit {
		return nil, problem(502, "model-response-too-large", "模型响应超过允许的大小")
	}
	return body, nil
}

// responseStatusError 只回显 HTTP 状态与本地排查提示，不读取上游错误正文。
func responseStatusError(status int) error {
	if status == http.StatusOK {
		return nil
	}
	if status >= 300 && status < 400 {
		return problem(502, "model-redirect-refused", "模型服务要求跳转，已阻止请求以保护凭据")
	}
	switch status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return problem(502, "model-auth-failed", "模型服务鉴权失败，请检查配置凭据")
	case http.StatusTooManyRequests:
		return problem(502, "model-rate-limited", "模型服务请求受到限流，请稍后重试")
	}
	guidance := "请检查模型服务和请求配置"
	switch {
	case status == http.StatusBadRequest || status == http.StatusUnprocessableEntity:
		guidance = "模型服务拒绝请求参数，请检查协议、模型能力与请求配置"
	case status == http.StatusNotFound:
		guidance = "模型接口或模型不存在，请检查服务地址、协议与模型名称"
	case status == http.StatusRequestTimeout:
		guidance = "模型服务处理请求超时，请稍后重试"
	case status == http.StatusRequestEntityTooLarge:
		guidance = "模型服务拒绝过大的请求，请减少消息或附件内容"
	case status >= 500:
		guidance = "模型服务或其网关暂时异常，请稍后重试"
	}
	return problem(502, "model-http-failed", fmt.Sprintf("模型服务返回异常状态（HTTP %d）：%s", status, guidance))
}

func requestError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		return &Error{Status: 499, Code: "model-cancelled", Message: "模型请求已取消", cause: context.Canceled}
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return &Error{Status: 504, Code: "model-timeout", Message: "模型请求超过时间限制", cause: context.DeadlineExceeded}
	}
	return problem(502, "model-unavailable", "模型请求失败，结果未确认，请检查模型服务")
}
