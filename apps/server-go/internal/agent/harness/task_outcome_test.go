package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/tools"
)

func domainOutcomeFixture(t *testing.T, suffix string) (*Manager, Operation, ExecutionBarrier) {
	t.Helper()
	s, _ := openRuntimeTestStore(t)
	m := &Manager{store: s, ctx: context.Background(), deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}, wake: make(chan struct{}, 1)}
	r := createRuntimeTestRun(t, s, suffix, runtimeStoreTestTime)
	o := Operation{ID: "op-" + suffix, RunID: r.ID, TaskID: r.TaskID, Status: StateWaitingTask, CallID: "call-" + suffix, Task: &tools.TaskReference{Domain: "test-domain", ID: "task-" + suffix, RequestID: "request-" + suffix}, ResourceClaims: []ResourceClaim{{Kind: "docker-container", Authority: "local", Key: strings.Repeat("c", 64), Access: "write"}}}
	b := ExecutionBarrier{ID: "barrier-" + suffix, OperationID: o.ID, RunID: r.ID, Status: "dispatched"}
	_, err := s.change(m.ctx, r.ID, "fixture", func(tx *sql.Tx, r *Run) error {
		r.Status = StateWaitingTask
		r.Usage.Calls = 1
		if err := saveOperation(m.ctx, tx, o); err != nil {
			return err
		}
		if err := saveCall(m.ctx, tx, Call{ID: o.CallID, OperationID: o.ID, RunID: r.ID, Status: StateRunning, ReservedResultBytes: r.Limits.ResultBytes}); err != nil {
			return err
		}
		if err := saveBarrier(m.ctx, tx, b); err != nil {
			return err
		}
		if err := saveResourceLease(m.ctx, tx, ResourceLease{ID: o.ID, OperationID: o.ID, RunID: r.ID, State: "held", Claims: o.ResourceClaims}); err != nil {
			return err
		}
		return saveRun(m.ctx, tx, r)
	})
	if err != nil {
		t.Fatal(err)
	}
	return m, o, b
}

func TestCancelledSubmissionRetainsLateAcceptanceWithoutRevivingRun(t *testing.T) {
	for _, afterGrace := range []bool{false, true} {
		t.Run(map[bool]string{false: "within-grace", true: "after-grace"}[afterGrace], func(t *testing.T) {
			started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var complete atomic.Bool
			reference := tools.TaskReference{Domain: "test-domain", ID: "late-task", RequestID: "late-request"}
			catalog := &operationCatalog{execute: func(ctx context.Context, _ Operation) (CapabilityResult, error) {
				close(started)
				<-ctx.Done()
				close(cancelled)
				<-release
				return CapabilityResult{Task: &reference}, nil
			}}
			m, session, _ := agentManager(t, operationClient(), func(d *Deps) {
				d.Catalog = catalog
				d.AgentLimits.CancelGraceSeconds = 1
				d.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
					if complete.Load() {
						return tools.TaskStatus{Outcome: tools.TaskSucceeded, Value: true}, nil
					}
					return tools.TaskStatus{Outcome: tools.TaskRunning}, nil
				}
			})
			run := submitAgentTest(t, m, session, "late-acceptance", "执行任务")
			approval := waitingApproval(t, m, run.ID)
			if _, err := m.Decide(m.ctx, approval.ID, "approved"); err != nil {
				t.Fatal(err)
			}
			awaitDeleteSignal(t, started)
			if _, err := m.Cancel(m.ctx, run.ID); err != nil {
				t.Fatal(err)
			}
			awaitDeleteSignal(t, cancelled)
			if afterGrace {
				runtimeFinished(t, m, run.ID)
			}
			close(release)
			finished := runtimeFinished(t, m, run.ID)
			runtimeEventually(t, func() bool {
				ops, _ := m.Operations(m.ctx, run.ID)
				return len(ops) == 2 && ops[1].Task != nil && *ops[1].Task == reference
			})
			complete.Store(true)
			runtimeEventually(t, func() bool {
				ops, _ := m.Operations(m.ctx, run.ID)
				return len(ops) == 2 && ops[1].Status == "completed"
			})
			current, _ := m.Get(m.ctx, run.ID)
			if current.Status != finished.Status || !terminal(current.Status) || current.Usage.Calls != finished.Usage.Calls {
				t.Fatalf("late acceptance revived or recharged Run: %+v", current)
			}
		})
	}
}

