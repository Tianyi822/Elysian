package model

import (
	"encoding/json"
	"testing"
)

func TestReasoningLevelEncodedForSelectedProtocol(t *testing.T) {
	for _, provider := range []string{ProviderDeepSeek, ProviderOpenAICompatible} {
		for _, format := range []string{FormatChatCompletions, FormatResponses, FormatAnthropicMessages} {
			for _, level := range []string{"", "disabled", "low", "high", "max"} {
				t.Run(provider+"/"+format+"/"+level, func(t *testing.T) {
					p, input := testProfile("https://model.example"), testRequest()
					p.Provider, p.APIFormat = provider, format
					p.Capabilities.ReasoningLevels = []string{"disabled", "low", "high", "max"}
					input.ReasoningLevel, input.OnReasoning = level, func(string) {}
					adapter, _ := resolveProtocol(format)
					prepared, err := adapter.prepare(p, input)
					if err != nil {
						t.Fatal(err)
					}
					var body struct {
						Effort       string              `json:"reasoning_effort"`
						Thinking     *wireThinking       `json:"thinking"`
						Reasoning    *responsesReasoning `json:"reasoning"`
						OutputConfig map[string]string   `json:"output_config"`
					}
					if err := json.Unmarshal(prepared.body, &body); err != nil {
						t.Fatal(err)
					}
					want := level
					if level == "disabled" {
						want = "none"
					}
					switch format {
					case FormatChatCompletions:
						if provider == ProviderDeepSeek {
							thinking := "enabled"
							if level == "disabled" {
								thinking, want = "disabled", ""
							}
							if body.Thinking == nil || body.Thinking.Type != thinking {
								t.Fatalf("思考开关错误：%s", prepared.body)
							}
						}
						if body.Effort != want {
							t.Fatalf("思考等级未发送：%s", prepared.body)
						}
					case FormatResponses:
						if body.Reasoning == nil || body.Reasoning.Effort != want {
							t.Fatalf("思考等级未发送：%s", prepared.body)
						}
						if level == "disabled" && body.Reasoning.Summary != "" {
							t.Fatal("关闭思考仍请求摘要")
						}
					case FormatAnthropicMessages:
						if level == "disabled" {
							if body.Thinking == nil || body.Thinking.Type != "disabled" || body.OutputConfig != nil {
								t.Fatalf("未关闭思考：%s", prepared.body)
							}
						} else if body.OutputConfig["effort"] != level {
							t.Fatalf("思考等级未发送：%s", prepared.body)
						}
						if provider == ProviderDeepSeek && level != "" && level != "disabled" && (body.Thinking == nil || body.Thinking.Type != "enabled") {
							t.Fatal("未启用 DeepSeek 思考")
						}
					}
				})
			}
		}
	}
}

func TestReasoningLevelMustBeDeclaredByModelRevision(t *testing.T) {
	p, input := testProfile("https://model.example"), testRequest()
	input.ReasoningLevel = "high"
	for _, format := range []string{FormatChatCompletions, FormatResponses, FormatAnthropicMessages} {
		p.APIFormat = format
		adapter, _ := resolveProtocol(format)
		_, err := adapter.prepare(p, input)
		requireCode(t, err, "unsupported-reasoning-level")
	}
}
