package model

import (
	"elysian/server/internal/agent/jsonvalue"
	"encoding/json"
	"math"
)

type anthropicBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   *string         `json:"content,omitempty"`
}
type anthropicMessage struct {
	Role    string           `json:"role"`
	Content []anthropicBlock `json:"content"`
}
type anthropicTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema"`
}
type anthropicRequest struct {
	Model      string             `json:"model"`
	MaxTokens  int                `json:"max_tokens"`
	System     []anthropicBlock   `json:"system,omitempty"`
	Messages   []anthropicMessage `json:"messages"`
	Tools      []anthropicTool    `json:"tools,omitempty"`
	ToolChoice any                `json:"tool_choice,omitempty"`
	Thinking   wireThinking       `json:"thinking"`
	Stream     bool               `json:"stream"`
}

func (anthropicMessagesProtocol) prepare(p Profile, input Request) (preparedRequest, error) {
	names, err := validateRequest(p, input)
	if err != nil {
		return preparedRequest{}, err
	}
	wire := anthropicRequest{Model: p.Model, MaxTokens: input.MaxTokens, Messages: []anthropicMessage{}, Thinking: wireThinking{Type: "disabled"}}
	for _, t := range input.Tools {
		wire.Tools = append(wire.Tools, anthropicTool{Name: t.Name, Description: t.Description, InputSchema: t.Parameters})
	}
	for _, m := range input.Messages {
		if m.Role == "system" {
			if m.Content != "" {
				wire.System = append(wire.System, anthropicBlock{Type: "text", Text: m.Content})
			}
			continue
		}
		role := m.Role
		blocks := []anthropicBlock{}
		if role == "tool" {
			role = "user"
			content := m.Content
			blocks = append(blocks, anthropicBlock{Type: "tool_result", ToolUseID: m.ToolCallID, Content: &content})
		} else {
			if m.Content != "" {
				blocks = append(blocks, anthropicBlock{Type: "text", Text: m.Content})
			}
			for _, call := range m.ToolCalls {
				blocks = append(blocks, anthropicBlock{Type: "tool_use", ID: call.ID, Name: call.Name, Input: call.Arguments})
			}
		}
		if len(blocks) == 0 {
			return preparedRequest{}, invalidRequest()
		}
		// Anthropic 的相邻同角色消息合并；同一批 tool_result 保持原顺序。
		last := len(wire.Messages) - 1
		if last >= 0 && wire.Messages[last].Role == role {
			wire.Messages[last].Content = append(wire.Messages[last].Content, blocks...)
		} else {
			wire.Messages = append(wire.Messages, anthropicMessage{Role: role, Content: blocks})
		}
	}
	if len(wire.Messages) == 0 {
		return preparedRequest{}, invalidRequest()
	}
	switch input.ToolChoice {
	case "":
	case "auto", "none":
		wire.ToolChoice = map[string]string{"type": input.ToolChoice}
	case "required":
		wire.ToolChoice = map[string]string{"type": "any"}
	default:
		wire.ToolChoice = map[string]string{"type": "tool", "name": input.ToolChoice}
	}
	return prepareWire(p, "/v1/messages", wire, true, func(body []byte) (Response, error) { return parseAnthropicResponse(body, names, input.ToolChoice) })
}

func parseAnthropicResponse(body []byte, names map[string]bool, choice string) (Response, error) {
	canonical, err := jsonvalue.Canonical(body)
	if err != nil {
		return Response{}, invalidResponse()
	}
	var wire struct {
		Type       string           `json:"type"`
		Role       string           `json:"role"`
		Content    []anthropicBlock `json:"content"`
		StopReason string           `json:"stop_reason"`
		Usage      *struct {
			Input         *int `json:"input_tokens"`
			Output        *int `json:"output_tokens"`
			CacheRead     *int `json:"cache_read_input_tokens"`
			CacheCreation *int `json:"cache_creation_input_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(canonical, &wire) != nil || wire.Type != "message" || wire.Role != "assistant" {
		return Response{}, invalidResponse()
	}
	response := Response{}
	for _, block := range wire.Content {
		switch block.Type {
		case "text":
			response.Content += block.Text
		case "tool_use":
			response.ToolCalls = append(response.ToolCalls, ToolCall{ID: block.ID, Name: block.Name, Arguments: block.Input})
		case "thinking", "redacted_thinking": // 不返回或持久化私有推理。
		default:
			return Response{}, invalidResponse()
		}
	}
	switch wire.StopReason {
	case "end_turn", "stop_sequence":
		response.FinishReason = "stop"
	case "tool_use":
		response.FinishReason = "tool_calls"
	case "max_tokens":
		response.FinishReason = "length"
	case "refusal":
		response.FinishReason = "content_filter"
	default:
		return Response{}, invalidResponse()
	}
	if wire.Usage != nil {
		u := wire.Usage
		for _, n := range []*int{u.Input, u.Output, u.CacheRead, u.CacheCreation} {
			if n != nil && *n < 0 {
				return Response{}, invalidResponse()
			}
		}
		response.Usage.CompletionTokens = u.Output
		response.Usage.CachedTokens = u.CacheRead
		if u.Input != nil {
			total := *u.Input
			for _, n := range []*int{u.CacheRead, u.CacheCreation} {
				if n != nil {
					if *n > math.MaxInt-total {
						return Response{}, invalidResponse()
					}
					total += *n
				}
			}
			response.Usage.PromptTokens = &total
			if u.Output != nil {
				if *u.Output > math.MaxInt-total {
					return Response{}, invalidResponse()
				}
				sum := total + *u.Output
				response.Usage.TotalTokens = &sum
			}
		}
	}
	return validateResponse(response, names, choice)
}
