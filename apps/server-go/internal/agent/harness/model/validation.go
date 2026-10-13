package model

import (
	"elysian/server/internal/agent/jsonvalue"
	"encoding/json"
	"regexp"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxToolCalls = 64

var functionName = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// 空值保留默认；显式值只能使用本轮固定模型修订声明的档位。
func ValidateReasoningLevel(p Profile, level string) error {
	if level != "" && !slices.Contains(p.Capabilities.ReasoningLevels, level) {
		return problem(400, "unsupported-reasoning-level", "当前模型不支持所选思考等级，请重新选择")
	}
	return nil
}

func reasoningEffort(level string) string {
	if level == "disabled" {
		return "none"
	}
	return level
}

func validateRequest(p Profile, input Request) (map[string]bool, error) {
	if err := ValidateReasoningLevel(p, input.ReasoningLevel); err != nil {
		return nil, err
	}
	if !p.Capabilities.Text || (len(input.Tools) > 0 && !p.Capabilities.Tools) {
		return nil, problem(400, "model-capability-unavailable", "所选模型不支持本次请求需要的能力")
	}
	if len(input.Messages) == 0 || input.MaxTokens < 1 || input.MaxTokens > p.OutputTokens || len(input.Tools) > maxToolCalls {
		return nil, invalidRequest()
	}
	names := make(map[string]bool)
	for _, t := range input.Tools {
		if !functionName.MatchString(t.Name) || names[t.Name] || !objectJSON(t.Parameters) || !utf8.ValidString(t.Description) {
			return nil, invalidRequest()
		}
		var schema struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(t.Parameters, &schema) != nil || schema.Type != "object" {
			return nil, invalidRequest()
		}
		names[t.Name] = true
	}
	switch input.ToolChoice {
	case "":
	case "none":
	case "auto", "required":
		if len(names) == 0 {
			return nil, invalidRequest()
		}
	default:
		if !names[input.ToolChoice] {
			return nil, invalidRequest()
		}
	}
	pending, seen := make(map[string]bool), make(map[string]bool)
	for _, msg := range input.Messages {
		if !utf8.ValidString(msg.Content) || !utf8.ValidString(msg.Reasoning) || len(msg.ToolCalls) > maxToolCalls {
			return nil, invalidRequest()
		}
		if msg.Role != "tool" && len(pending) > 0 {
			return nil, problem(400, "incomplete-tool-history", "模型上下文包含未完成的工具调用")
		}
		switch msg.Role {
		case "system", "user":
			if len(msg.ToolCalls) != 0 || msg.ToolCallID != "" {
				return nil, invalidRequest()
			}
		case "assistant":
			if msg.ToolCallID != "" {
				return nil, invalidRequest()
			}
			for _, call := range msg.ToolCalls {
				if !validCallID(call.ID) || seen[call.ID] || !functionName.MatchString(call.Name) || !objectJSON(call.Arguments) {
					return nil, invalidRequest()
				}
				seen[call.ID], pending[call.ID] = true, true
			}
		case "tool":
			if !pending[msg.ToolCallID] || len(msg.ToolCalls) != 0 {
				return nil, invalidRequest()
			}
			delete(pending, msg.ToolCallID)
		default:
			return nil, invalidRequest()
		}
	}
	if len(pending) > 0 {
		return nil, problem(400, "incomplete-tool-history", "模型上下文包含未完成的工具调用")
	}
	return names, nil
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

// 所有协议都经同一公开响应校验，保证精确 JSON 参数及强制函数语义。
func validateResponse(response Response, names map[string]bool, choice string) (Response, error) {
	if !utf8.ValidString(response.Content) || !utf8.ValidString(response.Reasoning) || len(response.ToolCalls) > maxToolCalls {
		return Response{}, invalidResponse()
	}
	switch response.FinishReason {
	case "stop", "length", "content_filter":
		if len(response.ToolCalls) > 0 {
			return Response{}, invalidResponse()
		}
	case "tool_calls":
		if len(response.ToolCalls) == 0 || choice == "none" {
			return Response{}, invalidResponse()
		}
	default:
		return Response{}, invalidResponse()
	}
	if response.FinishReason == "stop" && choice != "" && choice != "auto" && choice != "none" {
		return Response{}, invalidResponse()
	}
	seen := map[string]bool{}
	for i, call := range response.ToolCalls {
		if !validCallID(call.ID) || seen[call.ID] || !names[call.Name] || !objectJSON(call.Arguments) {
			return Response{}, invalidResponse()
		}
		if choice != "" && choice != "auto" && choice != "required" && choice != call.Name {
			return Response{}, invalidResponse()
		}
		seen[call.ID] = true
		arguments, err := jsonvalue.Canonical(call.Arguments)
		if err != nil {
			return Response{}, invalidResponse()
		}
		response.ToolCalls[i].Arguments = arguments
	}
	for _, count := range []*int{response.Usage.PromptTokens, response.Usage.CompletionTokens, response.Usage.TotalTokens, response.Usage.CachedTokens} {
		if count != nil && *count < 0 {
			return Response{}, invalidResponse()
		}
	}
	if response.Usage.PromptTokens != nil && response.Usage.CachedTokens != nil && *response.Usage.CachedTokens > *response.Usage.PromptTokens {
		return Response{}, invalidResponse()
	}
	return response, nil
}
