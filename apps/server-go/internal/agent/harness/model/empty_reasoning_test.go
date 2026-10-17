package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestDeepSeekEmptyThinkingContinuation(t *testing.T) {
	for _, format := range []string{FormatAnthropicMessages, FormatChatCompletions} {
		for _, stream := range []bool{false, true} {
			for _, level := range []string{"", "high", "disabled"} {
				p := testProfile("https://example.test")
				p.Provider, p.APIFormat = ProviderDeepSeek, format
				p.Capabilities.ReasoningLevels = []string{"high", "disabled"}
				r := testRequest()
				r.ReasoningLevel = level
				r.Tools, r.ToolChoice = testTools(), "auto"
				if stream {
					r.OnContent = func(string) {}
				}
				for _, id := range []string{"first", "second"} {
					r.Messages = append(r.Messages, Message{Role: "assistant", ToolCalls: []ToolCall{{ID: id, Name: "docker_containers_list", Arguments: json.RawMessage(`{}`)}}}, Message{Role: "tool", ToolCallID: id, Content: "完成"})
				}
				adapter, _ := resolveProtocol(format)
				prepared, err := adapter.prepare(p, r)
				if err != nil {
					t.Fatal(err)
				}
				field := `"thinking":""`
				if format == FormatChatCompletions {
					field = `"reasoning_content":""`
				}
				want := 2
				if level == "disabled" {
					want = 0
				}
				if strings.Count(string(prepared.body), field) != want {
					t.Fatalf("%s stream=%v level=%s: %s", format, stream, level, prepared.body)
				}
				p.Provider = ProviderOpenAICompatible
				prepared, err = adapter.prepare(p, r)
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(prepared.body), field) {
					t.Fatal("向其他供应商发送了 DeepSeek 续接字段")
				}
			}
		}
	}
}
