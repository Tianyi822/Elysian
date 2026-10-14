package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

// 单次输出上限按思考模式取官方默认：非思考 8K、思考 64K、max 档 128K；
// 未声明思考档位的模型按非思考取值，运行限额与模型声明的最大输出只能收紧；
// 整理请求（固定函数调用、不启用思考）按非思考取值。
func TestAgentOutputLimitFollowsThinkingMode(t *testing.T) {
	type captured struct {
		level  string
		limit  int
		memory bool
	}
	levels := []string{"disabled", "low", "high", "max"}
	cases := []struct {
		name      string
		level     string
		levels    []string
		provider  string
		output    int
		runLimit  int
		wantLimit int
	}{
		{name: "默认档按思考 64K", level: "", levels: levels, provider: model.ProviderDeepSeek, output: 393216, wantLimit: outputTokensThinking},
		{name: "明确思考档同样 64K", level: "high", levels: levels, provider: model.ProviderDeepSeek, output: 393216, wantLimit: outputTokensThinking},
		{name: "非思考档 8K", level: "disabled", levels: levels, provider: model.ProviderDeepSeek, output: 393216, wantLimit: outputTokensNonThinking},
		{name: "max 档 128K", level: "max", levels: levels, provider: model.ProviderDeepSeek, output: 393216, wantLimit: outputTokensMaxEffort},
		{name: "DeepSeek 未声明档位仍按思考 64K", level: "", levels: nil, provider: model.ProviderDeepSeek, output: 393216, wantLimit: outputTokensThinking},
		{name: "未声明思考档位的其他模型按非思考", level: "", levels: nil, provider: model.ProviderOpenAICompatible, output: 65536, wantLimit: outputTokensNonThinking},
		{name: "模型声明的最大输出收紧", level: "high", levels: levels, provider: model.ProviderDeepSeek, output: 4096, wantLimit: 4096},
		{name: "运行限额收紧", level: "high", levels: levels, provider: model.ProviderDeepSeek, output: 393216, runLimit: 8192, wantLimit: 8192},
	}
	for index, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var calls atomic.Int32
			seen := []captured{}
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
				mu.Lock()
				seen = append(seen, captured{level: r.ReasoningLevel, limit: r.MaxTokens, memory: r.ToolChoice == "store_working_memory"})
				mu.Unlock()
				if r.ToolChoice == "store_working_memory" {
					return memoryReply(r), nil
				}
				if calls.Add(1) == 1 {
					return toolReply("docker_containers_list"), nil
				}
				return finalReply("完成"), nil
			}, func(d *Deps) {
				if tc.runLimit > 0 {
					d.AgentLimits.OutputTokens = tc.runLimit
				}
			})
			ctx := context.Background()
			credential := "test-only-key"
			profile, err := m.CreateModelProfile(model.Input{Provider: tc.provider, APIFormat: model.FormatChatCompletions, BaseURL: "http://127.0.0.1:9", Model: "test", ContextTokens: 1048576, OutputTokens: tc.output, Capabilities: model.Capabilities{Text: true, Tools: true, ReasoningLevels: tc.levels, Source: "test"}, Active: true, Credential: &credential})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = m.SwitchSessionModel(ctx, session.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
				t.Fatal(err)
			}
			run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: fmt.Sprintf("output-limit-%d", index), Content: "检查状态", ReasoningLevel: tc.level})
			if err != nil {
				t.Fatal(err)
			}
			if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
				t.Fatalf("运行未成功：%+v", got)
			}
			wantMemory := outputTokensNonThinking
			if tc.output < wantMemory {
				wantMemory = tc.output
			}
			if tc.runLimit > 0 && tc.runLimit < wantMemory {
				wantMemory = tc.runLimit
			}
			mu.Lock()
			defer mu.Unlock()
			inference, memory := 0, 0
			for _, item := range seen {
				if item.memory {
					memory++
					if item.limit != wantMemory {
						t.Errorf("整理请求上限 %d，期望 %d", item.limit, wantMemory)
					}
					continue
				}
				inference++
				if item.limit != tc.wantLimit || item.level != tc.level {
					t.Errorf("推理请求上限 %d（等级 %q），期望 %d（等级 %q）", item.limit, item.level, tc.wantLimit, tc.level)
				}
			}
			if inference == 0 || memory == 0 {
				t.Fatalf("未观察到推理与整理请求：%+v", seen)
			}
		})
	}
}