func assertDomainProtection(t *testing.T, m *Manager, o Operation, state string) {
	t.Helper()
	leases, err := m.ResourceLeases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, lease := range leases {
		if lease.ID == o.ID {
			if lease.State != state {
				t.Fatalf("lease=%+v", lease)
			}
			return
		}
	}
	t.Fatal("missing lease")
}

func TestDomainUnknownPersistsAllFactsAndLateReceiptDoesNotResume(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "active", true: "cancelled"}[cancelled], func(t *testing.T) {
			m, o, b := domainOutcomeFixture(t, "unknown")
			if cancelled {
				if _, err := m.Cancel(m.ctx, o.RunID); err != nil {
					t.Fatal(err)
				}
			}
			status := tools.TaskStatus{Outcome: tools.TaskUnknown, State: "unknown", ErrorCode: "docker-operation-unknown", Error: "操作结果未确认", Value: map[string]bool{"accepted": true}}
			if err := m.settleDomainTask(o, status); err != nil {
				t.Fatal(err)
			}
			assertDomainProtection(t, m, o, "unknown")
			current, err := m.Get(m.ctx, o.RunID)
			if err != nil {
				t.Fatal(err)
			}
			want := StateInterrupted
			if cancelled {
				want = StateCancelled
			}
			if current.Status != want {
				t.Fatalf("run=%+v", current)
			}
			barrier, err := readBarrier(m.ctx, m.store.db, b.ID)
			if err != nil || barrier.Status != "unknown" {
				t.Fatalf("barrier=%+v %v", barrier, err)
			}
			op, _ := readOperation(m.ctx, m.store.db, o.ID)
			if op.Status != "unknown" || op.Error == nil || op.Error.Code != status.ErrorCode {
				t.Fatalf("operation=%+v", op)
			}
			bytes := current.Usage.ResultBytes
			if err := m.settleDomainTask(op, status); err != nil {
				t.Fatal(err)
			}
			again, _ := m.Get(m.ctx, o.RunID)
			if again.Usage.ResultBytes != bytes {
				t.Fatal("duplicate settlement")
			}
			if err := m.settleDomainTask(op, tools.TaskStatus{Outcome: tools.TaskSucceeded, Value: map[string]bool{"done": true}}); err != nil {
				t.Fatal(err)
			}
			assertDomainProtection(t, m, o, "released")
			again, _ = m.Get(m.ctx, o.RunID)
			if again.Status != want {
				t.Fatal("late receipt revived a terminal run")
			}
			calls, _ := m.Calls(m.ctx, o.RunID, "", 100)
			if len(calls.Items) != 1 || calls.Items[0].ReservedResultBytes != 0 || again.Usage.Calls != 1 || again.Usage.ResultBytes != len(calls.Items[0].Result) {
				t.Fatalf("budget=%+v calls=%+v", again.Usage, calls)
			}
		})
	}
}

func TestDomainKnownFailureReleasesLeaseAndKeepsReviewedReason(t *testing.T) {
	m, o, _ := domainOutcomeFixture(t, "failed")
	status := tools.TaskStatus{Outcome: tools.TaskFailed, State: "failed", ErrorCode: "database-container-operation-failed", Error: "数据库容器未运行，数据库变更未执行"}
	if err := m.settleDomainTask(o, status); err != nil {
		t.Fatal(err)
	}
	assertDomainProtection(t, m, o, "released")
	op, _ := readOperation(m.ctx, m.store.db, o.ID)
	if op.Error == nil || op.Error.Message != status.Error {
		t.Fatalf("%+v", op)
	}
}

