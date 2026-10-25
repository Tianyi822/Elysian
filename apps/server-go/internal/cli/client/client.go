package client

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"
)

// 请求时限与响应体积上限：JSON 端点单请求 30 秒（后端普通 JSON 读写接缝 15/60 秒
// 之内）、响应体读取上限 4 MiB（模型目录是最大的常规响应）；SSE 流式端点由后续
// 聊天阶段单独建接缝，不经本 Client。
const (
	requestTimeout = 30 * time.Second
	responseLimit  = 4 << 20
	errorBodyLimit = 64 << 10
)

// Client 面板回环客户端：baseURL 形如 http://127.0.0.1:48101；全部请求（含 GET）
// 统一携带 Origin: <baseURL>（与 Host 逐字一致，通过同源守卫，CLI 方案 §3.2）；
// 会话 Cookie 只保存在内存，持久化由调用方（cli/clisession.go）负责。
type Client struct {
	baseURL string
	cookie  string
	http    *http.Client
}

// New 构造客户端；baseURL 尾部斜杠归一。
func New(baseURL string) *Client {
	return &Client{
		baseURL: trimTrailingSlash(baseURL),
		http:    &http.Client{Timeout: requestTimeout},
	}
}

// BaseURL 返回当前后端地址（持久化凭据时使用）。
func (c *Client) BaseURL() string { return c.baseURL }

// SetSessionCookie 设置 elysian_session Cookie 值。
func (c *Client) SetSessionCookie(cookie string) { c.cookie = cookie }

// SessionCookie 返回当前 Cookie 值（空串表示未登录）。
func (c *Client) SessionCookie() string { return c.cookie }

// errClient 参数与状态错误（未发起网络请求前失败）。
func errClient(kind Kind, message string) *Error {
	return &Error{Kind: kind, Message: message, Hint: HintFor(kind)}
}

// do 执行一次 JSON 请求：body 非 nil 时以 application/json 编码上送；2xx 响应按
// out（非 nil 时）宽松解析（未知字段忽略、缺失字段零值，与 Web adapter 的防御性
// 解析口径一致）并返回响应头（Login 提取 Set-Cookie 用）；非 2xx 归入五态错误。
// notFound 用于把 404 细化为业务可读消息（可为空）。
func (c *Client) do(ctx context.Context, method, path string, query map[string]string, body, out any, notFound string) (http.Header, error) {
	endpoint := c.baseURL + path
	if len(query) > 0 {
		values := url.Values{}
		for key, value := range query {
			values.Set(key, value)
		}
		endpoint += "?" + values.Encode()
	}
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, errClient(KindServer, "请求构造失败："+err.Error())
		}
		payload = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, payload)
	if err != nil {
		return nil, errClient(KindServer, "请求构造失败："+err.Error())
	}
	// Origin 契约（§3.2）：与请求 Host（URL 派生）逐字一致，写请求过同源守卫。
	req.Header.Set("Origin", c.baseURL)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.cookie != "" {
		req.Header.Set("Cookie", "elysian_session="+c.cookie)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, classifyTransport(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, errorBodyLimit))
		retryAfter := 0
		if seconds, err := strconv.Atoi(resp.Header.Get("Retry-After")); err == nil && seconds > 0 {
			retryAfter = seconds
		}
		serverErr := serverError(resp.StatusCode, raw, retryAfter)
		if serverErr.Status == 404 && notFound != "" {
			serverErr.Message = notFound
		}
		return nil, serverErr
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, responseLimit))
		return resp.Header, nil
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, responseLimit))
	if err != nil {
		return nil, &Error{Kind: KindBadResponse, Message: "读取面板响应失败：" + err.Error()}
	}
	if err := decodeJSON(raw, out); err != nil {
		return nil, &Error{Kind: KindBadResponse, Message: "面板响应解析失败：" + err.Error()}
	}
	return resp.Header, nil
}

// decodeJSON 宽松解析：json.Unmarshal（忽略未知字段，缺字段零值）。
func decodeJSON(raw []byte, out any) error {
	return json.Unmarshal(raw, out)
}

func trimTrailingSlash(base string) string {
	for len(base) > 0 && base[len(base)-1] == '/' {
		base = base[:len(base)-1]
	}
	return base
}
