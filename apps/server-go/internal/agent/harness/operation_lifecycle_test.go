package harness

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

type lifecycleCatalog struct {
	*operationCatalog
	closes atomic.Int32
}

func (c *lifecycleCatalog) CloseOperation(context.Context, Operation) error {
	c.closes.Add(1)
	return nil
}

func TestOperationApprovesAndLocksBeforeStartingCatalogueCheck(t *testing.T) {
	ctx := context.Background()
	var m *Manager
	var checks, business atomic.Int32
	catalog := &lifecycleCatalog{operationCatalog: &operationCatalog{}}
	catalog.check = func(_ context.Context, o Operation) error {
		checks.Add(1)
		m.mu.Lock()
		defer m.mu.Unlock()
		leases, err := readDocuments[ResourceLease](ctx, m.store.db, "SELECT document FROM resource_leases WHERE operation_id=?", o.ID)
		if err != nil || len(leases) != 1 || leases[0].State != "held" {
			t.Errorf("catalogue process started without held lifecycle lease: %+v %v", leases, err)
		}
		approvals, err := readDocuments[Approval](ctx, m.store.db, "SELECT document FROM approvals WHERE id=?", o.ApprovalID)
		if err != nil || len(approvals) != 1 || approvals[0].Status != "consumed" {
			t.Errorf("catalogue process started before approval consumption: %+v %v", approvals, err)
		}
		if o.Status != "dispatched" || o.DispatchID == "" {
			t.Errorf("catalogue process lacks durable dispatch identity: %+v", o)
		}
		return bad("mcp-catalog-changed", "目录变化")
	}
	catalog.execute = func(context.Context, Operation) (CapabilityResult, error) {
		business.Add(1)
		return CapabilityResult{Value: json.RawMessage(`{}`)}, nil
	}
	var session Session
	m, session, _ = agentManager(t, operationClient(), func(d *Deps) { d.Catalog = catalog })
	run := submitAgentTest(t, m, session, "catalogue-lifecycle", "执行操作")
	approval := waitingApproval(t, m, run.ID)
	if checks.Load() != 0 {
		t.Fatal("pending approval started a remote catalogue process")
	}
	if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.EndReason != "mcp-catalog-changed" || got.Usage.Calls != 2 || checks.Load() != 1 || business.Load() != 0 {
		t.Fatalf("failed catalogue check executed business or reset budget: %+v", got)
	}
	leases, err := m.ResourceLeases(ctx)
	if err != nil || len(leases) != 2 || leases[0].State != "released" || leases[1].State != "released" {
		t.Fatalf("confirmed process stop did not release lease: %+v %v", leases, err)
	}
	barriers, err := m.Barriers(ctx)
	if err != nil || len(barriers) != 1 || barriers[0].Status != "confirmed" {
		t.Fatalf("catalogue failure lost lifecycle barrier: %+v %v", barriers, err)
	}
}

func TestResourceConflictDoesNotStartAnotherCatalogueGeneration(t *testing.T) {
	ctx := context.Background()
	entered, release := make(chan struct{}), make(chan struct{})
	var checks atomic.Int32
	catalog := &operationCatalog{check: func(ctx context.Context, _ Operation) error {
		if checks.Add(1) == 1 {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	}}
	m, firstSession, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = catalog; d.Limits.Concurrency = 2 })
	secondSession, err := m.CreateSession(ctx, CreateSessionInput{Title: "第二会话", ModelProfileID: firstSession.ModelProfileID, ModelRevision: firstSession.ModelRevision})
	if err != nil {
		t.Fatal(err)
	}
	first := submitAgentTest(t, m, firstSession, "lease-holder", "执行操作")
	a := waitingApproval(t, m, first.ID)
	if _, err := m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("approved holder did not start its catalogue check")
	}
	second := submitAgentTest(t, m, secondSession, "lease-waiter", "执行操作")
	a = waitingApproval(t, m, second.ID)
	if _, err := m.Decide(ctx, a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool { r, err := m.Get(ctx, second.ID); return err == nil && r.Status == StateWaitingResource })
	if checks.Load() != 1 {
		t.Fatal("conflicting resource waiter started a stdio generation")
	}
	close(release)
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatalf("holder failed: %+v", got)
	}
	if got := runtimeFinished(t, m, second.ID); got.Status != StateSucceeded || got.Usage.Calls != 2 {
		t.Fatalf("waiter did not resume exactly once: %+v", got)
	}
	if checks.Load() != 2 {
		t.Fatalf("catalogue check replayed: %d", checks.Load())
	}
}
