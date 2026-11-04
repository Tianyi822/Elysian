package harness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
)

// 在 Worker 读取前装入旧快照，验证接受策略改变不会改写已经接受的运行限额。
func legacyBudgetWorker(limits Limits) func(context.Context) (worker.Process, error) {
	return func(context.Context) (worker.Process, error) {
		return &agentTestProcess{runAgent: func(ctx context.Context, id string, broker worker.AgentBroker) error {
			a := broker.(*agentExecution)
			m := a.manager
			m.mu.Lock()
			run, err := m.store.change(context.Background(), id, "legacy-budget-fixture", func(tx *sql.Tx, r *Run) error {
				r.BudgetPolicy = ""
				r.Limits = limits
				return saveRun(context.Background(), tx, r)
			})
			run.Task = a.run.Task
			a.run = run
			m.mu.Unlock()
			if err != nil {
				return err
			}
			return (&agentTestProcess{}).RunAgent(ctx, id, broker)
		}}, nil
	}
}

func TestResourceBudgetLongTroubleshootingLoop(t *testing.T) {
	var requests, executions atomic.Int32
	catalog := &operationCatalog{execute: func(_ context.Context, o Operation) (CapabilityResult, error) {
		if executions.Add(1) == 1 {
			return CapabilityResult{BusinessError: &Failure{Code: "pull-failed", Message: "MySQL 镜像拉取失败，请检查镜像源"}, Value: json.RawMessage(`{"pulled":false}`)}, nil
		}
		return CapabilityResult{Value: json.RawMessage(`{"registry":"available","mysql":"ready"}`)}, nil
	}}
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return usageReply(memoryReply(request), 20, 20), nil
		}
		n := requests.Add(1)
		var response model.Response
		switch {
		case n > 24:
			response = finalReply("已检查镜像源并重试，MySQL 已就绪")
		case n%3 == 1:
			response = searchReply("test_read")
		case n%3 == 2:
			response = toolReply(planTool)
			response.ToolCalls[0].Arguments = json.RawMessage(`{"steps":[{"id":"pull","title":"安装 MySQL 并检查镜像源后重试","status":"in_progress"}]}`)
		default:
			response = toolReply("test_read")
		}
		return usageReply(response, 100, 50), nil
	}, func(d *Deps) { d.Catalog = catalog; d.AgentLimits.MaxSteps = 2; d.AgentLimits.MaxModelRequests = 2 })
	approveEnvironment(t, m, session)
	run := submitAgentTest(t, m, session, "long-troubleshoot", "安装 MySQL；拉取失败时检查镜像源并重试")
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.BudgetPolicy != resourceBudgetPolicy || got.Limits.MaxSteps != 0 || got.Limits.MaxModelRequests != 0 || got.Usage.Calls != 24 || got.Usage.ModelRequests != 26 || executions.Load() != 8 {
		t.Fatalf("长循环被截断：status=%s reason=%s usage=%+v executions=%d", got.Status, got.EndReason, got.Usage, executions.Load())
	}
	calls, err := m.Calls(context.Background(), run.ID, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	failed := 0
	for _, call := range calls.Items {
		if call.Error != nil && call.Error.Code == "pull-failed" {
			failed++
		}
	}
	if failed != 1 {
		t.Fatalf("拉取失败事实丢失：%+v", calls)
	}
}

