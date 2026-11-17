package harness

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/tools"
)

func continuousStoreRun(t *testing.T, s *store, suffix string) Run {
	t.Helper()
	_, task, r := sessionStoreFixture(t, s, suffix, runtimeStoreTestTime)
	r.DriverVersion, r.BudgetPolicy, r.RecoveryPolicy = "v2", continuousBudgetPolicy, continuousRecoveryPolicy
	return acceptSessionTestRun(t, s, task, r, true)
}

func TestContinuousWorkerLossResumesCheckpointWithoutReplayingTool(t *testing.T) {
	var spawns, requests atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if requests.Add(1) == 1 {
			return toolReply("docker_images_list"), nil
		}
		return finalReply("已核对原回执并完成"), nil
	}, func(d *Deps) {
		continuousDeps(d)
		d.Spawn = func(context.Context) (worker.Process, error) {
			p := &agentTestProcess{}
			if spawns.Add(1) == 1 {
				p.runAgent = func(ctx context.Context, _ string, b worker.AgentBroker) error {
					r, err := b.NextModel(ctx)
					if err != nil {
						return err
					}
					c := r.ToolCalls[0]
					if err = b.ExecuteAgent(ctx, r.ID, 0, c.ID, c.Name, c.Args); err != nil {
						return err
					}
					return &worker.InterruptedError{Err: errors.New("模拟子进程退出")}
				}
			}
			return p, nil
		}
	})
	r := submitAgentTest(t, m, session, "continuous-worker-loss", "检查镜像")
	done := runtimeFinished(t, m, r.ID)
	calls := int(invoker.count.Load())
	if done.Status != StateSucceeded || done.ID != r.ID || done.RequestID != r.RequestID || calls != 1 || done.Usage.Calls != 1 || spawns.Load() < 2 {
		t.Fatalf("检查点重放或未恢复：%+v calls=%d spawns=%d", done, calls, spawns.Load())
	}
}

func TestContinuousShutdownRestartsSameRun(t *testing.T) {
	started := make(chan struct{})
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if requests.Add(1) == 1 {
			close(started)
			<-ctx.Done()
			return model.Response{}, ctx.Err()
		}
		return finalReply("重启后完成"), nil
	}, continuousDeps)
	run := submitAgentTest(t, m, session, "continuous-shutdown", "核实服务")
	awaitDeleteSignal(t, started)
	if err := closeFixtureManager(m); err != nil {
		t.Fatal(err)
	}
	reopened, err := newFixtureManager(t, m.deps)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close(context.Background())
	done := runtimeFinished(t, reopened, run.ID)
	if done.Status != StateSucceeded || done.ID != run.ID || done.RequestID != run.RequestID || done.TaskID != run.TaskID {
		t.Fatalf("重启改变任务身份：%+v", done)
	}
}

