package model

import (
	"encoding/base64"
	"encoding/json"
	"unicode/utf8"

	"elysian/server/internal/agent/jsonvalue"
)

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
	Reasoning  *string    `json:"reasoning_content,omitempty"`
	Role       string     `json:"role"`
	Content    any        `json:"content"`
	ToolCalls  []wireCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

// wireContentPart 是带图 user 消息的 content 数组成员：文本段或 Data URL 图片段。
type wireContentPart struct {
	Type     string        `json:"type"`
	Text     string        `json:"text,omitempty"`
	ImageURL *wireImageURL `json:"image_url,omitempty"`
}

type wireImageURL struct {
	URL string `json:"url"`
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
	ReasoningEffort string        `json:"reasoning_effort,omitempty"`
	Thinking        *wireThinking `json:"thinking,omitempty"`
	Model           string        `json:"model"`
	Messages        []wireMessage `json:"messages"`
	Tools           []wireTool    `json:"tools,omitempty"`
	MaxTokens       int           `json:"max_tokens"`
	ToolChoice      any           `json:"tool_choice,omitempty"`
	Stream          bool          `json:"stream"`
}

type wireThinking struct {
	Type string `json:"type"`
}

func prepareRequest(p Profile, input Request) (wireRequest, map[string]bool, error) {
	names, err := validateRequest(p, input)
	if err != nil {
		return wireRequest{}, nil, err
	}
	request := wireRequest{Stream: input.OnReasoning != nil || input.OnContent != nil, Model: p.Model, MaxTokens: input.MaxTokens, Messages: make([]wireMessage, 0, len(input.Messages))}
	request.ReasoningEffort = ReasoningEffort(input.ReasoningLevel)
	for _, tool := range input.Tools {
		t := wireTool{Type: "function"}
		t.Function.Name, t.Function.Description, t.Function.Parameters = tool.Name, tool.Description, tool.Parameters
		request.Tools = append(request.Tools, t)
	}
	switch input.ToolChoice {
	case "":
	case "none", "auto", "required":
		request.ToolChoice = input.ToolChoice
	default:
		request.ToolChoice = map[string]any{"type": "function", "function": map[string]string{"name": input.ToolChoice}}
	}
	for _, msg := range input.Messages {
		w := wireMessage{Role: msg.Role, ToolCallID: msg.ToolCallID}
		if len(msg.Images) > 0 {
			// 带图 user 消息序列化为 content parts：文本段在前，图片段按 Data URL 编码；
			// 智谱与 DeepSeek 共用同一 image_url 形状，前缀按附件魔数判定的 MIME 生成。
			parts := make([]wireContentPart, 0, len(msg.Images)+1)
			if msg.Content != "" {
				parts = append(parts, wireContentPart{Type: "text", Text: msg.Content})
			}
			for _, image := range msg.Images {
				parts = append(parts, wireContentPart{Type: "image_url", ImageURL: &wireImageURL{URL: "data:" + image.MimeType + ";base64," + base64.StdEncoding.EncodeToString(image.Data)}})
			}
			w.Content = parts
		} else {
			w.Content = msg.Content
		}
		if deepSeekThinking(p, input) && msg.Role == "assistant" && len(msg.ToolCalls) > 0 {
			thinking := msg.Reasoning
			w.Reasoning = &thinking
		}
		for _, call := range msg.ToolCalls {
			w.ToolCalls = append(w.ToolCalls, wireCall{ID: call.ID, Type: "function", Function: wireFunction{Name: call.Name, Arguments: string(call.Arguments)}})
		}
		request.Messages = append(request.Messages, w)
	}
	return request, names, nil
}

func parseResponse(body []byte, names map[string]bool, choice string) (Response, error) {
	canonical, err := jsonvalue.Canonical(body)
	if err != nil {
		return Response{}, invalidResponse()
	}
	body = canonical
	// 仅接收明确的文本思考字段，不接收 debug、签名或错误正文。
	var wire struct {
		Choices []struct {
			Index   int `json:"index"`
			Message struct {
				Role      string          `json:"role"`
				Reasoning string          `json:"reasoning_content"`
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
			// DeepSeek 等供应商以扁平字段回报缓存命中，与 prompt_tokens_details.cached_tokens 同值。
			CacheHit *int `json:"prompt_cache_hit_tokens"`
		} `json:"usage"`
	}
	if !utf8.Valid(body) || json.Unmarshal(body, &wire) != nil || len(wire.Choices) != 1 || wire.Choices[0].Index != 0 {
		return Response{}, invalidResponse()
	}
	answer := wire.Choices[0]
	if answer.Message.Role != "assistant" || len(answer.Message.ToolCalls) > maxToolCalls {
		return Response{}, invalidResponse()
	}
	// 智谱以 sensitive 表示内容被安全审核拦截，与 content_filter 同义。
	if answer.FinishReason == "sensitive" {
		answer.FinishReason = "content_filter"
	}
	response := Response{FinishReason: answer.FinishReason, Reasoning: answer.Message.Reasoning}
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
	case "network_error":
		return Response{}, problem(502, "model-inference-failed", "模型推理异常，请重试")
	case "model_context_window_exceeded":
		return Response{}, problem(502, "model-context-exceeded", "请求超出模型上下文窗口")
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
		if response.Usage.CachedTokens == nil {
			response.Usage.CachedTokens = u.CacheHit
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