func TestResourceBudgetStopsAndRestores(t *testing.T) {
	for _, resource := range []string{"tokens", "active-time", "results"} {
		t.Run(resource, func(t *testing.T) {
			var calls atomic.Int32
			m, session, invoker := agentManager(t, func(ctx context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				calls.Add(1)
				if resource == "active-time" {
					<-ctx.Done()
					return model.Response{}, ctx.Err()
				}
				return usageReply(toolReply("docker_images_list"), 100, 50), nil
			}, func(d *Deps) {
				if resource == "tokens" {
					d.AgentLimits.TokenBudget = 1
				}
				if resource == "active-time" {
					d.AgentLimits.RunTimeoutSeconds = 1
				}
				if resource == "results" {
					d.AgentLimits.RunResultBytes = d.AgentLimits.ResultBytes - 1
				}
			})
			var executed atomic.Int32
			invoker.execute = func(context.Context, string) (any, error) { executed.Add(1); return true, nil }
			run := submitAgentTest(t, m, session, "stop-"+resource, "检查 MySQL 安装情况")
			got := runtimeFinished(t, m, run.ID)
			if got.Status != StateInterrupted || got.BudgetStop == nil || got.BudgetStop.Resource != resource || got.Continuation == nil || !got.Continuation.Allowed || executed.Load() != 0 {
				t.Fatalf("预算结束错误：%+v executed=%d info=%+v", got, executed.Load(), m.Info())
			}
			runtimeEventually(t, func() bool { return m.Info().Agent.Available })
			before := calls.Load()
			history, err := m.Messages(context.Background(), session.ID, "", 50)
			if err != nil || len(history.Items) != 2 || history.Items[1].Origin != "runtime" || !strings.Contains(history.Items[1].Content, "本轮额度已用完，进度已保存") {
				t.Fatalf("预算结果缺失：%+v %v", history, err)
			}
			m = reopenOperationManager(t, m)
			restored, err := m.Get(context.Background(), run.ID)
			if err != nil || restored.BudgetStop == nil || *restored.BudgetStop != *got.BudgetStop || restored.Continuation == nil || !restored.Continuation.Allowed || calls.Load() != before {
				t.Fatalf("重启后不一致或发生重放：%+v %v", restored, err)
			}
			timeline, err := m.ChatSnapshot(context.Background(), run.ID)
			if err != nil || timeline.Timeline.BudgetStop == nil || *timeline.Timeline.BudgetStop != *got.BudgetStop || timeline.Timeline.TerminalResult == nil {
				t.Fatalf("时间线不一致：%+v %v", timeline, err)
			}
			lines, _ := readRecordLines(t, m.store, recordOwner{"session", session.ID})
			results := 0
			for _, line := range lines {
				if line.Type == "messages" {
					var msg Message
					_ = json.Unmarshal(line.Document, &msg)
					if msg.Origin == "runtime" {
						results++
					}
				}
			}
			if results != 1 {
				t.Fatalf("预算收尾重复：%d", results)
			}
		})
	}
}

func budgetSourceFixture(t *testing.T) (*store, Session, Task, Run) {
	t.Helper()
	s, _ := openRuntimeTestStore(t)
	session, task, run := sessionStoreFixture(t, s, "budget-continuation", runtimeStoreTestTime)
	task.DriverVersion, run.DriverVersion, run.BudgetPolicy = "v2", "v2", resourceBudgetPolicy
	run.Limits.MaxSteps, run.Limits.MaxModelRequests = 0, 0
	run = acceptSessionTestRun(t, s, task, run, true)
	m := &Manager{store: s, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}}
	_, err := s.change(context.Background(), run.ID, "budget-fixture", func(tx *sql.Tx, r *Run) error {
		r.Usage.Tokens = r.Limits.TokenBudget
		r.Plan = &RunPlan{Revision: 2, UpdatedAt: r.CreatedAt, Steps: []PlanStep{{ID: "pull", Title: "拉取镜像", Status: "completed"}, {ID: "inspect", Title: "核实安装结果", Status: "in_progress"}}}
		return saveRun(context.Background(), tx, r)
	})
	if err != nil {
		t.Fatal(err)
	}
	m.finishLocked(run.ID, StateFailed, "model-budget", "预算不足")
	run, err = s.get(context.Background(), run.ID)
	if err != nil || m.storageError {
		t.Fatalf("fixture: %v", err)
	}
	return s, session, task, run
}

func continuationInput(source Run, id string) Run {
	r := source
	r.ID, r.RequestID, r.Status, r.LastSeq = id, id, StateQueued, "0"
	r.BudgetStop, r.Error, r.Plan, r.Continuation = nil, nil, nil, nil
	r.EndReason, r.EndedAt = "", ""
	r.Usage, r.ActiveMilliseconds = Usage{}, 0
	r.Selection = &AgentInput{RequestID: id, Content: "继续完成上轮未完成的任务。", ContinueFromRunID: source.ID, PermissionMode: PermissionFull}
	r.Input = r.Selection.Content
	return r
}

