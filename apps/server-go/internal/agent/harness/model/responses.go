package model

import (
	"elysian/server/internal/agent/jsonvalue"
	"encoding/base64"
	"encoding/json"
)

type responseInputItem struct {
	Type      string  `json:"type"`
	Role      string  `json:"role,omitempty"`
	Content   any     `json:"content,omitempty"`
	CallID    string  `json:"call_id,omitempty"`
	Name      string  `json:"name,omitempty"`
	Arguments string  `json:"arguments,omitempty"`
	Output    *string `json:"output,omitempty"`
}

// responseContentPart 是带图 user 消息的 content 数组成员，按 OpenAI Responses 规格命名。
type responseContentPart struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	ImageURL string `json:"image_url,omitempty"`
}
type responseTool struct {
	Type        string          `json:"type"`
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters"`
	Strict      bool            `json:"strict"`
}
type responsesReasoning struct {
	Effort  string `json:"effort,omitempty"`
	Summary string `json:"summary,omitempty"`
}

type responsesRequest struct {
	Model           string              `json:"model"`
	Input           []responseInputItem `json:"input"`
	Tools           []responseTool      `json:"tools,omitempty"`
	MaxOutputTokens int                 `json:"max_output_tokens"`
	ToolChoice      any                 `json:"tool_choice,omitempty"`
	Reasoning       *responsesReasoning `json:"reasoning,omitempty"`
	Store           bool                `json:"store"`
	Stream          bool                `json:"stream"`
}

func (responsesProtocol) prepare(p Profile, input Request) (preparedRequest, error) {
	names, err := validateRequest(p, input)
	if err != nil {
		return preparedRequest{}, err
	}
	wire := responsesRequest{Stream: input.OnReasoning != nil || input.OnContent != nil, Model: p.Model, Input: []responseInputItem{}, MaxOutputTokens: input.MaxTokens}
	if p.Provider == ProviderDeepSeek {
		wire.Reasoning = &responsesReasoning{Effort: "none"}
	}
	if input.OnReasoning != nil && len(p.Capabilities.ReasoningLevels) > 0 {
		wire.Reasoning = &responsesReasoning{Summary: "auto"}
	}
	if input.ReasoningLevel != "" {
		wire.Reasoning = &responsesReasoning{Effort: ReasoningEffort(input.ReasoningLevel)}
		if input.OnReasoning != nil && wire.Reasoning.Effort != "none" {
			wire.Reasoning.Summary = "auto"
		}
	}
	for _, t := range input.Tools {
		wire.Tools = append(wire.Tools, responseTool{Type: "function", Name: t.Name, Description: t.Description, Parameters: t.Parameters, Strict: false})
	}
	for _, m := range input.Messages {
		if m.Role == "tool" {
			output := m.Content
			wire.Input = append(wire.Input, responseInputItem{Type: "function_call_output", CallID: m.ToolCallID, Output: &output})
			continue
		}
		if m.Content != "" || len(m.ToolCalls) == 0 {
			if len(m.Images) > 0 {
				parts := make([]responseContentPart, 0, len(m.Images)+1)
				if m.Content != "" {
					parts = append(parts, responseContentPart{Type: "input_text", Text: m.Content})
				}
				for _, image := range m.Images {
					parts = append(parts, responseContentPart{Type: "input_image", ImageURL: "data:" + image.MimeType + ";base64," + base64.StdEncoding.EncodeToString(image.Data)})
				}
				wire.Input = append(wire.Input, responseInputItem{Type: "message", Role: m.Role, Content: parts})
			} else {
				content := m.Content
				wire.Input = append(wire.Input, responseInputItem{Type: "message", Role: m.Role, Content: content})
			}
		}
		for _, call := range m.ToolCalls {
			wire.Input = append(wire.Input, responseInputItem{Type: "function_call", CallID: call.ID, Name: call.Name, Arguments: string(call.Arguments)})
		}
	}
	switch input.ToolChoice {
	case "":
	case "auto", "none", "required":
		wire.ToolChoice = input.ToolChoice
	default:
		wire.ToolChoice = map[string]string{"type": "function", "name": input.ToolChoice}
	}
	return prepareWire(p, "/responses", wire, false, func(body []byte) (Response, error) { return parseResponsesResponse(body, names, input.ToolChoice) })
}

func parseResponsesResponse(body []byte, names map[string]bool, choice string) (Response, error) {
	canonical, err := jsonvalue.Canonical(body)
	if err != nil {
		return Response{}, invalidResponse()
	}
	var wire struct {
		Object     string          `json:"object"`
		Status     string          `json:"status"`
		Error      json.RawMessage `json:"error"`
		Incomplete *struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
		Output []struct {
			Type      string `json:"type"`
			Role      string `json:"role"`
			Status    string `json:"status"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
			Summary   []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"summary"`
			Content []struct {
				Type    string `json:"type"`
				Text    string `json:"text"`
				Refusal string `json:"refusal"`
			} `json:"content"`
		} `json:"output"`
		Usage *struct {
			Input        *int `json:"input_tokens"`
			Output       *int `json:"output_tokens"`
			Total        *int `json:"total_tokens"`
			InputDetails *struct {
				Cached *int `json:"cached_tokens"`
			} `json:"input_tokens_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(canonical, &wire) != nil || wire.Object != "response" || (len(wire.Error) > 0 && string(wire.Error) != "null") {
		return Response{}, invalidResponse()
	}
	response := Response{FinishReason: "stop"}
	for _, item := range wire.Output {
		switch item.Type {
		case "reasoning": // 只使用供应商公开摘要；不读取加密内容。
			for _, part := range item.Summary {
				if part.Type == "summary_text" {
					if response.Reasoning != "" {
						response.Reasoning += "\n"
					}
					response.Reasoning += part.Text
				}
			}
		case "message":
			if item.Role != "assistant" || (item.Status != "" && item.Status != "completed" && item.Status != "incomplete") {
				return Response{}, invalidResponse()
			}
			for _, block := range item.Content {
				switch block.Type {
				case "output_text":
					response.Content += block.Text
				case "refusal":
					response.Content += block.Refusal
					response.FinishReason = "content_filter"
				default:
					return Response{}, invalidResponse()
				}
			}
		case "function_call":
			if item.Status != "" && item.Status != "completed" {
				return Response{}, invalidResponse()
			}
			response.ToolCalls = append(response.ToolCalls, ToolCall{ID: item.CallID, Name: item.Name, Arguments: json.RawMessage(item.Arguments)})
		default:
			return Response{}, invalidResponse()
		}
	}
	switch wire.Status {
	case "completed":
		if len(response.ToolCalls) > 0 {
			if response.FinishReason == "content_filter" {
				return Response{}, invalidResponse()
			}
			response.FinishReason = "tool_calls"
		}
	case "incomplete":
		if wire.Incomplete == nil {
			return Response{}, invalidResponse()
		}
		switch wire.Incomplete.Reason {
		case "max_output_tokens":
			response.FinishReason = "length"
		case "content_filter":
			response.FinishReason = "content_filter"
		default:
			return Response{}, invalidResponse()
		}
	default:
		return Response{}, invalidResponse()
	}
	if wire.Usage != nil {
		u := wire.Usage
		response.Usage = Usage{PromptTokens: u.Input, CompletionTokens: u.Output, TotalTokens: u.Total}
		if u.InputDetails != nil {
			response.Usage.CachedTokens = u.InputDetails.Cached
		}
	}
	return validateResponse(response, names, choice)
}
