package model

import (
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
	Thinking   *wireThinking `json:"thinking,omitempty"`
	Model      string        `json:"model"`
	Messages   []wireMessage `json:"messages"`
	Tools      []wireTool    `json:"tools,omitempty"`
	MaxTokens  int           `json:"max_tokens"`
	ToolChoice any           `json:"tool_choice,omitempty"`
	Stream     bool          `json:"stream"`
}

type wireThinking struct {
	Type string `json:"type"`
}

func prepareRequest(p Profile, input Request) (wireRequest, map[string]bool, error) {
	names, err := validateRequest(p, input)
	if err != nil {
		return wireRequest{}, nil, err
	}
	request := wireRequest{Model: p.Model, MaxTokens: input.MaxTokens, Messages: make([]wireMessage, 0, len(input.Messages))}
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
		w := wireMessage{Role: msg.Role, Content: msg.Content, ToolCallID: msg.ToolCallID}
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
