package harness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

func continuousDeps(d *Deps) { d.LegacyAgentPolicies = false }

func TestContinuousModelWaitPreservesRunAndLogicalRequestAcrossRestart(t *testing.T) {
	var offset atomic.Int64
	base := time.Date(2026, 11, 17, 0, 0, 0, 0, time.UTC)
	var attempts atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if attempts.Add(1) == 1 {
			return model.Response{}, &model.Error{Code: "model-rate-limited", Message: "模型限流", Retryable: true, RetryAfterSeconds: 900}
		}
		return finalReply("已恢复并完成检查"), nil
	}, func(d *Deps) {
		continuousDeps(d)
		d.Now = func() time.Time { return base.Add(time.Duration(offset.Load()) * time.Second) }
	})
	run := submitAgentTest(t, m, session, "continuous-original-id", "检查服务")
	runtimeEventually(t, func() bool { r, _ := m.Get(context.Background(), run.ID); return r.Status == StateWaitingModel })
	waiting, _ := m.Get(context.Background(), run.ID)
	if waiting.Wait == nil || waiting.Wait.NextAt != stamp(base.Add(900*time.Second)) || waiting.BudgetPolicy != continuousBudgetPolicy || waiting.Limits.TokenBudget != 0 || waiting.Limits.RunTimeoutSeconds != 0 {
		t.Fatalf("未持久等待或仍有限额：%+v", waiting)
	}
	runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.executionLocked(run.ID) == nil })
	m.promoteContinuousWaiters()
	if attempts.Load() != 1 {
		t.Fatal("忽略 Retry-After 提前重试")
	}
	if err := m.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	reopened, err := New(m.deps)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close(context.Background())
	offset.Store(901)
	reopened.promoteContinuousWaiters()
	finished := runtimeFinished(t, reopened, run.ID)
	if finished.Status != StateSucceeded || finished.ID != run.ID || finished.TaskID != run.TaskID || finished.RequestID != run.RequestID || finished.Wait != nil {
		t.Fatalf("未沿用原执行：%+v", finished)
	}
	records, _ := reopened.ModelRequests(context.Background(), run.ID, "", 20)
	var inference []ModelRequestRecord
	for _, record := range records.Items {
		if record.Purpose == "inference" {
			inference = append(inference, record)
		}
	}
	if len(inference) != 2 || inference[0].LogicalID != inference[1].LogicalID || inference[0].ID == inference[1].ID || inference[1].Attempt != 2 {
		t.Fatalf("逻辑身份或实际尝试丢失：%+v", inference)
	}
	messages, _ := reopened.Messages(context.Background(), session.ID, "", 20)
	if len(messages.Items) != 2 {
		t.Fatalf("恢复重复创建了公开消息：%+v", messages)
	}
}

func TestContinuousCancellationNeverRevivesWaitingRun(t *testing.T) {
	var offset atomic.Int64
	base := time.Now()
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		requests.Add(1)
		return model.Response{}, &model.Error{Code: "model-rate-limited", Message: "限流", Retryable: true}
	}, func(d *Deps) {
		continuousDeps(d)
		d.Now = func() time.Time { return base.Add(time.Duration(offset.Load()) * time.Hour) }
	})
	run := submitAgentTest(t, m, session, "continuous-cancel-wait", "检查")
	runtimeEventually(t, func() bool { r, _ := m.Get(context.Background(), run.ID); return r.Status == StateWaitingModel })
	if _, err := m.Cancel(context.Background(), run.ID); err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, run.ID)
	offset.Store(24)
	m.promoteContinuousWaiters()
	r, _ := m.Get(context.Background(), run.ID)
	if r.Status != StateCancelled || requests.Load() != 1 {
		t.Fatal("取消任务被恢复")
	}
}