func TestContinuousFrozenUnknownKeepsProtectionUntilTrustedReceipt(t *testing.T) {
	ctx := context.Background()
	s, _ := openRuntimeTestStore(t)
	r := continuousStoreRun(t, s, "freeze-unknown")
	o := Operation{ID: "frozen-operation", RunID: r.ID, TaskID: r.TaskID, Status: "dispatched", CallID: "frozen-call", Task: &tools.TaskReference{Domain: "test", ID: "task", RequestID: "original-domain-request"}}
	b := ExecutionBarrier{ID: o.ID, OperationID: o.ID, RunID: r.ID, Status: "dispatched"}
	if _, err := s.change(ctx, r.ID, "inflight-fixture", func(tx sessionstore.Tx, r *Run) error {
		r.Status = StateRunning
		if err := saveOperation(ctx, tx, o); err != nil {
			return err
		}
		if err := saveBarrier(ctx, tx, b); err != nil {
			return err
		}
		if err := saveCall(ctx, tx, Call{ID: o.CallID, RunID: r.ID, OperationID: o.ID, Status: StateRunning}); err != nil {
			return err
		}
		return saveResourceLease(ctx, tx, ResourceLease{ID: o.ID, RunID: r.ID, OperationID: o.ID, State: "held"})
	}); err != nil {
		t.Fatal(err)
	}
	s.freezeContinuous = true
	if err := s.recover(ctx); err != nil {
		t.Fatal(err)
	}
	frozen, _ := s.get(ctx, r.ID)
	if !frozen.PolicyFrozen || frozen.Status != StateRecoveryRequired || frozen.PolicyCheckpoint == nil {
		t.Fatalf("未冻结：%+v", frozen)
	}
	m := &Manager{store: s, ctx: ctx, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}, wake: make(chan struct{}, 1)}
	o, _ = readOperation(ctx, s, o.ID)
	if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
		t.Fatal(err)
	}
	frozen, _ = s.get(ctx, r.ID)
	if frozen.Status != StateRecoveryRequired || !frozen.PolicyFrozen {
		t.Fatal("任务监视器解除了冻结")
	}
	s.freezeContinuous = false
	if err := s.recover(ctx); err != nil {
		t.Fatal(err)
	}
	waiting, _ := s.get(ctx, r.ID)
	if waiting.PolicyFrozen || waiting.Status != StateWaitingRecovery || waiting.Recovery == nil {
		t.Fatalf("未知操作被派发或丢失核实：%+v", waiting)
	}
	assertDomainProtection(t, m, o, "unknown")
	o, _ = readOperation(ctx, s, o.ID)
	if o.Task.RequestID != "original-domain-request" {
		t.Fatal("恢复更换了域请求身份")
	}
	if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskSucceeded, Value: map[string]bool{"verified": true}}); err != nil {
		t.Fatal(err)
	}
	ready, _ := s.get(ctx, r.ID)
	if ready.Status != StateQueued {
		t.Fatalf("可信回执未恢复：%+v", ready)
	}
	assertDomainProtection(t, m, o, "released")
}

func TestContinuousOperationRequestIdentityCannotBeRepurposed(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	r := continuousStoreRun(t, s, "identity")
	capability := Capability{Name: "test_async", Metadata: tools.Metadata{Async: true, TaskDomain: "docker-operation", TaskRequestArgument: "requestId"}}
	original := Operation{ID: "original", RunID: r.ID, TaskID: r.TaskID, Status: "completed", Capability: capability, ArgumentsJSON: `{"requestId":"original-id","target":"a"}`}
	if err := s.write(context.Background(), "identity", func(tx sessionstore.Tx) error { return saveOperation(context.Background(), tx, original) }); err != nil {
		t.Fatal(err)
	}
	if err := validateOperationIdentity(context.Background(), s, original); err != nil {
		t.Fatal("原操作精确核实被拒绝", err)
	}
	for _, tc := range []struct{ args, code string }{{`{"target":"a","requestId":"original-id"}`, "request-id-reused"}, {`{"target":"b","requestId":"original-id"}`, "request-id-conflict"}, {`{"target":"b","requestId":"fresh-id"}`, ""}} {
		next := original
		next.ID = "next"
		next.ArgumentsJSON = tc.args
		err := validateOperationIdentity(context.Background(), s, next)
		if tc.code == "" {
			if err != nil {
				t.Fatal(err)
			}
		} else {
			runtimeErrorCode(t, err, tc.code)
		}
	}
	a := &agentExecution{manager: &Manager{store: s}, run: Run{Snapshot: &CapabilitySnapshot{Tools: []Capability{capability}}}}
	err := a.validateOperationBatch(context.Background(), []model.ToolCall{{Name: capability.Name, Arguments: json.RawMessage(`{"requestId":"fresh","target":"a"}`)}, {Name: capability.Name, Arguments: json.RawMessage(`{"requestId":"fresh","target":"b"}`)}})
	runtimeErrorCode(t, err, "request-id-conflict")
}