func TestBudgetContinuationAtomicAcceptanceAndRace(t *testing.T) {
	ctx := context.Background()
	s, session, task, source := budgetSourceFixture(t)
	next := continuationInput(source, "continued-run")
	var wg sync.WaitGroup
	var accepted, duplicates atomic.Int32
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			got, dup, err := s.acceptAgent(ctx, task, next, "same-request", "continued-message", false)
			if err != nil {
				t.Error(err)
				return
			}
			if got.ID != next.ID {
				t.Error("运行标识变化")
			}
			if dup {
				duplicates.Add(1)
			} else {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 1 || duplicates.Load() != 7 {
		t.Fatalf("重复接受：%d/%d", accepted.Load(), duplicates.Load())
	}
	got, err := s.get(ctx, next.ID)
	if err != nil || got.TaskID != source.TaskID || got.SessionID != source.SessionID || got.RunNumber != 2 || got.Plan == nil || got.Plan.SourceRunID != source.ID || got.Plan.Steps[0].Status != "completed" || got.Plan.Steps[1].Status != "pending" || got.Usage.Tokens != 0 {
		t.Fatalf("续接丢失进度：%+v %v", got, err)
	}
	old, _ := s.get(ctx, source.ID)
	if old.Plan.Steps[1].Status != "in_progress" || old.Usage.Tokens != source.Usage.Tokens {
		t.Fatal("改写了旧事实")
	}
	if _, _, err := s.acceptAgent(ctx, task, next, "changed-request", "other", false); err == nil {
		t.Fatal("接受了请求 ID 冲突")
	}
	finishSessionTestRun(t, s, next.ID, "已完成", nil)
	stale := continuationInput(source, "stale-button")
	if _, _, err := s.acceptAgent(ctx, task, stale, "stale", "stale-message", false); err == nil {
		t.Fatal("接受了过期按钮")
	}
	messages, _ := s.messages(ctx, session.ID, "", 50)
	if len(messages.Items) != 4 {
		t.Fatalf("重复消息：%+v", messages)
	}
}

func TestBudgetContinuationRollbackAndGuards(t *testing.T) {
	for _, mode := range []string{"commit", "unknown", "lease", "foreign-task", "superseded", "cancelled", "legacy"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			s, session, task, source := budgetSourceFixture(t)
			beforeRun, _ := s.get(ctx, source.ID)
			if mode == "commit" {
				s.failNextCommit = errors.New("accept commit failed")
			}
			if mode == "unknown" || mode == "lease" {
				err := s.write(ctx, "barrier-fixture", func(tx *sql.Tx) error {
					if mode == "unknown" {
						return saveOperation(ctx, tx, Operation{ID: "unknown-op", RunID: source.ID, TaskID: source.TaskID, ModelRequestID: "model", CallIndex: 0, Status: "unknown"})
					}
					return saveResourceLease(ctx, tx, ResourceLease{ID: "held-lease", RunID: source.ID, OperationID: "held-op", State: "held"})
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			if mode == "superseded" || mode == "cancelled" || mode == "legacy" {
				_, err := s.change(ctx, source.ID, "guard-fixture", func(tx *sql.Tx, r *Run) error {
					if mode == "superseded" {
						r.SupersededByRunID = "edited-run"
					}
					if mode == "cancelled" {
						r.CancelRequestedAt = r.CreatedAt
					}
					if mode == "legacy" {
						r.BudgetPolicy = ""
						r.BudgetStop = nil
						r.Status = StateFailed
						r.Error = &Failure{Code: "call-budget", Message: "工具调用次数达到上限"}
					}
					return saveRun(ctx, tx, r)
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			next := continuationInput(source, "next-"+mode)
			if mode == "foreign-task" {
				next.TaskID = "another-task"
			}
			_, beforeLedger := readRecordLines(t, s, recordOwner{"session", session.ID})
			got, _, err := s.acceptAgent(ctx, task, next, "continue-"+mode, "message-"+mode, false)
			if mode == "legacy" {
				if err != nil || got.Plan == nil {
					t.Fatalf("旧次数失败不能续接：%+v %v", got, err)
				}
				return
			}
			if err == nil {
				t.Fatal("不应接受续接")
			}
			if mode == "commit" {
				_, afterLedger := readRecordLines(t, s, recordOwner{"session", session.ID})
				old, _ := s.get(ctx, source.ID)
				remote, _ := readSession(ctx, s.db, session.ID)
				if !bytes.Equal(beforeLedger, afterLedger) || old.Status != beforeRun.Status || remote.ActiveRunID != "" {
					t.Fatal("续接事务失败泄露部分写入")
				}
				s.failNextCommit = nil
				if _, _, err = s.acceptAgent(ctx, task, next, "continue-"+mode, "message-"+mode, false); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestResourceBudgetReservationsSettleActualBytes(t *testing.T) {
	s, _, _, source := budgetSourceFixture(t)
	ctx := context.Background()
	_, err := s.change(ctx, source.ID, "reservation", func(tx *sql.Tx, r *Run) error {
		r.Usage.ResultBytes = 20
		r.Limits.RunResultBytes = 100
		r.Limits.ResultBytes = 60
		if err := saveCall(ctx, tx, Call{ID: "reserved", RunID: r.ID, StepIndex: 0, Status: StateRunning, ReservedResultBytes: 60}); err != nil {
			return err
		}
		if err := ensureResultBudget(ctx, tx, *r, 21); err == nil {
			return fmt.Errorf("未计入在途预留")
		}
		if err := ensureResultBudget(ctx, tx, *r, 20); err != nil {
			return err
		}
		r.Usage.ResultBytes += 10
		if err := saveCall(ctx, tx, Call{ID: "reserved", RunID: r.ID, StepIndex: 0, Status: StateSucceeded, Result: json.RawMessage(`"12345678"`)}); err != nil {
			return err
		}
		return ensureResultBudget(ctx, tx, *r, 60)
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestResourceBudgetClarificationAfterSixteenCalls(t *testing.T) {
	var count atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return usageReply(memoryReply(r), 20, 20), nil
		}
		n := count.Add(1)
		if n <= 17 {
			return usageReply(toolReply("docker_images_list"), 100, 50), nil
		}
		if n == 18 {
			return usageReply(userInputReply(questionFixture), 100, 50), nil
		}
		return usageReply(finalReply("已根据补充信息完成检查"), 100, 50), nil
	}, nil)
	run := submitAgentTest(t, m, session, "question-after-sixteen", "检查后询问确认范围")
	q := waitUserInput(t, m, run.ID)
	m = reopenOperationManager(t, m)
	if _, err := m.AnswerUserInput(context.Background(), run.ID, q.ID, userAnswers()); err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.Usage.Calls != 18 || got.Usage.ModelRequests != 20 {
		t.Fatalf("澄清或恢复触发次数上限：%+v", got)
	}
}

func TestBudgetContinuationUsesNewModelAndOriginalGoal(t *testing.T) {
	ctx := context.Background()
	var observed atomic.Bool
	m, session, _ := agentManager(t, func(_ context.Context, p model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		var content strings.Builder
		for _, msg := range r.Messages {
			content.WriteString(msg.Content)
		}
		if p.Model != "replacement-model" || r.ReasoningLevel != "high" || !strings.Contains(content.String(), "安装 MySQL 并核实结果") || !strings.Contains(content.String(), "用户选择继续来源运行") {
			t.Errorf("续接上下文或模型不正确：%s %s", p.Model, r.ReasoningLevel)
		}
		observed.Store(true)
		return finalReply("继续核实完成"), nil
	}, func(d *Deps) { d.AgentLimits.TokenBudget = 1 })
	source := submitAgentTest(t, m, session, "source-budget", "安装 MySQL 并核实结果")
	runtimeFinished(t, m, source.ID)
	secret := "test-new-model-key"
	profile, err := m.deps.Profiles.Create(model.Input{Credential: &secret, Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: "http://127.0.0.1:9/v1", Model: "replacement-model", ContextTokens: 65536, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, ReasoningLevels: []string{"high"}, Source: "test"}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(ctx, session.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	m.deps.AgentLimits.TokenBudget = 196608
	m.mu.Unlock()
	input := AgentInput{RequestID: "continue-new-model", Content: "继续完成上轮未完成的任务。", ContinueFromRunID: source.ID, ReasoningLevel: "high", PermissionMode: PermissionFull, ExtensionMode: "enabled", AuthorizationMode: AuthorizationOnDemand}
	next, dup, err := m.ContinueTask(ctx, source.TaskID, input)
	if err != nil || dup {
		t.Fatalf("续接失败：%v %v", dup, err)
	}
	got := runtimeFinished(t, m, next.ID)
	if got.Status != StateSucceeded || got.TaskID != source.TaskID || got.Model.ID != profile.ID || got.Snapshot.PermissionMode != PermissionFull || got.Selection.ContinueFromRunID != source.ID || !observed.Load() {
		t.Fatalf("新轮设置无效：%+v", got)
	}
	retry, dup, err := m.ContinueTask(ctx, source.TaskID, input)
	if err != nil || !dup || retry.ID != next.ID {
		t.Fatalf("已完成续接重试不幂等：%+v %v", retry, err)
	}
	input.ContinueFromRunID = "another-run"
	if _, _, err = m.ContinueTask(ctx, source.TaskID, input); err == nil {
		t.Fatal("来源未参与幂等校验")
	}
}

func TestBudgetContinuationDifferentRequestsCompete(t *testing.T) {
	s, _, task, source := budgetSourceFixture(t)
	var wg sync.WaitGroup
	var accepted atomic.Int32
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			next := continuationInput(source, fmt.Sprintf("tab-%d", i))
			_, _, err := s.acceptAgent(context.Background(), task, next, next.ID, "message-"+next.ID, false)
			if err == nil {
				accepted.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if accepted.Load() != 1 {
		t.Fatalf("跨标签创建多轮：%d", accepted.Load())
	}
}

func TestBudgetContinuationAfterBarrierReconciliation(t *testing.T) {
	s, _, _, source := budgetSourceFixture(t)
	ctx := context.Background()
	err := s.write(ctx, "unknown-fixture", func(tx *sql.Tx) error {
		if err := saveOperation(ctx, tx, Operation{ID: "unknown", RunID: source.ID, TaskID: source.TaskID, ModelRequestID: "model", Status: "unknown"}); err != nil {
			return err
		}
		return saveBarrier(ctx, tx, ExecutionBarrier{ID: "barrier", RunID: source.ID, OperationID: "unknown", Status: "unknown"})
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := continuation(ctx, s.db, source)
	if err != nil || state.Allowed {
		t.Fatalf("未知结果未阻塞：%+v %v", state, err)
	}
	m := &Manager{store: s, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}}
	if _, err = m.Reconcile(ctx, "barrier", "外部查询已确认停止", "confirmed-stopped"); err != nil {
		t.Fatal(err)
	}
	state, err = continuation(ctx, s.db, source)
	if err != nil || !state.Allowed {
		t.Fatalf("核实后仍阻塞：%+v %v", state, err)
	}
}

func TestBudgetStopTransactionRollback(t *testing.T) {
	ctx := context.Background()
	s, _ := openRuntimeTestStore(t)
	session, task, run := sessionStoreFixture(t, s, "budget-stop-rollback", runtimeStoreTestTime)
	run.DriverVersion, run.BudgetPolicy = "v2", resourceBudgetPolicy
	run = acceptSessionTestRun(t, s, task, run, true)
	_, before := readRecordLines(t, s, recordOwner{"session", session.ID})
	if _, err := s.db.Exec(`CREATE TRIGGER reject_budget_result BEFORE INSERT ON messages WHEN json_extract(NEW.document,'$.origin')='runtime' BEGIN SELECT RAISE(ABORT,'reject-budget-result'); END`); err != nil {
		t.Fatal(err)
	}
	m := &Manager{store: s, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}}
	m.finishLocked(run.ID, StateFailed, "result-budget", "结果预算不足")
	got, err := s.get(ctx, run.ID)
	remote, _ := readSession(ctx, s.db, session.ID)
	_, after := readRecordLines(t, s, recordOwner{"session", session.ID})
	if err != nil || got.Status != StateQueued || got.BudgetStop != nil || remote.ActiveRunID != run.ID || !bytes.Equal(before, after) {
		t.Fatalf("预算结果事务出现部分提交：%+v %v", got, err)
	}
}

func TestBudgetContinuationLegacyUnknownCallBlocks(t *testing.T) {
	s, _, _, source := budgetSourceFixture(t)
	ctx := context.Background()
	if err := s.write(ctx, "legacy-unknown-call", func(tx *sql.Tx) error {
		return saveCall(ctx, tx, Call{ID: "old-call", RunID: source.ID, Status: StateInterrupted, StepIndex: 0})
	}); err != nil {
		t.Fatal(err)
	}
	state, err := continuation(ctx, s.db, source)
	if err != nil || state.Allowed {
		t.Fatalf("旧未知调用未阻塞：%+v %v", state, err)
	}
}
