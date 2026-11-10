package harness

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"

	"elysian/server/internal/agent/tools"
)

func TestTaskReconciliationCrashPointsResumeSameDecision(t *testing.T) {
	for _, stage := range []string{"intent-write", "intent-commit", "intent-copy", "domain", "completion-write", "completion-commit", "completion-copy"} {
		t.Run(stage, func(t *testing.T) {
			m, o, b := domainOutcomeFixture(t, stage)
			if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskUnknown, Value: true}); err != nil {
				t.Fatal(err)
			}
			calls, err := m.Calls(m.ctx, o.RunID, "", 100)
			if err != nil || len(calls.Items) != 1 {
				t.Fatalf("missing receipt: %+v %v", calls, err)
			}
			call := calls.Items[0]
			call.ReservedResultBytes = 1024
			if err := m.store.write(m.ctx, "reserve-unknown-receipt", func(tx *sql.Tx) error { return saveCall(m.ctx, tx, call) }); err != nil {
				t.Fatal(err)
			}
			before, _ := m.Get(m.ctx, o.RunID)
			var domainDecision *tools.TaskReconciliation
			attempts, effects := 0, 0
			injected := errors.New("injected reconciliation failure")
			m.store.beforeWrite = func(op string) error {
				if op == "reconciliation-intent" {
					if stage == "intent-write" {
						return injected
					}
					if stage == "intent-commit" {
						m.store.failNextCommit = injected
					}
				}
				if op == "reconciliation-completed" {
					if stage == "completion-write" {
						return injected
					}
					if stage == "completion-commit" {
						m.store.failNextCommit = injected
					}
				}
				return nil
			}
			if stage == "intent-copy" {
				m.store.recordHook = func(string) error { return injected }
			}
			resolver := func(_ context.Context, intent tools.TaskReconciliation) error {
				attempts++
				if stage == "domain" && attempts == 1 {
					return injected
				}
				if domainDecision != nil {
					if *domainDecision != intent {
						t.Fatal("restart changed the domain decision")
					}
					return nil
				}
				copy := intent
				domainDecision = &copy
				effects++
				if stage == "completion-copy" {
					m.store.recordHook = func(string) error { return injected }
				}
				return nil
			}
			m.deps.ReconcileTask = resolver
			_, err = m.Reconcile(m.ctx, b.ID, "管理员已核实执行结束", "confirmed-stopped")
			if stage != "completion-copy" && err == nil {
				t.Fatal("injected failure was ignored")
			}
			if (stage == "intent-write" || stage == "intent-commit" || stage == "intent-copy") && attempts != 0 {
				t.Fatal("domain ran before durable intent and healthy replica")
			}
			want := "unknown"
			if stage == "completion-copy" {
				want = "released" // Both authoritative stores committed; JSONL is repaired on reopen.
			}
			assertDomainProtection(t, m, o, want)
			path := m.store.dbPathForTest(t)
			if err := m.store.close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := openStore(path, func() time.Time { return runtimeStoreTestTime })
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = reopened.close() })
			m.store = reopened
			if err := reopened.recover(m.ctx); err != nil {
				t.Fatal(err)
			}
			// Startup retries only saved intents. An intent that never committed
			// still requires the original explicit administrator request.
			m.retryReconciliations()
			if _, err := m.Reconcile(m.ctx, b.ID, "管理员已核实执行结束", "confirmed-stopped"); err != nil {
				t.Fatal(err)
			}
			assertDomainProtection(t, m, o, "released")
			after, _ := m.Get(m.ctx, o.RunID)
			if effects != 1 || after.Status != StateInterrupted || after.Usage != before.Usage {
				t.Fatalf("replayed, resumed, or charged twice: effects=%d run=%+v", effects, after)
			}
			calls, _ = m.Calls(m.ctx, o.RunID, "", 100)
			if len(calls.Items) != 1 || calls.Items[0].ReservedResultBytes != 0 {
				t.Fatalf("reservation not settled: %+v", calls)
			}
		})
	}
}

func (s *store) dbPathForTest(t *testing.T) string {
	t.Helper()
	var seq int
	var name, path string
	if err := s.db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTaskReconciliationRejectsChangedOperationBinding(t *testing.T) {
	for _, field := range []string{"arguments", "tool", "task"} {
		t.Run(field, func(t *testing.T) {
			m, o, b := domainOutcomeFixture(t, field)
			if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
				t.Fatal(err)
			}
			attempts := 0
			m.deps.ReconcileTask = func(context.Context, tools.TaskReconciliation) error {
				attempts++
				return errors.New("domain unavailable")
			}
			if _, err := m.Reconcile(m.ctx, b.ID, "核实证据", "confirmed-stopped"); err == nil {
				t.Fatal("expected pending intent")
			}
			pending, _ := readBarrier(m.ctx, m.store.db, b.ID)
			current, _ := readOperation(m.ctx, m.store.db, o.ID)
			switch field {
			case "arguments":
				current.ArgumentsJSON = `{"changed":true}`
			case "tool":
				current.Capability.Name = "different-tool"
			case "task":
				current.Task.ID = "different-task"
			}
			if err := m.store.write(m.ctx, "changed-binding", func(tx *sql.Tx) error { return saveOperation(m.ctx, tx, current) }); err != nil {
				t.Fatal(err)
			}
			if _, err := m.completeTaskReconciliation(m.ctx, pending); err == nil || attempts != 1 {
				t.Fatal("changed binding reached domain or released protection")
			}
			assertDomainProtection(t, m, o, "unknown")
		})
	}
}
