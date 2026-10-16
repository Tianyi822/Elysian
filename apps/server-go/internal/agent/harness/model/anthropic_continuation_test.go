package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAnthropicDeepSeekToolContinuationReplaysThinking(t *testing.T) {
	for _, test := range []struct {
		name     string
		provider string
		stream   bool
		replay   bool
	}{
		{"DeepSeek 工具续轮", ProviderDeepSeek, true, true},
		{"通用 Messages", ProviderOpenAICompatible, true, false},
		{"非生成请求", ProviderDeepSeek, false, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := testProfile("https://example.test/anthropic")
			profile.Provider, profile.APIFormat = test.provider, FormatAnthropicMessages
			request := testRequest()
			request.Tools, request.ToolChoice = testTools(), "auto"
			if test.stream {
				request.OnReasoning = func(string) {}
			}
			request.Messages = append(request.Messages,
				Message{Role: "assistant", Reasoning: "当前工具轮次的思考", ToolCalls: []ToolCall{{ID: "c1", Name: "docker_containers_list", Arguments: json.RawMessage(`{}`)}}},
				Message{Role: "tool", ToolCallID: "c1", Content: "完成"},
			)
			prepared, err := (anthropicMessagesProtocol{}).prepare(profile, request)
			if err != nil {
				t.Fatal(err)
			}
			var body anthropicRequest
			if err := json.Unmarshal(prepared.body, &body); err != nil || len(body.Messages) != 3 {
				t.Fatalf("续轮消息无效：%s %v", prepared.body, err)
			}
			blocks := body.Messages[1].Content
			if test.replay {
				if len(blocks) != 2 || blocks[0].Type != "thinking" || blocks[0].Thinking != "当前工具轮次的思考" {
					t.Fatalf("tool_use 前缺少已确认思考：%+v", blocks)
				}
				blocks = blocks[1:]
			} else if strings.Contains(string(prepared.body), "当前工具轮次的思考") {
				t.Fatal("供应商思考被转发给其他服务或非生成请求")
			}
			if len(blocks) != 1 || blocks[0].Type != "tool_use" || blocks[0].ID != "c1" || body.Messages[2].Content[0].ToolUseID != "c1" {
				t.Fatal("工具与结果关联丢失")
			}
			if strings.Contains(string(prepared.body), `"signature"`) || strings.Contains(string(prepared.body), `"reasoning_content"`) {
				t.Fatal("Messages 续轮不应伪造签名或使用 Chat 字段")
			}
		})
	}
}
