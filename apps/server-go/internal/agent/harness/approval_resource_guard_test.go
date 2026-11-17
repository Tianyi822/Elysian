package harness

import (
	"context"
	"database/sql"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/tools"
)

func seedApprovalUnknownBlocker(t *testing.T, m *Manager, withBarrier bool) Operation {
	t.Helper()
	ctx := context.Background()
	m.mu.Lock()
	defer m.mu.Unlock()
	r := createRuntimeTestRun(t, m.store, "old-approval-blocker", runtimeStoreTestTime)
	o := Operation{ID: "old-approval-blocker", RunID: r.ID, TaskID: r.TaskID, Status: "unknown", DispatchID: "old-dispatch", DispatchedAt: stamp(runtimeStoreTestTime), Capability: Capability{Name: "old_write", Source: "builtin"}, ResourceClaims: []ResourceClaim{{Kind: "docker-container", Authority: "local", Key: "old-container", Access: "write"}}}
	_, err := m.store.change(ctx, r.ID, "old-unknown-fixture", func(tx *sql.Tx, r *Run) error {
		r.Status, r.EndReason = StateInterrupted, "outcome-unknown"
		r.EndedAt = stamp(runtimeStoreTestTime)
		if err := saveOperation(ctx, tx, o); err != nil {
			return err
		}
		if withBarrier {
			if err := saveBarrier(ctx, tx, ExecutionBarrier{ID: "old-barrier", RunID: r.ID, OperationID: o.ID, Status: "unknown"}); err != nil {
				return err
			}
		} else if err := saveResourceLease(ctx, tx, ResourceLease{ID: o.ID, RunID: o.RunID, OperationID: o.ID, State: "unknown", Claims: o.ResourceClaims}); err != nil {
			return err
		}
		return saveRun(ctx, tx, r)
	})
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestUnknownBlockerIsReportedBeforeNewApproval(t *testing.T) {
	for _, barrier := range []bool{true, false} {
		name := "unknown-lease"
		if barrier {
			name = "legacy-barrier"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			var executions atomic.Int32
			catalog := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				executions.Add(1)
				return CapabilityResult{}, nil
			}}
			m, session, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = catalog })
			owner := seedApprovalUnknownBlocker(t, m, barrier)
			run := submitAgentTest(t, m, session, "before-approval", "执行变更")
			done := runtimeFinished(t, m, run.ID)
			if done.Status != StateInterrupted || done.EndReason != "resource-outcome-unknown" || executions.Load() != 0 || done.Usage.Calls != 1 {
				t.Fatalf("blocked operation dispatched or charged budget: %+v executions=%d", done, executions.Load())
			}
			approvals, err := m.ApprovalsByRun(ctx, "", run.ID)
			if err != nil || len(approvals) != 0 {
				t.Fatalf("known blocker requested approval: %+v %v", approvals, err)
			}
			operations, err := m.Operations(ctx, run.ID)
			if err != nil || len(operations) != 2 {
				t.Fatalf("missing blocked operation: %+v %v", operations, err)
			}
			op := operations[1]
			if op.ApprovalID != "" || op.DispatchID != "" || op.DispatchedAt != "" || op.ResourceWait == nil || !op.ResourceWait.Unknown || op.ResourceWait.RunID != owner.RunID || op.ResourceWait.OperationID != owner.ID {
				t.Fatalf("incorrect pre-approval execution facts: %+v", op)
			}
			fact := projectToolExecution(done, &op, nil, nil)
			if fact.Status != "not-executed" || fact.ResourceWait == nil {
				t.Fatalf("incorrect blocked projection: %+v", fact)
			}
			calls, err := m.Calls(ctx, run.ID, "", 50)
			if err != nil || len(calls.Items) != 1 || calls.Items[0].Tool != toolSearchName {
				t.Fatalf("undispatched operation has execution receipt: %+v %v", calls, err)
			}
			old, err := readOperation(ctx, m.store.db, owner.ID)
			if err != nil || digestJSON(old) != digestJSON(owner) {
				t.Fatalf("pre-approval check changed old protection: %+v %v", old, err)
			}
		})
	}
}

func TestUnknownBlockerAppearingDuringApprovalStillPreventsDispatch(t *testing.T) {
	ctx := context.Background()
	var executions atomic.Int32
	catalog := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		executions.Add(1)
		return CapabilityResult{}, nil
	}}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = catalog })
	run := submitAgentTest(t, m, session, "approval-race", "执行变更")
	approval := waitingApproval(t, m, run.ID)
	owner := seedApprovalUnknownBlocker(t, m, true)
	if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	done := runtimeFinished(t, m, run.ID)
	if done.EndReason != "resource-outcome-unknown" || executions.Load() != 0 || done.Usage.Calls != 1 {
		t.Fatalf("approval bypassed late unknown protection: %+v", done)
	}
	operations, err := m.Operations(ctx, run.ID)
	if err != nil || len(operations) != 2 || operations[1].DispatchedAt != "" || operations[1].ResourceWait == nil || operations[1].ResourceWait.OperationID != owner.ID {
		t.Fatalf("late blocker facts missing: %+v %v", operations, err)
	}
	approvals, err := m.ApprovalsByRun(ctx, "", run.ID)
	if err != nil || len(approvals) != 1 || approvals[0].Status != "approved" {
		t.Fatalf("blocked dispatch consumed approval: %+v %v", approvals, err)
	}
}

func TestUnknownResourcePreflightPreservesReadAndCancellationScope(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	claim := ResourceClaim{Kind: "docker-container", Authority: "local", Key: "container", Access: "write"}
	if err := s.write(ctx, "unknown-lease", func(tx *sql.Tx) error {
		return saveResourceLease(ctx, tx, ResourceLease{ID: "owner", RunID: "owner-run", OperationID: "owner", State: "unknown", Claims: []ResourceClaim{claim}})
	}); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		o    Operation
		want bool
	}{
		{"unrelated builtin read", Operation{Capability: Capability{Source: "builtin", ReadOnly: true}}, false},
		{"conflicting builtin read", Operation{Capability: Capability{Source: "builtin", ReadOnly: true}, ResourceClaims: []ResourceClaim{{Kind: claim.Kind, Authority: claim.Authority, Key: claim.Key, Access: "read"}}}, true},
		{"external write", Operation{Capability: Capability{Source: "builtin"}}, true},
		{"conflicting external write", Operation{Capability: Capability{Source: "builtin"}, ResourceClaims: []ResourceClaim{claim}}, true},
		{"async cancellation", Operation{Capability: Capability{Source: "builtin", Metadata: tools.Metadata{Async: true, Action: "cancel", TaskDomain: "domain", TaskIDArgument: "taskId"}}}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			wait, err := unknownResourceWait(ctx, s.db, test.o, stamp(runtimeStoreTestTime))
			if err != nil || (wait != nil) != test.want {
				t.Fatalf("unknown protection scope changed: %+v %v", wait, err)
			}
			if wait != nil && externalOperation(test.o) && wait.Resource != "external:*" {
				t.Fatalf("global protection stored only a concrete conflict: %+v", wait)
			}
		})
	}
}
