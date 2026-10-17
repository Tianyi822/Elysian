package model

import (
	"elysian/server/internal/agent/jsonvalue"
	"encoding/base64"
	"encoding/json"
	"math"
)

type anthropicBlock struct {
	Thinking     *string                `json:"thinking,omitempty"`
	Type         string                 `json:"type"`
	Text         string                 `json:"text,omitempty"`
	ID           string                 `json:"id,omitempty"`
	Name         string                 `json:"name,omitempty"`
	Input        json.RawMessage        `json:"input,omitempty"`
	ToolUseID    string                 `json:"tool_use_id,omitempty"`
	Content      *string                `json:"content,omitempty"`
	Source       *anthropicImage        `json:"source,omitempty"`
	CacheControl *anthropicCacheControl `json:"cache_control,omitempty"`
}

type anthropicCacheControl struct {
	Type string `json:"type"`
}

// anthropicImage 对齐 Anthropic source 对象：裸 base64 加显式 media_type。
type anthropicImage struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}
type anthropicMessage struct {
	Role    string           `json:"role"`
	Content []anthropicBlock `json:"content"`
}
type anthropicTool struct {
	Name         string                 `json:"name"`
	Description  string                 `json:"description,omitempty"`
	InputSchema  json.RawMessage        `json:"input_schema"`
	CacheControl *anthropicCacheControl `json:"cache_control,omitempty"`
}
type anthropicRequest struct {
	OutputConfig map[string]string  `json:"output_config,omitempty"`
	Model        string             `json:"model"`
	MaxTokens    int                `json:"max_tokens"`
	System       []anthropicBlock   `json:"system,omitempty"`
	Messages     []anthropicMessage `json:"messages"`
	Tools        []anthropicTool    `json:"tools,omitempty"`
	ToolChoice   any                `json:"tool_choice,omitempty"`
	Thinking     *wireThinking      `json:"thinking,omitempty"`
	Stream       bool               `json:"stream"`
}

func (anthropicMessagesProtocol) prepare(p Profile, input Request) (preparedRequest, error) {
	names, err := validateRequest(p, input)
	if err != nil {
		return preparedRequest{}, err
	}
	wire := anthropicRequest{Stream: input.OnReasoning != nil || input.OnContent != nil, Model: p.Model, MaxTokens: input.MaxTokens, Messages: []anthropicMessage{}, Thinking: &wireThinking{Type: "disabled"}}
	if input.OnReasoning != nil && (input.ToolChoice == "" || input.ToolChoice == "auto" || input.ToolChoice == "none") {
		wire.Thinking = nil // 生成期间沿用服务默认，不指定供应商专属预算或等级。
	}
	if input.ReasoningLevel != "" {
		if ReasoningEffort(input.ReasoningLevel) == "none" {
			wire.Thinking = &wireThinking{Type: "disabled"}
		} else {
			wire.OutputConfig = map[string]string{"effort": input.ReasoningLevel}
			wire.Thinking = nil
			if p.Provider == ProviderDeepSeek {
				wire.Thinking = &wireThinking{Type: "enabled"}
			}
		}
	}
	if p.Provider == ProviderDeepSeek {
		wire.Thinking = &wireThinking{Type: "disabled"}
		if deepSeekThinking(p, input) {
			wire.Thinking.Type = "enabled"
		}
	}
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
			if deepSeekThinking(p, input) && m.Role == "assistant" && len(m.ToolCalls) > 0 {
				thinking := m.Reasoning
				blocks = append(blocks, anthropicBlock{Type: "thinking", Thinking: &thinking})
			}
			if m.Content != "" {
				blocks = append(blocks, anthropicBlock{Type: "text", Text: m.Content})
			}
			for _, image := range m.Images {
				blocks = append(blocks, anthropicBlock{Type: "image", Source: &anthropicImage{Type: "base64", MediaType: image.MimeType, Data: base64.StdEncoding.EncodeToString(image.Data)}})
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
	// 合并后再定位缓存前缀，保留最后一条变化中的消息不打断点。
	if len(wire.System) > 0 {
		wire.System[len(wire.System)-1].CacheControl = &anthropicCacheControl{Type: "ephemeral"}
	}
	if len(wire.Tools) > 0 {
		wire.Tools[len(wire.Tools)-1].CacheControl = &anthropicCacheControl{Type: "ephemeral"}
	}
	if len(wire.Messages) >= 2 {
		message := &wire.Messages[len(wire.Messages)-2]
		message.Content[len(message.Content)-1].CacheControl = &anthropicCacheControl{Type: "ephemeral"}
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
		case "thinking":
			if block.Thinking != nil {
				response.Reasoning += *block.Thinking
			}
		case "redacted_thinking": // 不显示删节或加密内容。
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