func TestContinuousMethodFailureDiagnosesWithoutRedispatch(t *testing.T) {
	var modelCalls, diagnostics, summaries atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if request.ToolChoice == "none" {
			summaries.Add(1)
			if estimateRequestTokens(request) > 8192 || request.MaxTokens > 2048 || len(request.Tools) > 0 {
				t.Error("总结超出独立边界")
			}
			return finalReply("查询方法未能取得证据，已保留执行记录。"), nil
		}
		modelCalls.Add(1)
		if strings.Contains(allRequestText(request), "禁止重复已隔离方法") {
			diagnostics.Add(1)
		}
		return toolReply("docker_images_list"), nil
	}, continuousDeps)
	var actual atomic.Int32
	invoker.execute = func(context.Context, string) (any, error) {
		actual.Add(1)
		return nil, &tools.BusinessError{Code: "query-rejected", Message: "查询参数需要修正", NotDispatched: true}
	}
	run := submitAgentTest(t, m, session, "continuous-diagnosis", "核实镜像")
	done := runtimeFinished(t, m, run.ID)
	if done.Status != StateInterrupted || done.EndReason != "no-progress" || actual.Load() != 3 || diagnostics.Load() < 3 || summaries.Load() != 1 || modelCalls.Load() < 6 {
		t.Fatalf("未诊断改道或重复派发：status=%s reason=%s actual=%d diagnostics=%d summary=%d model=%d", done.Status, done.EndReason, actual.Load(), diagnostics.Load(), summaries.Load(), modelCalls.Load())
	}
	if done.Report == nil || done.Report.Reason == "" || done.Report.Analysis == "" || done.Report.Objective != "核实镜像" {
		t.Fatalf("缺少事实报告：%+v", done.Report)
	}
}

func TestContinuousCompletionChecksPlanBeforeSuccess(t *testing.T) {
	var calls atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		switch calls.Add(1) {
		case 1:
			return planReply(planFixture), nil
		case 2:
			return finalReply("已经全部完成"), nil
		case 3:
			if !strings.Contains(allRequestText(request), "结束核对发现计划未完成") {
				t.Error("未反馈待办")
			}
			return planReply(`{"steps":[{"id":"inspect","title":"检查","status":"completed"},{"id":"verify","title":"验证","status":"completed"}]}`), nil
		default:
			return finalReply("检查及验证均已完成"), nil
		}
	}, continuousDeps)
	run := submitAgentTest(t, m, session, "continuous-completion", "检查并验证")
	done := runtimeFinished(t, m, run.ID)
	if done.Status != StateSucceeded || done.CompletionChecks != 1 || calls.Load() != 4 {
		t.Fatalf("计划未完成就结束：%+v", done)
	}
}

func TestContinuousReplicaFaultKeepsHistoryAndInflightReceiptThenResumes(t *testing.T) {
	var modelCalls, toolCalls atomic.Int32
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if modelCalls.Add(1) == 1 {
			return toolReply("docker_images_list"), nil
		}
		return finalReply("检查完成"), nil
	}, continuousDeps)
	invoker.execute = func(context.Context, string) (any, error) {
		toolCalls.Add(1)
		m.store.setRecordHook(func(string) error { return errors.New("disk unavailable") })
		return map[string]bool{"confirmed": true}, nil
	}
	run := submitAgentTest(t, m, session, "continuous-replica", "检查")
	runtimeEventually(t, func() bool { r, _ := m.Get(context.Background(), run.ID); return r.Status == StateWaitingStorage })
	calls, err := m.Calls(context.Background(), run.ID, "", 10)
	if err != nil || len(calls.Items) != 1 || !bytes.Contains(calls.Items[0].Result, []byte("confirmed")) {
		t.Fatalf("在途事实丢失：%+v %v", calls, err)
	}
	if sessions, err := m.ListSessions(context.Background(), "", 10); err != nil || len(sessions.Items) != 1 {
		t.Fatal("副本异常掩盖了历史")
	}
	m.store.setRecordHook(nil)
	m.store.wakeRecordWorker()
	runtimeEventually(t, func() bool { return m.store.recordsFault() == nil })
	m.mu.Lock()
	_, err = m.store.change(context.Background(), run.ID, "test-resume-due", func(tx *sql.Tx, r *Run) error {
		r.Wait.NextAt = stamp(m.deps.Now().Add(-time.Second))
		return saveRun(context.Background(), tx, r)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	m.promoteContinuousWaiters()
	done := runtimeFinished(t, m, run.ID)
	if done.Status != StateSucceeded || toolCalls.Load() != 1 {
		t.Fatalf("恢复重放了工具：status=%s calls=%d", done.Status, toolCalls.Load())
	}
}

func TestContinuousThousandCallsAndRepeatedCompaction(t *testing.T) {
	var inferences, compactions, executions atomic.Int32
	var offset atomic.Int64
	base := time.Now()
	m, session, invoker := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			compactions.Add(1)
			return memoryReply(request), nil
		}
		if inferences.Add(1) <= 1000 {
			return usageReply(toolReply("docker_images_list"), 1200, 100), nil
		}
		return finalReply("已完成一千次受控检查"), nil
	}, func(d *Deps) {
		continuousDeps(d)
		d.Now = func() time.Time { return base.Add(time.Duration(offset.Load()) * time.Minute) }
	})
	invoker.execute = func(context.Context, string) (any, error) {
		executions.Add(1)
		offset.Add(1)
		return strings.Repeat("x", 2600), nil
	}
	run := submitAgentTest(t, m, session, "continuous-thousand", "连续完成一千次检查")
	deadline := time.Now().Add(3 * time.Minute)
	var done Run
	for time.Now().Before(deadline) {
		done, _ = m.Get(context.Background(), run.ID)
		if terminal(done.Status) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if done.Status != StateSucceeded || executions.Load() != 1000 || done.Usage.Tokens < 196608 || done.Usage.ResultBytes < 2*1024*1024 || done.ActiveMilliseconds < 600000 || compactions.Load() < 3 {
		t.Fatalf("长循环提前结束：state=%s reason=%s executions=%d usage=%+v active=%d compactions=%d", done.Status, done.EndReason, executions.Load(), done.Usage, done.ActiveMilliseconds, compactions.Load())
	}
}

