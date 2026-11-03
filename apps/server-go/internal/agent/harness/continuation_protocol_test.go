package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
)

func TestToolExecutionFactsPreserveDispatchUncertainty(t *testing.T) {
	for _, tc := range []struct {
		name, status, code string
		op                 *Operation
		call               *Call
	}{
		{name: "无派发记录", status: "not-executed", code: "tool-not-executed"},
		{name: "仅计划", status: "not-executed", code: "tool-not-executed", op: &Operation{Status: "planned", CallID: "reserved"}},
		{name: "等待批准", status: "not-executed", code: "tool-not-executed", op: &Operation{Status: StateWaitingApproval}},
		{name: "派发后无回执", status: "unknown", code: "outcome-unknown", op: &Operation{Status: "dispatched"}},
		{name: "派发身份优先", status: "unknown", code: "outcome-unknown", op: &Operation{Status: "planned", DispatchID: "dispatched"}},
		{name: "遗留运行中回执", status: "unknown", code: "outcome-unknown", call: &Call{Status: StateRunning}},
		{name: "中断回执", status: "unknown", code: "outcome-unknown", call: &Call{Status: StateInterrupted}},
		{name: "异步结果未知", status: "unknown", code: "outcome-unknown", op: &Operation{Status: "unknown"}, call: &Call{Status: StateSucceeded, Result: json.RawMessage(`{"taskId":"accepted-task"}`)}},
		{name: "确认成功", status: StateSucceeded, code: `"result":{"ok":true}`, call: &Call{Status: StateSucceeded, Result: json.RawMessage(`{"ok":true}`)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			run := Run{Status: StateCancelled}
			fact := projectToolExecution(run, tc.op, tc.call, nil)
			content := toolFactContent(fact, tc.call)
			if fact.Status != tc.status || !strings.Contains(content, tc.code) {
				t.Fatalf("执行事实不符：%+v %s", fact, content)
			}
			if tc.call != nil && tc.call.Result != nil && !strings.Contains(content, string(tc.call.Result)) {
				t.Fatal("丢失已确认的工具回执")
			}
			var ops []Operation
			var calls []Call
			if tc.op != nil {
				copy := *tc.op
				copy.ModelRequestID, copy.ModelCallID = "model", "proposal"
				ops = append(ops, copy)
			}
			if tc.call != nil {
				copy := *tc.call
				copy.ModelRequestID, copy.ModelCallID = "model", "proposal"
				calls = append(calls, copy)
			}
			record := ModelRequestRecord{ID: "model", Purpose: "inference", Status: StateSucceeded, Response: &model.Response{ToolCalls: []model.ToolCall{{ID: "proposal", Name: "test_read", Arguments: json.RawMessage(`{}`)}}}}
			timeline := projectChatTimeline(run, []ModelRequestRecord{record}, ops, calls, nil)
			if len(timeline.Entries) != 1 || timeline.Entries[0].Status != tc.status {
				t.Fatalf("界面与模型的执行事实不一致：%+v", timeline)
			}
		})
	}
}