// Real worker process, HTTP serialization, temporary model failure, durable
// scheduling and SQLite/JSONL receipts in one bounded integration test.
func TestContinuousRealWorkerHTTPRecoversAndCompletes(t *testing.T) {
	var requests, turns atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Messages []model.Message `json:"messages"`
			Choice   json.RawMessage `json:"tool_choice"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if requests.Add(1) == 1 {
			w.Header().Set("Retry-After", "900")
			w.WriteHeader(503)
			return
		}
		response := finalReply("已完成十二次真实管道查询")
		if strings.Contains(string(input.Choice), "store_working_memory") {
			response = memoryReply(model.Request{Messages: input.Messages})
		} else if turns.Add(1) <= 12 {
			response = toolReply("docker_images_list")
		}
		message := map[string]any{"role": "assistant", "content": response.Content}
		if len(response.ToolCalls) > 0 {
			call := response.ToolCalls[0]
			message["tool_calls"] = []any{map[string]any{"id": "wire-" + strconv.Itoa(int(requests.Load())), "type": "function", "function": map[string]any{"name": call.Name, "arguments": string(call.Arguments)}}}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"index": 0, "message": message, "finish_reason": response.FinishReason}}})
	}))
	defer server.Close()
	var seconds atomic.Int64
	base := runtimeStoreTestTime
	m, _, invoker := agentManager(t, nil, func(d *Deps) {
		continuousDeps(d)
		d.ModelClient = model.NewClient(server.Client())
		d.Now = func() time.Time { return base.Add(time.Duration(seconds.Load()) * time.Second) }
		d.Spawn = func(ctx context.Context) (worker.Process, error) {
			return worker.Spawn(ctx, worker.Options{Path: os.Args[0], Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
		}
	})
	secret := "local-http-fixture"
	profile, err := m.CreateModelProfile(model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: server.URL + "/v1", Model: "continuous-wire", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true, Credential: &secret})
	if err != nil {
		t.Fatal(err)
	}
	session, err := m.CreateSession(context.Background(), CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	r := submitAgentTest(t, m, session, "continuous-real-worker", "完成十二次只读检查")
	runtimeEventually(t, func() bool { got, _ := m.Get(context.Background(), r.ID); return got.Status == StateWaitingModel })
	waiting, _ := m.Get(context.Background(), r.ID)
	if waiting.Wait == nil || waiting.Wait.NextAt != stamp(base.Add(900*time.Second)) {
		t.Fatal("HTTP Retry-After 被缩短", waiting.Wait)
	}
	seconds.Store(901)
	m.promoteContinuousWaiters()
	done := runtimeFinished(t, m, r.ID)
	calls := int(invoker.count.Load())
	if done.Status != StateSucceeded || done.Usage.Calls != 12 || calls != 12 || requests.Load() != 15 {
		t.Fatalf("真实闭环失败：%+v calls=%d requests=%d", done, calls, requests.Load())
	}
	if err = fixture(m).waitRecords(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestContinuousRepeatedWorkerFailureStopsWithoutToolReplay(t *testing.T) {
	var failures atomic.Int32
	m, session, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		return finalReply("不应调用模型"), nil
	}, func(d *Deps) {
		continuousDeps(d)
		d.Spawn = func(context.Context) (worker.Process, error) {
			return &agentTestProcess{runAgent: func(context.Context, string, worker.AgentBroker) error {
				failures.Add(1)
				return &worker.InterruptedError{Err: errors.New("模拟固定进程故障")}
			}}, nil
		}
	})
	r := submitAgentTest(t, m, session, "continuous-worker-no-progress", "执行检查")
	done := runtimeFinished(t, m, r.ID)
	if done.Status != StateInterrupted || done.EndReason != "no-progress" || failures.Load() != 4 || done.Usage.Calls != 0 || done.WorkerRestarts != 3 {
		t.Fatalf("反复重启失控：%+v attempts=%d", done, failures.Load())
	}
}
