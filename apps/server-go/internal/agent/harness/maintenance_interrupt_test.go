package harness

import (
	"context"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

func TestUpdateInterruptsActiveAndQueuedChatsWithoutAutomaticResume(t *testing.T) {
	var updating atomic.Bool
	var requests atomic.Int32
	entered := make(chan struct{}, 1)
	m, firstSession, _ := agentManager(t, func(ctx context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if requests.Add(1) == 1 {
			entered <- struct{}{}
			<-ctx.Done()
			return model.Response{}, ctx.Err()
		}
		return finalReply("手动续接完成"), nil
	}, func(d *Deps) {
		d.DispatchGuard = func() error {
			if updating.Load() {
				return &Error{Status: 409, Code: "panel-update-active", Message: "面板更新中"}
			}
			return nil
		}
	})
	ctx := context.Background()
	active := submitAgentTest(t, m, firstSession, "before-update", "执行任务")
	<-entered
	second, err := m.CreateSession(ctx, CreateSessionInput{Title: "排队任务", ModelProfileID: firstSession.ModelProfileID, ModelRevision: firstSession.ModelRevision})
	if err != nil {
		t.Fatal(err)
	}
	queued := submitAgentTest(t, m, second, "queued-update", "稍后执行")
	updating.Store(true)
	for _, initial := range []Run{active, queued} {
		run := runtimeFinished(t, m, initial.ID)
		if run.Status != StateInterrupted || run.EndReason != "panel-update" || run.BudgetStop != nil {
			t.Fatalf("更新应保存独立中断原因: %+v", run)
		}
		if run.Continuation == nil || !run.Continuation.Allowed {
			t.Fatalf("没有外部调用的更新中断应可手动继续: %+v", run.Continuation)
		}
	}
	updating.Store(false)
	runtimeEventually(t, func() bool { return m.Info().Agent.Available })
	if requests.Load() != 1 {
		t.Fatal("排队任务在维护后被自动执行")
	}
	continued, _, err := m.ContinueTask(ctx, active.TaskID, AgentInput{RequestID: "manual-after-update", Content: "继续", ContinueFromRunID: active.ID})
	if err != nil {
		t.Fatal(err)
	}
	if run := runtimeFinished(t, m, continued.ID); run.Status != StateSucceeded {
		t.Fatalf("手动续接失败: %+v", run)
	}
}

func TestUpdateCancelsAcceptedTaskAndPreservesBarrierUntilReceipt(t *testing.T) {
	ctx := context.Background()
	var updating, complete atomic.Bool
	var submissions atomic.Int32
	cancelled := make(chan tools.TaskReference, 4)
	reference := tools.TaskReference{Domain: "test-domain", ID: "update-task", RequestID: "update-fixed-request"}
	catalog := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		submissions.Add(1)
		return CapabilityResult{Task: &reference}, nil
	}}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Catalog = catalog
		d.DispatchGuard = func() error {
			if updating.Load() {
				return &Error{Status: 409, Code: "panel-update-active", Message: "面板更新中"}
			}
			return nil
		}
		d.CancelTask = func(_ context.Context, ref tools.TaskReference) error {
			cancelled <- ref
			return nil
		}
		d.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
			return tools.TaskStatus{Terminal: complete.Load(), State: "succeeded", Value: map[string]bool{"finished": true}}, nil
		}
	})
	run := submitAgentTest(t, m, session, "update-durable-task", "执行异步任务")
	approval := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		current, _ := m.Get(ctx, run.ID)
		return current.Status == StateWaitingTask
	})
	updating.Store(true)
	if got := runtimeFinished(t, m, run.ID); got.Status != StateInterrupted || got.EndReason != "panel-update" {
		t.Fatalf("异步等待未保存更新中断: %+v", got)
	}
	runtimeEventually(t, func() bool {
		select {
		case got := <-cancelled:
			if got != reference {
				t.Fatalf("取消身份变化: %+v", got)
			}
			return true
		default:
			return false
		}
	})
	barriers, err := m.Barriers(ctx)
	if err != nil || len(barriers) != 1 || barriers[0].Status == "confirmed" {
		t.Fatalf("取消请求不能确认已派发结果: %+v %v", barriers, err)
	}
	updating.Store(false)
	complete.Store(true)
	runtimeEventually(t, func() bool {
		barriers, _ := m.Barriers(ctx)
		return len(barriers) == 1 && barriers[0].Status == "confirmed"
	})
	if got, err := m.Get(ctx, run.ID); err != nil || got.Status != StateInterrupted || submissions.Load() != 1 {
		t.Fatalf("迟到回执自动续跑或重投: %+v %v", got, err)
	}
	readRecordLines(t, m.store, recordOwner{"session", session.ID})
}

func TestUpdateInterruptsPendingQuestionsAndApprovals(t *testing.T) {
	for _, waiting := range []string{StateWaitingInput, StateWaitingApproval} {
		t.Run(waiting, func(t *testing.T) {
			var updating atomic.Bool
			var requests atomic.Int32
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				if waiting == StateWaitingApproval && !contains(toolNames(request), "test_write") {
					return searchReply("test_write"), nil
				}
				requests.Add(1)
				if waiting == StateWaitingInput {
					return userInputReply(questionFixture), nil
				}
				return toolReply("test_write"), nil
			}, func(d *Deps) {
				d.Catalog = &operationCatalog{}
				d.DispatchGuard = func() error {
					if updating.Load() {
						return &Error{Status: 409, Code: "panel-update-active", Message: "面板更新中"}
					}
					return nil
				}
			})
			run := submitAgentTest(t, m, session, "waiting-update", "准备操作")
			runtimeEventually(t, func() bool {
				got, _ := m.Get(context.Background(), run.ID)
				if terminal(got.Status) {
					t.Fatalf("等待确认前提前终止: %+v", got)
				}
				return got.Status == waiting
			})
			updating.Store(true)
			got := runtimeFinished(t, m, run.ID)
			if got.Status != StateInterrupted || got.EndReason != "panel-update" {
				t.Fatalf("待确认运行未保存更新中断: %+v", got)
			}
			updating.Store(false)
			runtimeEventually(t, func() bool { return m.Info().Agent.Available })
			if requests.Load() != 1 {
				t.Fatal("更新结束自动重跑了等待运行")
			}
			readRecordLines(t, m.store, recordOwner{"session", session.ID})
		})
	}
}