func TestDomainUnknownAfterRestartSettlesFirstReceiptOnce(t *testing.T) {
	m, o, _ := domainOutcomeFixture(t, "restart-before-receipt")
	o.Status = "dispatched"
	if err := m.store.write(m.ctx, "fixture-dispatch", func(tx *sql.Tx) error { return saveOperation(m.ctx, tx, o) }); err != nil {
		t.Fatal(err)
	}
	if err := m.store.recover(m.ctx); err != nil {
		t.Fatal(err)
	}
	m.deps.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
		return tools.TaskStatus{Outcome: tools.TaskUnknown, Value: map[string]bool{"accepted": true}}, nil
	}
	m.monitorTasks()
	current, _ := m.Get(m.ctx, o.RunID)
	calls, _ := m.Calls(m.ctx, o.RunID, "", 100)
	if current.Status != StateInterrupted || len(calls.Items) != 1 || len(calls.Items[0].Result) == 0 || current.Usage.ResultBytes != len(calls.Items[0].Result) {
		t.Fatalf("recovered dispatch lost first receipt: %+v %+v", current, calls)
	}
	entries := runtimeStoreCount(t, m.store, "agent_record_outbox")
	m.monitorTasks()
	again, _ := m.Get(m.ctx, o.RunID)
	if again.Usage.ResultBytes != current.Usage.ResultBytes {
		t.Fatal("receipt was charged twice")
	}
	if runtimeStoreCount(t, m.store, "agent_record_outbox") != entries {
		t.Fatal("repeated uncertainty rewrote the durable ledger")
	}
	assertDomainProtection(t, m, o, "unknown")
}

func TestDomainObservationFailureIsBoundedButNeverProvesStop(t *testing.T) {
	m, o, _ := domainOutcomeFixture(t, "unavailable")
	now := runtimeStoreTestTime
	m.deps.Now = func() time.Time { return now }
	m.deps.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
		return tools.TaskStatus{}, errors.New("PRIVATE_ERROR")
	}
	m.monitorTasks()
	assertDomainProtection(t, m, o, "held")
	now = now.Add(31 * time.Second)
	m.monitorTasks()
	assertDomainProtection(t, m, o, "unknown")
	r, _ := m.Get(m.ctx, o.RunID)
	if r.Status != StateInterrupted || r.Error == nil || r.Error.Code != "task-observation-unavailable" || strings.Contains(r.Error.Message, "PRIVATE") {
		t.Fatalf("%+v", r)
	}
	m.deps.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
		return tools.TaskStatus{Outcome: tools.TaskSucceeded, Value: true}, nil
	}
	m.monitorTasks()
	r, _ = m.Get(m.ctx, o.RunID)
	if r.Status != StateInterrupted {
		t.Fatal("observation recovery resumed run")
	}
	assertDomainProtection(t, m, o, "released")
}

