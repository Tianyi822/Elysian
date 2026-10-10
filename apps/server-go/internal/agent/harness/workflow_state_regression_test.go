package harness

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestWorkflowStateCancelWaitingAndQueuedClosesAttemptAndSession(t *testing.T) {
	for _, kind := range []string{"operation", "approval"} {
		for _, state := range []string{StateWaitingApproval, StateQueued} {
			t.Run(kind+"/"+state, func(t *testing.T) {
				ctx := context.Background()
				var calls atomic.Int32
				m, source := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
					calls.Add(1)
					return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
				}})
				steps := workflowOneOperation("test_write")
				if kind == "approval" {
					steps[0].Kind, steps[0].Capability, steps[0].Instruction = "approval", "", "确认本次工作流"
				}
				w := workflowStepsTest(t, m, source, steps)
				w = workflowWait(t, m, w.ID, StateWaitingApproval)
				approval := waitingApproval(t, m, w.ActiveRunID)
				workflowIdle(t, m)
				runID := w.ActiveRunID
				var release func()
				var blocker Run
				if state == StateQueued {
					// 用另一真实排队任务占住唯一执行槽，留下已批准但尚未派发的窗口。
					entered, stop := make(chan struct{}), make(chan struct{})
					var once sync.Once
					release = func() { once.Do(func() { close(stop) }) }
					t.Cleanup(release)
					m.mu.Lock()
					m.deps.Tools.(*agentTestTools).execute = func(ctx context.Context, _ string) (any, error) {
						close(entered)
						select {
						case <-stop:
							return map[string]any{"released": true}, nil
						case <-ctx.Done():
							return nil, ctx.Err()
						}
					}
					m.mu.Unlock()
					blocker = runtimeSubmit(t, m, "cancel-workflow-blocker", "docker_policy_view")
					select {
					case <-entered:
					case <-time.After(5 * time.Second):
						t.Fatal("等待占位任务进入执行槽超时")
					}
					if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
						t.Fatal(err)
					}
					w = workflowWait(t, m, w.ID, StateQueued)
				}
				cancelled, err := m.CancelWorkflow(ctx, w.ID)
				if err != nil || cancelled.Status != StateCancelled || cancelled.CancelRequestedAt == "" || cancelled.EndedAt == "" {
					t.Fatalf("取消未同步返回工作流终态：%+v %v", cancelled, err)
				}
				run, err := m.Get(ctx, runID)
				if err != nil || run.Status != StateCancelled || run.EndReason != "cancelled" || run.CancelRequestedAt != cancelled.CancelRequestedAt || run.EndedAt == "" {
					t.Fatalf("取消未同步结束原Run：%+v %v", run, err)
				}
				m.mu.Lock()
				attempt, err := readWorkflowAttempt(ctx, m.store.db, runID)
				m.mu.Unlock()
				if err != nil || attempt.Status != StateCancelled || attempt.EndedAt != run.EndedAt || attempt.EventSeq == "" || attempt.OutputJSON != "" || attempt.OutputCallID != "" {
					t.Fatalf("取消未同步结束Attempt或伪造完成凭据：%+v %v", attempt, err)
				}
				session, err := m.GetSession(ctx, w.SessionID)
				if err != nil || session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
					t.Fatalf("取消未释放专用会话：%+v %v", session, err)
				}
				approvals, err := m.Approvals(ctx)
				if err != nil {
					t.Fatal(err)
				}
				found := false
				for _, actual := range approvals {
					if actual.ID == approval.ID {
						found = true
						if actual.Status != "revoked" {
							t.Fatalf("取消后审批仍有效：%+v", actual)
						}
					}
				}
				if !found || calls.Load() != 0 {
					t.Fatalf("取消丢失审批或已派发操作：found=%v calls=%d", found, calls.Load())
				}
				if release != nil {
					release()
					if other := runtimeFinished(t, m, blocker.ID); other.Status != StateSucceeded {
						t.Fatalf("取消误伤其他任务：%+v", other)
					}
				}
				m = reopenOperationManager(t, m)
				if restored := workflowWait(t, m, w.ID, StateCancelled); len(restored.AllowedActions) != 0 || calls.Load() != 0 {
					t.Fatalf("重启复活已取消流程：%+v calls=%d", restored, calls.Load())
				}
			})
		}
	}
}

func TestWorkflowStateAllowedActionsFollowBarrierResolution(t *testing.T) {
	for _, decision := range []string{"confirmed-stopped", "confirmed-completed"} {
		t.Run(decision, func(t *testing.T) {
			ctx := context.Background()
			var calls atomic.Int32
			m, source := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				calls.Add(1)
				return CapabilityResult{Unknown: true}, nil
			}})
			w := workflowStepsTest(t, m, source, workflowOneOperation("test_write"))
			w = workflowWait(t, m, w.ID, StateWaitingApproval)
			approval := waitingApproval(t, m, w.ActiveRunID)
			if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
				t.Fatal(err)
			}
			w = workflowWait(t, m, w.ID, StateRecoveryRequired)
			workflowIdle(t, m)
			w, err := m.GetWorkflow(ctx, w.ID)
			if err != nil || len(w.AllowedActions) != 0 {
				t.Fatalf("未核实屏障仍提供恢复动作：%+v %v", w, err)
			}
			barriers, err := m.Barriers(ctx)
			if err != nil || len(barriers) != 1 || barriers[0].Status != "unknown" {
				t.Fatalf("缺少未确认屏障：%+v %v", barriers, err)
			}
			if _, err = m.Reconcile(ctx, barriers[0].ID, "已核对宿主业务记录与操作完成凭据", decision); err != nil {
				t.Fatal(err)
			}
			m = reopenOperationManager(t, m)
			w, err = m.GetWorkflow(ctx, w.ID)
			want := []string{"retry"}
			if decision == "confirmed-completed" {
				want = append(want, "accept-result")
			}
			if err != nil || !reflect.DeepEqual(w.AllowedActions, want) {
				t.Fatalf("动作没有反映当前核实结果：got=%v want=%v err=%v", w.AllowedActions, want, err)
			}
			input := WorkflowRecoveryInput{RequestID: "resolve-state-test", ExpectedRevision: w.Revision, Action: "accept-result", Evidence: "人工核实结果作为新完成凭据", OutputJSON: `{"ok":true}`}
			if decision == "confirmed-stopped" {
				_, _, err = m.RecoverWorkflow(ctx, w.ID, input)
				runtimeErrorCode(t, err, "resolution-conflict")
				input.RequestID, input.Action, input.OutputJSON = "retry-state-test", "retry", ""
				if _, _, err = m.RecoverWorkflow(ctx, w.ID, input); err != nil {
					t.Fatal(err)
				}
				w = workflowWait(t, m, w.ID, StateWaitingApproval)
				next := waitingApproval(t, m, w.ActiveRunID)
				if next.ID == approval.ID || next.OperationID == approval.OperationID || calls.Load() != 1 {
					t.Fatal("重试复用了旧审批或绕过新审批")
				}
			} else {
				resolved, _, err := m.RecoverWorkflow(ctx, w.ID, input)
				if err != nil || resolved.Status != StateSucceeded || resolved.OutputJSON != input.OutputJSON || calls.Load() != 1 {
					t.Fatalf("获准补录不能实际完成：%+v calls=%d err=%v", resolved, calls.Load(), err)
				}
			}
		})
	}
}
