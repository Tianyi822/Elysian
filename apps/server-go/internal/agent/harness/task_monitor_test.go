package harness

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

type uncertainTaskCatalog struct{ operationCatalog }

func (c *uncertainTaskCatalog) Snapshot(ctx context.Context, env Environment) (CapabilitySnapshot, error) {
	s, err := c.operationCatalog.Snapshot(ctx, env)
	for i := range s.Tools {
		if s.Tools[i].Name == "test_write" {
			s.Tools[i].Metadata = tools.Metadata{Async: true, TaskDomain: "test-domain", TaskRequestArgument: "requestId"}
		}
	}
	return s, err
}

func TestUnknownSubmissionReconcilesByStableRequestWithoutReplay(t *testing.T) {
	ctx := context.Background()
	var submissions atomic.Int32
	var complete atomic.Bool
	reference := tools.TaskReference{Domain: "test-domain", ID: "accepted-before-timeout", RequestID: "stable-request"}
	catalog := &uncertainTaskCatalog{operationCatalog: operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		submissions.Add(1)
		return CapabilityResult{Unknown: true}, bad("receipt-lost", "接受回执中断")
	}}}
	client := operationClient()
	m, session, _ := agentManager(t, func(ctx context.Context, p model.Profile, r model.Request) (model.Response, error) {
		response, err := client(ctx, p, r)
		for i := range response.ToolCalls {
			if response.ToolCalls[i].Name == "test_write" {
				response.ToolCalls[i].Arguments = json.RawMessage(`{"requestId":"stable-request"}`)
			}
		}
		return response, err
	}, func(d *Deps) {
		d.Catalog = catalog
		d.LookupTask = func(_ context.Context, ref tools.TaskReference) (tools.TaskReference, error) {
			if ref.RequestID != reference.RequestID {
				t.Errorf("unstable request identity: %+v", ref)
			}
			return reference, nil
		}
		d.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
			return tools.TaskStatus{Terminal: complete.Load(), State: "succeeded", Value: map[string]bool{"accepted": true}}, nil
		}
	})
	run := submitAgentTest(t, m, session, "uncertain-submit", "核实丢失的提交回执")
	approval := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status == StateSucceeded {
		t.Fatal("lost receipt was presented as confirmed success")
	}
	runtimeEventually(t, func() bool {
		operations, err := m.Operations(ctx, run.ID)
		return err == nil && len(operations) == 2 && operations[1].Task != nil && *operations[1].Task == reference
	})
	m = reopenOperationManager(t, m)
	complete.Store(true)
	runtimeEventually(t, func() bool {
		operations, err := m.Operations(ctx, run.ID)
		return err == nil && len(operations) == 2 && operations[1].Status == "completed"
	})
	if submissions.Load() != 1 {
		t.Fatalf("unknown submission replayed %d times", submissions.Load())
	}
	current, err := m.Get(ctx, run.ID)
	if err != nil || current.Status != finished.Status {
		t.Fatalf("reconciliation resumed a stopped run: %+v %v", current, err)
	}
}

func TestDurableDomainTaskSurvivesRestartWithoutResubmission(t *testing.T) {
	ctx := context.Background()
	var submissions atomic.Int32
	var complete atomic.Bool
	reference := tools.TaskReference{Domain: "test-domain", ID: "domain-task", RequestID: "fixed-request"}
	catalog := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		submissions.Add(1)
		return CapabilityResult{Value: json.RawMessage(`{"accepted":true}`), Task: &reference}, nil
	}}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Catalog = catalog
		d.InspectTask = func(_ context.Context, ref tools.TaskReference) (tools.TaskStatus, error) {
			if ref != reference {
				t.Errorf("task identity changed: %+v", ref)
			}
			return tools.TaskStatus{State: "succeeded", Terminal: complete.Load(), Value: map[string]any{"finished": true}}, nil
		}
	})
	run := submitAgentTest(t, m, session, "durable-task", "执行异步任务")
	approval := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		current, err := m.Get(ctx, run.ID)
		return err == nil && current.Status == StateWaitingTask
	})
	leases, err := m.ResourceLeases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	held := false
	for _, lease := range leases {
		if lease.RunID == run.ID && lease.State == "held" {
			held = true
		}
	}
	if !held {
		t.Fatal("accepted task released resource lease before completion")
	}
	m = reopenOperationManager(t, m)
	current, err := m.Get(ctx, run.ID)
	if err != nil || current.Status != StateWaitingTask {
		t.Fatalf("restart lost waiting task: %+v %v", current, err)
	}
	if submissions.Load() != 1 {
		t.Fatalf("restart resubmitted task: %d", submissions.Load())
	}
	complete.Store(true)
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded || submissions.Load() != 1 {
		t.Fatalf("domain task did not resume exactly once: %+v count=%d", finished, submissions.Load())
	}
	leases, err = m.ResourceLeases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, lease := range leases {
		if lease.RunID == run.ID && (lease.State == "held" || lease.State == "unknown") {
			t.Fatalf("settled task retained lease: %+v", lease)
		}
	}
}