// max 档在真实协议报文里带官方 128K 上限与 max 强度（生产走 Anthropic 兼容协议）；
// 同轮整理请求保持非思考 8K，两者都不受模型声明的 384K 干扰。
func TestAgentMaxEffortWireCarriesOfficialLimit(t *testing.T) {
	type wireCall struct {
		maxToken int
		effort   string
		thinking string
	}
	calls := make(chan wireCall, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body struct {
			MaxTokens    int               `json:"max_tokens"`
			OutputConfig map[string]string `json:"output_config"`
			Thinking     map[string]string `json:"thinking"`
		}
		if json.Unmarshal(raw, &body) != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		call := wireCall{maxToken: body.MaxTokens, thinking: body.Thinking["type"]}
		if body.OutputConfig != nil {
			call.effort = body.OutputConfig["effort"]
		}
		calls <- call
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(raw), "store_working_memory") {
			revision := 0
			if match := revisionInPrompt.FindStringSubmatch(string(raw)); len(match) == 2 {
				revision, _ = strconv.Atoi(match[1])
			}
			args, _ := json.Marshal(memoryProposal{ExpectedRevision: revision, Constraints: []string{}, Facts: []MemoryFact{}, Todos: []string{}, OpenQuestions: []string{}, Summary: "已完成本轮分析"})
			_ = json.NewEncoder(w).Encode(map[string]any{"type": "message", "role": "assistant",
				"content":     []any{map[string]any{"type": "tool_use", "id": "memory", "name": "store_working_memory", "input": json.RawMessage(args)}},
				"stop_reason": "tool_use", "usage": map[string]any{"input_tokens": 10, "output_tokens": 5}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"type": "message", "role": "assistant",
			"content":     []any{map[string]any{"type": "text", "text": "完成"}},
			"stop_reason": "end_turn", "usage": map[string]any{"input_tokens": 10, "output_tokens": 5}})
	}))
	defer server.Close()
	credential := "test-only-key"
	m, session, _ := agentManager(t, nil, func(d *Deps) { d.ModelClient = model.NewClient(server.Client()) })
	profile, err := m.CreateModelProfile(model.Input{Provider: model.ProviderDeepSeek, APIFormat: model.FormatAnthropicMessages, BaseURL: server.URL, Model: "deepseek-flash", ContextTokens: 1048576, OutputTokens: 393216, Capabilities: model.Capabilities{Text: true, Tools: true, ReasoningLevels: []string{"disabled", "low", "high", "max"}, Source: "test"}, Active: true, Credential: &credential})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err = m.SwitchSessionModel(ctx, session.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "max-effort-wire", Content: "用 rust 写一个贪吃蛇", ReasoningLevel: "max"})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
		t.Fatalf("运行未成功：%+v", got)
	}
	close(calls)
	inference, memory := 0, 0
	for call := range calls {
		if call.thinking == "disabled" {
			memory++
			if call.maxToken != outputTokensNonThinking {
				t.Errorf("整理请求 max_tokens %d，期望 %d", call.maxToken, outputTokensNonThinking)
			}
			continue
		}
		inference++
		if call.maxToken != outputTokensMaxEffort || call.effort != "max" || call.thinking != "enabled" {
			t.Errorf("max 档请求未带官方上限：%+v", call)
		}
	}
	if inference != 1 || memory != 1 {
		t.Fatalf("请求次数不符：推理 %d 整理 %d", inference, memory)
	}
}

// 校验后的响应上限（2 MiB）覆盖长回答正文：超过旧 512 KiB 上限的答复必须落库成功。
func TestAgentAcceptsLargeAnswerWithinResponseBytes(t *testing.T) {
	answer := strings.Repeat("这是一段较长的回答内容。", 30000)
	if len(answer) <= 524288 {
		t.Fatalf("测试正文未超过旧上限：%d", len(answer))
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(raw), "store_working_memory") {
			revision := 0
			if match := revisionInPrompt.FindStringSubmatch(string(raw)); len(match) == 2 {
				revision, _ = strconv.Atoi(match[1])
			}
			args, _ := json.Marshal(memoryProposal{ExpectedRevision: revision, Constraints: []string{}, Facts: []MemoryFact{}, Todos: []string{}, OpenQuestions: []string{}, Summary: "已完成本轮分析"})
			_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "tool_calls",
				"message": map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{"id": "memory", "type": "function", "function": map[string]any{"name": "store_working_memory", "arguments": string(args)}}}}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"index": 0, "finish_reason": "stop",
			"message": map[string]any{"role": "assistant", "content": answer}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}})
	}))
	defer server.Close()
	m, session, _ := agentManager(t, nil, func(d *Deps) { d.ModelClient = model.NewClient(server.Client()) })
	ctx := context.Background()
	credential := "test-only-key"
	profile, err := m.CreateModelProfile(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: server.URL, Model: "test", ContextTokens: 65536, OutputTokens: 8192, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true, Credential: &credential})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(ctx, session.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "large-answer", Content: "详细说明检查结论"})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded {
		records, _ := m.ModelRequests(ctx, run.ID, "", 50)
		detail := "none"
		if len(records.Items) > 0 {
			if last := records.Items[len(records.Items)-1].Error; last != nil {
				detail = last.Code + ": " + last.Message
			}
		}
		t.Fatalf("长回答未正常完成：status=%s warning=%+v records=%d error=%s", got.Status, got.Warning, len(records.Items), detail)
	}
	messages, err := m.Messages(ctx, session.ID, "", 50)
	if err != nil || len(messages.Items) == 0 || messages.Items[len(messages.Items)-1].Content != answer {
		t.Fatalf("长回答未完整落库：%v", err)
	}
}
