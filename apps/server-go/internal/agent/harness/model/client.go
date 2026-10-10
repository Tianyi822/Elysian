package model

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"elysian/server/internal/agent/jsonvalue"
)

const MaxResponseBytes = 512 * 1024
const maxRequestBytes = 8 * 1024 * 1024
const maxToolCalls = 64

var functionName = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

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

type wireFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type wireCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function wireFunction `json:"function"`
}

type wireMessage struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []wireCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type wireTool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description,omitempty"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

type wireRequest struct {
	Model      string        `json:"model"`
	Messages   []wireMessage `json:"messages"`
	Tools      []wireTool    `json:"tools,omitempty"`
	MaxTokens  int           `json:"max_tokens"`
	ToolChoice any           `json:"tool_choice,omitempty"`
	Stream     bool          `json:"stream"`
}

func (c *httpClient) Complete(ctx context.Context, p Profile, input Request) (Response, error) {
	if ctx == nil {
		return Response{}, problem(400, "invalid-model-request", "模型请求缺少上下文")
	}
	if err := validateProfile(p); err != nil {
		return Response{}, err
	}
	wire, names, err := prepareRequest(p, input)
	if err != nil {
		return Response{}, err
	}
	b, err := json.Marshal(wire)
	if err != nil || len(b) > maxRequestBytes {
		return Response{}, problem(413, "model-request-too-large", "模型请求超过允许的大小")
	}
	endpoint := strings.TrimRight(p.BaseURL, "/") + "/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(b))
	if err != nil {
		return Response{}, problem(400, "invalid-model-request", "模型请求地址无效")
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if p.Credential != "" {
		req.Header.Set("Authorization", "Bearer "+p.Credential)
	}
	response, err := c.client.Do(req)
	if err != nil {
		return Response{}, requestError(ctx, err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode <= 399 {
		return Response{}, problem(502, "model-redirect-refused", "模型服务要求跳转，已阻止请求以保护凭据")
	}
	if response.StatusCode != http.StatusOK {
		switch response.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return Response{}, problem(502, "model-auth-failed", "模型服务鉴权失败，请检查配置凭据")
		case http.StatusTooManyRequests:
			return Response{}, problem(502, "model-rate-limited", "模型服务请求受到限流，请稍后重试")
		default:
			return Response{}, problem(502, "model-http-failed", "模型服务返回异常状态，请检查模型服务")
		}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, MaxResponseBytes+1))
	if err != nil {
		return Response{}, requestError(ctx, err)
	}
	if len(body) > MaxResponseBytes {
		return Response{}, problem(502, "model-response-too-large", "模型响应超过允许的大小")
	}
	return parseResponse(body, names, input.ToolChoice)
}

func prepareRequest(p Profile, input Request) (wireRequest, map[string]bool, error) {
	if !p.Capabilities.Text || (len(input.Tools) > 0 && !p.Capabilities.Tools) {
		return wireRequest{}, nil, problem(400, "model-capability-unavailable", "所选模型不支持本次请求需要的能力")
	}
	if len(input.Messages) == 0 || input.MaxTokens < 1 || input.MaxTokens > p.OutputTokens || len(input.Tools) > maxToolCalls {
		return wireRequest{}, nil, invalidRequest()
	}
	request := wireRequest{Model: p.Model, MaxTokens: input.MaxTokens, Messages: make([]wireMessage, 0, len(input.Messages))}
	names := make(map[string]bool)
	for _, t := range input.Tools {
		if !functionName.MatchString(t.Name) || names[t.Name] || !objectJSON(t.Parameters) || !utf8.ValidString(t.Description) {
			return wireRequest{}, nil, invalidRequest()
		}
		var schema struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(t.Parameters, &schema) != nil || schema.Type != "object" {
			return wireRequest{}, nil, invalidRequest()
		}
		names[t.Name] = true
		tool := wireTool{Type: "function"}
		tool.Function.Name, tool.Function.Description, tool.Function.Parameters = t.Name, t.Description, t.Parameters
		request.Tools = append(request.Tools, tool)
	}
	switch input.ToolChoice {
	case "":
	case "none":
		request.ToolChoice = "none"
	case "auto", "required":
		if len(names) == 0 {
			return wireRequest{}, nil, invalidRequest()
		}
		request.ToolChoice = input.ToolChoice
	default:
		if !names[input.ToolChoice] {
			return wireRequest{}, nil, invalidRequest()
		}
		request.ToolChoice = map[string]any{"type": "function", "function": map[string]string{"name": input.ToolChoice}}
	}
	pending, seen := make(map[string]bool), make(map[string]bool)
	for _, msg := range input.Messages {
		if !utf8.ValidString(msg.Content) || len(msg.ToolCalls) > maxToolCalls {
			return wireRequest{}, nil, invalidRequest()
		}
		w := wireMessage{Role: msg.Role, Content: msg.Content, ToolCallID: msg.ToolCallID}
		if msg.Role != "tool" && len(pending) > 0 {
			return wireRequest{}, nil, problem(400, "incomplete-tool-history", "模型上下文包含未完成的工具调用")
		}
		switch msg.Role {
		case "system", "user":
			if len(msg.ToolCalls) != 0 || msg.ToolCallID != "" {
				return wireRequest{}, nil, invalidRequest()
			}
		case "assistant":
			if msg.ToolCallID != "" {
				return wireRequest{}, nil, invalidRequest()
			}
			for _, call := range msg.ToolCalls {
				if !validCallID(call.ID) || seen[call.ID] || !functionName.MatchString(call.Name) || !objectJSON(call.Arguments) {
					return wireRequest{}, nil, invalidRequest()
				}
				seen[call.ID], pending[call.ID] = true, true
				w.ToolCalls = append(w.ToolCalls, wireCall{ID: call.ID, Type: "function", Function: wireFunction{Name: call.Name, Arguments: string(call.Arguments)}})
			}
		case "tool":
			if !pending[msg.ToolCallID] || len(msg.ToolCalls) != 0 {
				return wireRequest{}, nil, invalidRequest()
			}
			delete(pending, msg.ToolCallID)
		default:
			return wireRequest{}, nil, invalidRequest()
		}
		request.Messages = append(request.Messages, w)
	}
	if len(pending) > 0 {
		return wireRequest{}, nil, problem(400, "incomplete-tool-history", "模型上下文包含未完成的工具调用")
	}
	return request, names, nil
}

func parseResponse(body []byte, names map[string]bool, choice string) (Response, error) {
	canonical, err := jsonvalue.Canonical(body)
	if err != nil {
		return Response{}, invalidResponse()
	}
	body = canonical
	// 只声明公开标准字段；供应商私有 reasoning、debug 与错误正文不进入返回值。
	var wire struct {
		Choices []struct {
			Index   int `json:"index"`
			Message struct {
				Role      string          `json:"role"`
				Content   json.RawMessage `json:"content"`
				ToolCalls []wireCall      `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage *struct {
			PromptTokens     *int `json:"prompt_tokens"`
			CompletionTokens *int `json:"completion_tokens"`
			TotalTokens      *int `json:"total_tokens"`
			PromptDetails    *struct {
				CachedTokens *int `json:"cached_tokens"`
			} `json:"prompt_tokens_details"`
		} `json:"usage"`
	}
	if !utf8.Valid(body) || json.Unmarshal(body, &wire) != nil || len(wire.Choices) != 1 || wire.Choices[0].Index != 0 {
		return Response{}, invalidResponse()
	}
	answer := wire.Choices[0]
	if answer.Message.Role != "assistant" || len(answer.Message.ToolCalls) > maxToolCalls {
		return Response{}, invalidResponse()
	}
	response := Response{FinishReason: answer.FinishReason}
	if len(answer.Message.Content) > 0 && string(answer.Message.Content) != "null" {
		if json.Unmarshal(answer.Message.Content, &response.Content) != nil {
			return Response{}, invalidResponse()
		}
	}
	switch answer.FinishReason {
	case "stop", "length", "content_filter":
		if len(answer.Message.ToolCalls) != 0 {
			return Response{}, invalidResponse()
		}
	case "tool_calls":
		if len(answer.Message.ToolCalls) == 0 || choice == "none" {
			return Response{}, invalidResponse()
		}
	default:
		return Response{}, invalidResponse()
	}
	if answer.FinishReason == "stop" && choice != "" && choice != "auto" && choice != "none" {
		return Response{}, invalidResponse()
	}
	seen := make(map[string]bool)
	for _, call := range answer.Message.ToolCalls {
		if call.Type != "function" || !validCallID(call.ID) || seen[call.ID] || !names[call.Function.Name] || !objectJSON([]byte(call.Function.Arguments)) {
			return Response{}, invalidResponse()
		}
		if choice != "" && choice != "auto" && choice != "required" && choice != call.Function.Name {
			return Response{}, invalidResponse()
		}
		seen[call.ID] = true
		arguments, err := jsonvalue.Canonical(json.RawMessage(call.Function.Arguments))
		if err != nil {
			return Response{}, invalidResponse()
		}
		response.ToolCalls = append(response.ToolCalls, ToolCall{ID: call.ID, Name: call.Function.Name, Arguments: arguments})
	}
	if wire.Usage != nil {
		u := wire.Usage
		response.Usage = Usage{PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, TotalTokens: u.TotalTokens}
		if u.PromptDetails != nil {
			response.Usage.CachedTokens = u.PromptDetails.CachedTokens
		}
		for _, count := range []*int{response.Usage.PromptTokens, response.Usage.CompletionTokens, response.Usage.TotalTokens, response.Usage.CachedTokens} {
			if count != nil && *count < 0 {
				return Response{}, invalidResponse()
			}
		}
		if u.PromptTokens != nil && response.Usage.CachedTokens != nil && *response.Usage.CachedTokens > *u.PromptTokens {
			return Response{}, invalidResponse()
		}
	}
	return response, nil
}

func objectJSON(b []byte) bool {
	_, err := jsonvalue.Object(b)
	return err == nil
}

func validCallID(id string) bool {
	return cleanText(id, 200) && strings.IndexFunc(id, unicode.IsSpace) < 0
}

func invalidRequest() *Error {
	return problem(400, "invalid-model-request", "模型请求的消息、工具或输出上限无效")
}

func invalidResponse() *Error {
	return problem(502, "invalid-model-response", "模型响应不符合公开消息与函数调用协议")
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
