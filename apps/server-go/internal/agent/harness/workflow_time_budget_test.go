package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

func assertWorkflowTimeBudgetFailed(t *testing.T, m *Manager, id string) WorkflowInstance {
	t.Helper()
	w := workflowWait(t, m, id, StateFailed)
	if w.Error == nil || w.Error.Code != "workflow-budget" || w.Usage.ActiveMilliseconds < w.Limits.ActiveMilliseconds || w.Usage.ReservedMilliseconds != 0 || len(w.AllowedActions) != 0 {
		t.Fatalf("活动预算耗尽未收口为不可恢复失败：%+v", w)
	}
	session, err := m.GetSession(context.Background(), w.SessionID)
	if err != nil || session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		t.Fatalf("活动预算耗尽未释放专用会话：%+v %v", session, err)
	}
	_, _, err = m.RecoverWorkflow(context.Background(), id, WorkflowRecoveryInput{RequestID: "time-budget-retry", ExpectedRevision: w.Revision, Action: "retry", Evidence: "核对耗尽记录"})
	runtimeErrorCode(t, err, "workflow-state")
	return w
}

func TestWorkflowActiveBudgetStartupSettlesCrashReservation(t *testing.T) {
	for _, state := range []string{StateRunning, StateQueued, StateWaitingApproval} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			var calls atomic.Int32
			m, source := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				calls.Add(1)
				return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
			}})
			w := workflowStepsTest(t, m, source, workflowOneOperation("test_write"))
			w = workflowWait(t, m, w.ID, StateWaitingApproval)
			workflowIdle(t, m)
			deps := m.deps
			if err := m.Close(ctx); err != nil {
				t.Fatal(err)
			}
			persisted, err := openStore(deps.Path, deps.Now)
			if err != nil {
				t.Fatal(err)
			}
			err = persisted.write(ctx, "crash-reservation-fixture", func(tx *sql.Tx) error {
				current, err := readWorkflow(ctx, tx, w.ID)
				if err != nil {
					return err
				}
				current.Status = state
				current.Usage.ActiveMilliseconds = current.Limits.ActiveMilliseconds - 100
				current.Usage.ReservedMilliseconds = 100
				if err = saveWorkflow(ctx, tx, &current); err != nil {
					return err
				}
				run, err := readRun(ctx, tx, current.ActiveRunID)
				if err != nil {
					return err
				}
				run.Status = state
				run.WorkflowActiveReserved = 100
				return persisted.event(ctx, tx, &run, "run/"+state, "", nil, nil)
			})
			closeErr := persisted.close()
			if err != nil || closeErr != nil {
				t.Fatalf("准备崩溃窗口失败：%v %v", err, closeErr)
			}
			m, err = New(deps)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = m.Close(context.Background()) })
			w = assertWorkflowTimeBudgetFailed(t, m, w.ID)
			runs := workflowAgentRuns(t, m, w.ID)
			expectedRunState := StateFailed
			if state == StateRunning {
				expectedRunState = StateInterrupted
			}
			if len(runs) != 1 || runs[0].Status != expectedRunState || runs[0].WorkflowActiveReserved != 0 || calls.Load() != 0 {
				t.Fatalf("预算失败重写旧终态或仍派发步骤：%+v calls=%d", runs, calls.Load())
			}
			m.mu.Lock()
			attempt, attemptErr := readWorkflowAttempt(ctx, m.store.db, runs[0].ID)
			approvals, approvalErr := readDocuments[Approval](ctx, m.store.db, "SELECT document FROM approvals WHERE run_id=?", runs[0].ID)
			m.mu.Unlock()
			if attemptErr != nil || attempt.Status != expectedRunState || approvalErr != nil || len(approvals) != 1 || approvals[0].Status != "revoked" {
				t.Fatalf("尝试或旧审批未结束：%+v %+v %v %v", attempt, approvals, attemptErr, approvalErr)
			}
			m = reopenOperationManager(t, m)
			after := assertWorkflowTimeBudgetFailed(t, m, w.ID)
			if after.Usage != w.Usage || calls.Load() != 0 {
				t.Fatal("再次启动重复扣账或重放步骤")
			}
		})
	}
}

func TestWorkflowActiveBudgetDeadlineFailsAndPreservesUnknownBarrier(t *testing.T) {
	ctx := context.Background()
	m, source := workflowTestManager(t, &operationCatalog{execute: func(ctx context.Context, _ Operation) (CapabilityResult, error) {
		<-ctx.Done()
		return CapabilityResult{}, ctx.Err()
	}})
	w := workflowStepsTest(t, m, source, workflowOneOperation("test_write"))
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	a := waitingApproval(t, m, w.ActiveRunID)
	workflowIdle(t, m)
	m.mu.Lock()
	err := m.store.write(ctx, "deadline-budget-fixture", func(tx *sql.Tx) error {
		current, err := readWorkflow(ctx, tx, w.ID)
		if err != nil {
			return err
		}
		current.Limits.ActiveMilliseconds = current.Usage.ActiveMilliseconds + 30
		return saveWorkflow(ctx, tx, &current)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	w = assertWorkflowTimeBudgetFailed(t, m, w.ID)
	barriers, err := m.Barriers(ctx)
	if err != nil || len(barriers) != 1 || barriers[0].Status != "unknown" || barriers[0].WorkflowID != w.ID {
		t.Fatalf("耗尽预算清除了未知执行屏障：%+v %v", barriers, err)
	}
}

func TestWorkflowNonTimeBudgetsDoNotBlockFollowingCondition(t *testing.T) {
	ctx := context.Background()
	m, source := workflowTestManager(t, &operationCatalog{})
	yes := workflowLiteral("true")
	steps := []WorkflowStepDefinition{
		{ID: "start", Kind: "approval", Instruction: "确认开始", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Next: "choose"},
		{ID: "choose", Kind: "condition", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Condition: &WorkflowCondition{Op: "eq", Left: &yes, Right: &yes}, Then: "finish", Else: "skip"},
		{ID: "finish", Kind: "approval", Instruction: "确认完成", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Finish: &WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "finish"}}},
		{ID: "skip", Kind: "approval", Instruction: "确认跳过", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Finish: &WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "skip"}}},
	}
	w := workflowStepsTest(t, m, source, steps)
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	a := waitingApproval(t, m, w.ActiveRunID)
	workflowIdle(t, m)
	m.mu.Lock()
	err := m.store.write(ctx, "exact-nontime-budgets-fixture", func(tx *sql.Tx) error {
		current, err := readWorkflow(ctx, tx, w.ID)
		if err != nil {
			return err
		}
		current.Usage.ModelRequests = current.Limits.ModelRequests
		current.Usage.Calls = current.Limits.Calls
		current.Usage.Tokens = current.Limits.Tokens
		current.Usage.ResultBytes = current.Limits.ResultBytes
		return saveWorkflow(ctx, tx, &current)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		w, err = m.GetWorkflow(ctx, w.ID)
		return err == nil && w.Status == StateWaitingApproval && w.CurrentStepID == "finish"
	})
	a = waitingApproval(t, m, w.ActiveRunID)
	if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	w = workflowWait(t, m, w.ID, StateSucceeded)
	if w.OutputJSON != `{"approved":true}` || w.Usage.ActiveMilliseconds >= int64(time.Hour/time.Millisecond) {
		t.Fatalf("无需模型和工具的后继被无关预算阻断：%+v", w)
	}
}
