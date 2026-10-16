package harness

import (
	"encoding/json"
	"math"

	"elysian/server/internal/agent/harness/model"
)

const contextImageTokens = 1024

// ASCII 约四字一 token，其他 Unicode 约一字一 token。仅用于组成展示，
// 既有准入预算仍由 estimateRequest 的保守字节估算负责。
func estimateContextText(text string) int {
	ascii, other := 0, 0
	for _, r := range text {
		if r < 128 {
			ascii++
		} else {
			other++
		}
	}
	return (ascii+3)/4 + other
}

func addContextBreakdown(dst *model.ContextBreakdown, src model.ContextBreakdown) {
	dst.Messages += src.Messages
	dst.SystemTools += src.SystemTools
	dst.Other += src.Other
	dst.Skills += src.Skills
	dst.SystemPrompt += src.SystemPrompt
	dst.MCPTools += src.MCPTools
}

func otherContextMessage(role, text string) model.Message {
	return model.Message{Role: role, Content: text, EstimatedBreakdown: &model.ContextBreakdown{Other: estimateContextText(text)}}
}

func skillContextMessage(role, prefix, text string) model.Message {
	return model.Message{Role: role, Content: prefix + text, EstimatedBreakdown: &model.ContextBreakdown{Other: estimateContextText(prefix), Skills: estimateContextText(text)}}
}

func estimateContextToolCalls(calls []model.ToolCall) int {
	if len(calls) == 0 {
		return 0
	}
	b, _ := json.Marshal(calls)
	return estimateContextText(string(b))
}

// 只汇总本次最终保留的消息和可见工具；来源标记随消息一起被裁剪。
func estimateFittedContext(request model.Request, snapshot *CapabilitySnapshot) *model.ContextBreakdown {
	out := &model.ContextBreakdown{Other: 2 + estimateContextText(request.ToolChoice)}
	for _, message := range request.Messages {
		if message.EstimatedBreakdown != nil {
			addContextBreakdown(out, *message.EstimatedBreakdown)
		} else if message.Role == "system" {
			out.SystemPrompt += estimateContextText(message.Content)
		} else {
			out.Messages += estimateContextText(message.Content)
		}
		out.Messages += estimateContextText(message.Reasoning) + estimateContextToolCalls(message.ToolCalls) + contextImageTokens*len(message.Images)
		out.Other += 4 + estimateContextText(message.ToolCallID)
	}
	sources := map[string]string{}
	if snapshot != nil {
		for _, capability := range snapshot.Tools {
			sources[capability.Name] = capability.Source
		}
	}
	for _, tool := range request.Tools {
		tokens := estimateContextText(tool.Name) + estimateContextText(tool.Description) + estimateContextText(string(tool.Parameters))
		switch sources[tool.Name] {
		case "mcp-tool", "mcp-resource", "mcp-prompt":
			out.MCPTools += tokens
		default:
			out.SystemTools += tokens
		}
		out.Other += 8
	}
	return out
}

// 输出也用同一本地文本算法估算，避免将供应商实测输出与本地输入权重混用。
func projectContextBreakdown(record ModelRequestRecord) *model.ContextBreakdown {
	if record.EstimatedBreakdown == nil {
		return nil
	}
	out := *record.EstimatedBreakdown
	const maxSafe int64 = 1<<53 - 1
	total := int64(0)
	for _, count := range []int{out.Messages, out.SystemTools, out.Other, out.Skills, out.SystemPrompt, out.MCPTools} {
		if count < 0 || int64(count) > maxSafe-total {
			return nil
		}
		total += int64(count)
	}
	if record.Response != nil {
		response := record.Response
		output := estimateContextText(response.Content) + estimateContextText(response.Reasoning) + estimateContextToolCalls(response.ToolCalls)
		if out.Messages > math.MaxInt-output || total > maxSafe-int64(output) {
			return nil
		}
		out.Messages += output
	}
	return &out
}