func TestMissingOrBlankStoreWithRecordEvidenceDoesNotCreateEmptyHistory(t *testing.T) {
	for _, mode := range []string{"missing", "zero", "logical-empty", "wal"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "harness.sqlite")
			if mode == "logical-empty" {
				db, err := sql.Open("sqlite", path)
				if err != nil {
					t.Fatal(err)
				}
				db.Exec("CREATE TABLE runs(id TEXT)")
				db.Close()
			} else if mode == "zero" {
				os.WriteFile(path, nil, 0600)
			}
			if mode == "wal" {
				os.WriteFile(path+"-wal", []byte("original"), 0600)
			} else {
				os.MkdirAll(filepath.Join(root, "agent-records", "sessions"), 0700)
				os.WriteFile(filepath.Join(root, "agent-records", "sessions", "history.jsonl"), []byte("evidence\n"), 0600)
			}
			opened, err := openStore(path, time.Now)
			if err == nil {
				opened.close()
				t.Fatal("静默创建替代空库")
			}
		})
	}
}

func TestTaskHistoryIsBoundedAndTaskScoped(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	_, task, run := sessionStoreFixture(t, s, "history", runtimeStoreTestTime)
	run = acceptSessionTestRun(t, s, task, run, true)
	_, otherTask, otherRun := sessionStoreFixture(t, s, "other", runtimeStoreTestTime)
	otherRun = acceptSessionTestRun(t, s, otherTask, otherRun, true)
	if _, err := s.change(context.Background(), run.ID, "history-events", func(tx *sql.Tx, r *Run) error {
		for i := 0; i < 30; i++ {
			if err := s.event(context.Background(), tx, r, "test/fact", "", nil, map[string]string{"detail": strings.Repeat("a", 2000)}); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	page, err := readTaskHistory(context.Background(), s.db, task.ID, json.RawMessage(`{}`))
	data, _ := json.Marshal(page)
	if err != nil || len(page.Items) == 0 || len(page.Items) > 20 || len(data) > 16384 || !page.HasMore {
		t.Fatalf("未限制历史大小：%d %d %v", len(page.Items), len(data), err)
	}
	next, err := readTaskHistory(context.Background(), s.db, task.ID, json.RawMessage(`{"cursor":"`+page.NextCursor+`"}`))
	if err != nil || len(next.Items) == 0 || bytes.Equal(page.Items[0], next.Items[0]) {
		t.Fatal("历史游标未前进", err)
	}
	hidden, err := readTaskHistory(context.Background(), s.db, task.ID, json.RawMessage(`{"reference":"`+otherRun.ID+`:1"}`))
	if err != nil || len(hidden.Items) != 0 {
		t.Fatal("读取了其他任务证据")
	}
}