func TestCancelledRunKeepsAcceptedDomainTaskUntilTerminal(t *testing.T) {
	ctx := context.Background()
	var complete atomic.Bool
	reference := tools.TaskReference{Domain: "test-domain", ID: "cancelled-run-task", RequestID: "fixed-request"}
	catalog := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		return CapabilityResult{Task: &reference}, nil
	}}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Catalog = catalog
		d.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
			return tools.TaskStatus{Terminal: complete.Load(), State: "succeeded", Value: map[string]bool{"finished": true}}, nil
		}
	})
	run := submitAgentTest(t, m, session, "cancel-durable", "停止对话后保留任务事实")
	approval := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		current, err := m.Get(ctx, run.ID)
		return err == nil && current.Status == StateWaitingTask
	})
	if _, err := m.Cancel(ctx, run.ID); err != nil {
		t.Fatal(err)
	}
	operations, err := m.Operations(ctx, run.ID)
	if err != nil || len(operations) != 2 || operations[1].Status != StateWaitingTask {
		t.Fatalf("run stop lost domain tracking: %+v %v", operations, err)
	}
	complete.Store(true)
	runtimeEventually(t, func() bool {
		operations, err := m.Operations(ctx, run.ID)
		return err == nil && len(operations) == 2 && operations[1].Status == "completed"
	})
	current, err := m.Get(ctx, run.ID)
	if err != nil || current.Status != StateCancelled {
		t.Fatalf("domain completion resumed cancelled conversation: %+v %v", current, err)
	}
}

func TestDomainTaskWorkflowResultBudgetSettlesOnce(t *testing.T) {
	for _, accepted := range []bool{false, true} {
		t.Run(map[bool]string{false: "unknown-receipt", true: "accepted-receipt"}[accepted], func(t *testing.T) {
			ctx := context.Background()
			var complete atomic.Bool
			reference := tools.TaskReference{Domain: "test-domain", ID: "workflow-domain-task", RequestID: "workflow-stable-request"}
			partial := json.RawMessage(`{"accepted":true}`)
			final := map[string]any{"finished": true, "result": "durable"}
			finalJSON, _ := json.Marshal(final)
			catalog := &uncertainTaskCatalog{operationCatalog: operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				if accepted {
					return CapabilityResult{Value: partial, Task: &reference}, nil
				}
				return CapabilityResult{Value: partial, Unknown: true}, bad("receipt-lost", "提交回执中断")
			}}}
			m, source, _ := agentManager(t, operationClient(), func(d *Deps) {
				d.Catalog = catalog
				if accepted {
					d.Catalog = &catalog.operationCatalog
				}
				d.LookupTask = func(context.Context, tools.TaskReference) (tools.TaskReference, error) { return reference, nil }
				d.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
					return tools.TaskStatus{State: "succeeded", Terminal: complete.Load(), Value: final}, nil
				}
			})
			steps := workflowOneOperation("test_write")
			steps[0].Input = workflowLiteral(`{"requestId":"workflow-stable-request"}`)
			workflow := workflowStepsTest(t, m, source, steps)
			workflow = workflowWait(t, m, workflow.ID, StateWaitingApproval)
			approval := waitingApproval(t, m, workflow.ActiveRunID)
			if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
				t.Fatal(err)
			}
			beforeState := StateRecoveryRequired
			if accepted {
				beforeState = StateWaitingTask
			}
			workflowWait(t, m, workflow.ID, beforeState)
			workflowIdle(t, m)
			runtimeEventually(t, func() bool {
				operations, err := m.Operations(ctx, approval.RunID)
				return err == nil && len(operations) == 1 && operations[0].Task != nil && *operations[0].Task == reference
			})
			complete.Store(true)
			runtimeEventually(t, func() bool {
				operations, err := m.Operations(ctx, approval.RunID)
				return err == nil && len(operations) == 1 && operations[0].Status == "completed" && operations[0].Error == nil
			})
			workflow, err := m.GetWorkflow(ctx, workflow.ID)
			if err != nil || workflow.Usage.ResultBytes != len(finalJSON) {
				t.Fatalf("workflow result budget settled twice: %+v err=%v wantBytes=%d", workflow.Usage, err, len(finalJSON))
			}
			run, err := m.Get(ctx, approval.RunID)
			if err != nil || run.Usage.ResultBytes != len(finalJSON) {
				t.Fatalf("run result was not replaced: %+v err=%v", run.Usage, err)
			}
			calls, err := m.Calls(ctx, run.ID, "", 10)
			if err != nil || len(calls.Items) != 1 || calls.Items[0].Error != nil || calls.Items[0].Status != StateSucceeded {
				t.Fatalf("confirmed task kept stale unknown error: %+v err=%v", calls.Items, err)
			}
			wantState := StateRecoveryRequired
			if accepted {
				wantState = StateSucceeded
			}
			if workflow.Status != wantState {
				t.Fatalf("workflow state=%s want=%s", workflow.Status, wantState)
			}
		})
	}
}