// 使用真实 Anthropic SSE 解析器复现：加载、派发前停止、续聊误用历史工具、强制搜索。
func TestDeepSeekAnthropicContinuationForcesSearchAfterCancellation(t *testing.T) {
	for _, tc := range []struct {
		name  string
		limit int
		obey  bool
	}{{"纠正成功", 8192, true}, {"保留较小输出上限", 2048, true}, {"拒绝违规纠正", 8192, false}} {
		t.Run(tc.name, func(t *testing.T) {
			var requests, executed atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Tools        []struct{ Name string } `json:"tools"`
					Messages     json.RawMessage         `json:"messages"`
					ToolChoice   map[string]string       `json:"tool_choice"`
					Thinking     map[string]string       `json:"thinking"`
					OutputConfig map[string]string       `json:"output_config"`
					MaxTokens    int                     `json:"max_tokens"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(400)
					return
				}
				index := requests.Add(1)
				if index == 3 {
					text := string(body.Messages)
					if !strings.Contains(text, "tool-not-executed") || strings.Contains(text, "outcome-unknown") || !strings.Contains(text, `\"historical\":true`) || !strings.Contains(text, "sourceRunId") {
						t.Errorf("续聊仍误报执行或加载事实：%s", text)
					}
					if len(body.Tools) != 3 || !strings.Contains(text, "本次请求实际可调用工具") {
						t.Errorf("历史工具被隐式加载或缺少当前状态：%+v", body.Tools)
					}
				}
				if index == 4 {
					if body.ToolChoice["type"] != "tool" || body.ToolChoice["name"] != toolSearchName || body.Thinking["type"] != "disabled" || body.OutputConfig["effort"] != "" || body.MaxTokens != min(tc.limit, 4096) {
						t.Errorf("纠正请求未限定搜索或未关闭思考：%+v", body)
					}
				} else if body.Thinking["type"] != "enabled" || body.OutputConfig["effort"] != "max" || body.MaxTokens != tc.limit {
					t.Errorf("普通推理未沿用用户档位：%+v", body)
				}
				if index == 5 {
					found := false
					for _, tool := range body.Tools {
						found = found || tool.Name == "test_read"
					}
					if !found {
						t.Error("搜索成功后未恢复工具定义")
					}
				}
				response := searchReply("test_read")
				switch index {
				case 2, 3:
					response.ToolCalls = append(response.ToolCalls, model.ToolCall{ID: "read", Name: "test_read", Arguments: json.RawMessage(`{}`)})
				case 4:
					if !tc.obey {
						response.ToolCalls = append(response.ToolCalls, model.ToolCall{ID: "read", Name: "test_read", Arguments: json.RawMessage(`{}`)})
					}
				case 5:
					response = toolReply("test_read")
				case 6:
					response = finalReply("已核对只读状态")
				}
				w.Header().Set("Content-Type", "text/event-stream")
				emit := func(value any) {
					raw, _ := json.Marshal(value)
					_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
				}
				emit(map[string]any{"type": "message_start", "message": map[string]any{"type": "message", "role": "assistant", "content": []any{}, "usage": map[string]int{"input_tokens": 50, "output_tokens": 0}}})
				for i, call := range response.ToolCalls {
					emit(map[string]any{"type": "content_block_start", "index": i, "content_block": map[string]any{"type": "tool_use", "id": call.ID, "name": call.Name, "input": call.Arguments}})
					emit(map[string]any{"type": "content_block_stop", "index": i})
				}
				stop := "tool_use"
				if len(response.ToolCalls) == 0 {
					stop = "end_turn"
					emit(map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": response.Content}})
					emit(map[string]any{"type": "content_block_stop", "index": 0})
				}
				emit(map[string]any{"type": "message_delta", "delta": map[string]string{"stop_reason": stop}, "usage": map[string]int{"output_tokens": 20}})
				emit(map[string]string{"type": "message_stop"})
			}))
			defer server.Close()
			beforeRead := make(chan struct{})
			var firstRun atomic.Bool
			client := model.NewClient(server.Client())
			m, session, _ := agentManager(t, func(ctx context.Context, p model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				return client.Complete(ctx, p, request)
			}, func(d *Deps) {
				d.Tools = nil // 只测试按需扩展，首请求与线上一样只有三个常驻入口。
				d.Catalog = &discoveryTestCatalog{operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
					executed.Add(1)
					return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
				}}}
				d.Spawn = func(context.Context) (worker.Process, error) {
					return &agentTestProcess{runAgent: func(ctx context.Context, id string, broker worker.AgentBroker) error {
						if firstRun.Swap(true) {
							return (&agentTestProcess{}).RunAgent(ctx, id, broker)
						}
						for turn := 0; turn < 2; turn++ {
							response, err := broker.NextModel(ctx)
							if err != nil {
								return err
							}
							call := response.ToolCalls[0]
							if err := broker.ExecuteAgent(ctx, response.ID, 0, call.ID, call.Name, call.Args); err != nil {
								return err
							}
						}
						close(beforeRead)
						<-ctx.Done()
						return ctx.Err()
					}}, nil
				}
			})
			credential := "test-only-key"
			profile, err := m.CreateModelProfile(model.Input{Provider: model.ProviderDeepSeek, APIFormat: model.FormatAnthropicMessages, BaseURL: server.URL, Model: "deepseek-flash", ContextTokens: 65536, OutputTokens: tc.limit, Capabilities: model.Capabilities{Text: true, Tools: true, ReasoningLevels: []string{"disabled", "max"}, Source: "test"}, Active: true, Credential: &credential})
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			if _, err := m.SwitchSessionModel(ctx, session.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
				t.Fatal(err)
			}
			approveEnvironment(t, m, session)
			first, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "cancel-before-read", Content: "检查只读状态", ReasoningLevel: "max"})
			if err != nil {
				t.Fatal(err)
			}
			select {
			case <-beforeRead:
			case <-time.After(5 * time.Second):
				t.Fatal("未到达只读工具派发前")
			}
			if _, err := m.Cancel(ctx, first.ID); err != nil {
				t.Fatal(err)
			}
			if got := runtimeFinished(t, m, first.ID); got.Status != StateCancelled || executed.Load() != 0 {
				t.Fatalf("取消前执行了只读工具：%+v", got.Error)
			}
			runtimeEventually(t, func() bool { return m.Info().Agent.Available })
			next, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "continue-read", Content: "继续", ReasoningLevel: "max"})
			if err != nil {
				t.Fatal(err)
			}
			got := runtimeFinished(t, m, next.ID)
			if tc.obey {
				if got.Status != StateSucceeded || executed.Load() != 1 || requests.Load() != 6 {
					t.Fatalf("纠正闭环失败：%+v requests=%d executed=%d", got.Error, requests.Load(), executed.Load())
				}
			} else if got.Status != StateFailed || got.EndReason != "model-tool-choice-mismatch" || requests.Load() != 4 || executed.Load() != 0 {
				t.Fatalf("违规纠正未整批拒绝：%+v requests=%d executed=%d", got.Error, requests.Load(), executed.Load())
			}
			records, err := m.ModelRequests(ctx, next.ID, "", 50)
			if err != nil || len(records.Items) < 2 || records.Items[0].Error == nil || records.Items[0].Error.Code != model.ToolNotLoadedCode || records.Items[0].Response != nil {
				t.Fatal("未保存原失败或返回了被拒绝提议")
			}
			calls, _ := m.Calls(ctx, next.ID, "", 50)
			for _, call := range calls.Items {
				if call.ModelRequestID == records.Items[0].ID || !tc.obey {
					t.Fatal("被拒绝批次发生部分执行")
				}
			}
			restored := &agentExecution{manager: m, run: got}
			if pending, err := restored.pendingToolCorrection(ctx); err != nil || pending {
				t.Fatalf("恢复重置了一次纠正额度：%v %v", pending, err)
			}
			original, _ := m.Calls(ctx, first.ID, "", 50)
			for _, call := range original.Items {
				if strings.Contains(string(call.Result), "historical") {
					t.Fatal("历史投影改写了持久搜索回执")
				}
			}
		})
	}
}