func TestTaskReconciliationPersistsIntentAndCannotBeReopened(t *testing.T) {
	m, o, b := domainOutcomeFixture(t, "reconcile")
	if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
		t.Fatal(err)
	}
	resolved := false
	m.deps.ReconcileTask = func(ctx context.Context, intent tools.TaskReconciliation) error {
		// The domain hook must be outside Manager.mu and the write transaction.
		if _, err := m.ResourceLeases(ctx); err != nil {
			t.Fatal(err)
		}
		if intent.ID != b.ID || intent.Task != *o.Task {
			t.Fatalf("identity=%+v", intent)
		}
		if !resolved {
			return errors.New("domain temporarily unavailable")
		}
		return nil
	}
	if _, err := m.Reconcile(m.ctx, b.ID, "已核实外部执行停止", "confirmed-stopped"); err == nil {
		t.Fatal("unconfirmed domain released")
	}
	assertDomainProtection(t, m, o, "unknown")
	pending, _ := readBarrier(m.ctx, m.store.db, b.ID)
	if pending.Reconciliation == nil || pending.Status != "unknown" {
		t.Fatalf("%+v", pending)
	}
	if _, err := m.Reconcile(m.ctx, b.ID, "不同证据", "confirmed-stopped"); err == nil {
		t.Fatal("decision overwritten")
	}
	// A receipt arriving during reconciliation must not bypass the domain decision.
	op, _ := readOperation(m.ctx, m.store.db, o.ID)
	if err := m.settleDomainTask(op, tools.TaskStatus{Outcome: tools.TaskSucceeded}); err != nil {
		t.Fatal(err)
	}
	assertDomainProtection(t, m, o, "unknown")
	resolved = true
	m.retryReconciliations()
	assertDomainProtection(t, m, o, "released")
	if _, err := m.Reconcile(m.ctx, b.ID, "已核实外部执行停止", "confirmed-stopped"); err != nil {
		t.Fatal(err)
	}
	if err := m.settleDomainTask(op, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
		t.Fatal(err)
	}
	barrier, _ := readBarrier(m.ctx, m.store.db, b.ID)
	if barrier.Status != "reconciled" {
		t.Fatal("late observation reopened protection")
	}
	r, _ := m.Get(m.ctx, o.RunID)
	if r.Status != StateInterrupted {
		t.Fatal("reconciliation resumed run")
	}
}

func TestUnknownResourceBlockerInterruptsUndispatchedWaiter(t *testing.T) {
	m, owner, _ := domainOutcomeFixture(t, "owner")
	if err := m.settleDomainTask(owner, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
		t.Fatal(err)
	}
	r := createRuntimeTestRun(t, m.store, "waiter", runtimeStoreTestTime)
	waiter := Operation{ID: "waiter", RunID: r.ID, TaskID: r.TaskID, Status: StateWaitingResource, ResourceClaims: append([]ResourceClaim{}, owner.ResourceClaims...), Capability: Capability{Source: "builtin", ReadOnly: true}}
	waiter.ResourceClaims[0].Access = "read"
	_, err := m.store.change(m.ctx, r.ID, "waiter", func(tx *sql.Tx, r *Run) error {
		r.Status = StateWaitingResource
		if err := saveOperation(m.ctx, tx, waiter); err != nil {
			return err
		}
		if _, err := acquireResourceLease(m.ctx, tx, waiter, stamp(runtimeStoreTestTime)); err != nil {
			return err
		}
		return saveRun(m.ctx, tx, r)
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.promoteResourceWaiters(m.ctx); err != nil {
		t.Fatal(err)
	}
	current, _ := m.Get(m.ctx, r.ID)
	if current.Status != StateInterrupted || current.Usage.Calls != 0 {
		t.Fatalf("%+v", current)
	}
	op, _ := readOperation(m.ctx, m.store.db, waiter.ID)
	fact := projectToolExecution(current, &op, nil, nil)
	if fact.Status != "not-executed" || fact.ResourceWait == nil || fact.ResourceWait.OperationID != owner.ID || fact.ResourceWait.ElapsedSeconds != 0 || !strings.Contains(toolFactContent(fact, nil), owner.ID) {
		t.Fatalf("%+v", fact)
	}
	assertDomainProtection(t, m, waiter, "released")
	assertDomainProtection(t, m, owner, "unknown")
	var n int
	if err := m.store.db.QueryRow("SELECT COUNT(*) FROM calls WHERE run_id=?", r.ID).Scan(&n); err != nil || n != 0 {
		t.Fatal("waiter was dispatched")
	}
	raw, _ := json.Marshal(fact.ResourceWait)
	if len(raw) > 2048 {
		t.Fatal("unbounded blocker")
	}
}