type uncertainCancellationCatalog struct{ operationCatalog }

func (c *uncertainCancellationCatalog) Snapshot(ctx context.Context, env Environment) (CapabilitySnapshot, error) {
	snapshot, err := c.operationCatalog.Snapshot(ctx, env)
	for i := range snapshot.Tools {
		if snapshot.Tools[i].Name == "test_write" {
			snapshot.Tools[i].Metadata = tools.Metadata{Async: true, TaskDomain: "test-domain", TaskIDArgument: "taskId"}
		}
	}
	return snapshot, err
}

func TestUnknownCancellationReconcilesFromKnownTaskID(t *testing.T) {
	ctx := context.Background()
	var lookups atomic.Int32
	reference := tools.TaskReference{Domain: "test-domain", ID: "cancel-target-task", RequestID: "original-submit-request"}
	catalog := &uncertainCancellationCatalog{operationCatalog: operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		return CapabilityResult{Unknown: true}, bad("receipt-lost", "取消回执中断")
	}}}
	client := operationClient()
	m, session, _ := agentManager(t, func(ctx context.Context, profile model.Profile, request model.Request) (model.Response, error) {
		response, err := client(ctx, profile, request)
		for i := range response.ToolCalls {
			if response.ToolCalls[i].Name == "test_write" {
				response.ToolCalls[i].Arguments = json.RawMessage(`{"taskId":"cancel-target-task"}`)
			}
		}
		return response, err
	}, func(d *Deps) {
		d.Catalog = catalog
		d.LookupTask = func(_ context.Context, ref tools.TaskReference) (tools.TaskReference, error) {
			if ref.ID != reference.ID || ref.RequestID != "" {
				t.Errorf("cancel identity changed before lookup: %+v", ref)
			}
			lookups.Add(1)
			return reference, nil
		}
		d.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
			return tools.TaskStatus{Terminal: true, State: "cancelled", Failed: true, Value: map[string]bool{"cancelled": true}}, nil
		}
	})
	run := submitAgentTest(t, m, session, "cancel-lost-receipt", "核对取消结果")
	approval := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, run.ID)
	runtimeEventually(t, func() bool {
		operations, err := m.Operations(ctx, run.ID)
		return err == nil && len(operations) == 2 && operations[1].Status == "completed" && operations[1].Task != nil && *operations[1].Task == reference
	})
	if lookups.Load() != 1 {
		t.Fatalf("known cancellation target lookup count=%d", lookups.Load())
	}
}
