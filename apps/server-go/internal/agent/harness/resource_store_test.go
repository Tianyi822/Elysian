package harness

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func TestResourceWaiterPromotesWithoutConsumingApprovalOrBudget(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	m := &Manager{store: s, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}, wake: make(chan struct{}, 1)}
	r := createRuntimeTestRun(t, s, "resource-wait", runtimeStoreTestTime)
	claim := ResourceClaim{Kind: "filesystem", Authority: "local", Key: "/shared", Access: "write", Subtree: true}
	o := Operation{ID: "waiting-operation", RunID: r.ID, TaskID: r.TaskID, Status: StateWaitingApproval, ApprovalID: "approved-operation", ResourceClaims: []ResourceClaim{claim}, Capability: Capability{Source: "mcp-tool"}}
	a := Approval{ID: o.ApprovalID, RunID: r.ID, OperationID: o.ID, Status: "approved", Operation: o}
	_, err := s.change(ctx, r.ID, "resource-fixture", func(tx *sql.Tx, current *Run) error {
		current.Status = StateWaitingResource
		current.Resume = &RecoveryCursor{ResponseID: "saved-model-response", CallIndex: 1}
		current.Usage.Calls = 2
		if err := saveOperation(ctx, tx, o); err != nil {
			return err
		}
		if err := saveApproval(ctx, tx, a); err != nil {
			return err
		}
		if err := saveResourceLease(ctx, tx, ResourceLease{ID: "holder", OperationID: "holder", State: "held", Claims: []ResourceClaim{claim}}); err != nil {
			return err
		}
		if err := saveResourceLease(ctx, tx, ResourceLease{ID: o.ID, OperationID: o.ID, RunID: r.ID, State: "waiting", Claims: o.ResourceClaims}); err != nil {
			return err
		}
		return saveRun(ctx, tx, current)
	})
	if err != nil {
		t.Fatal(err)
	}
	if n, err := m.promoteResourceWaiters(ctx); err != nil || n != 0 {
		t.Fatalf("conflicting waiter promoted: %d %v", n, err)
	}
	if err := s.write(ctx, "release-holder", func(tx *sql.Tx) error {
		return settleResourceLease(ctx, tx, "holder", stamp(runtimeStoreTestTime), false, "", "")
	}); err != nil {
		t.Fatal(err)
	}
	if n, err := m.promoteResourceWaiters(ctx); err != nil || n != 1 {
		t.Fatalf("available waiter not promoted: %d %v", n, err)
	}
	got, err := s.get(ctx, r.ID)
	if err != nil || got.Status != StateQueued || got.Usage.Calls != 2 || got.Resume == nil || got.Resume.CallIndex != 1 {
		t.Fatalf("promotion changed execution facts: %+v %v", got, err)
	}
	if err := s.write(ctx, "inspect-waiter", func(tx *sql.Tx) error {
		approvals, err := readApprovalTx(ctx, tx, r.ID)
		if err != nil {
			return err
		}
		if len(approvals) != 1 || approvals[0].Status != "approved" || digestJSON(approvals[0].Operation) != digestJSON(o) {
			t.Fatalf("promotion consumed or changed approval: %+v", approvals)
		}
		leases, err := readDocuments[ResourceLease](ctx, tx, "SELECT document FROM resource_leases WHERE id=?", o.ID)
		if err == nil && (len(leases) != 1 || leases[0].State != "waiting") {
			t.Fatalf("promotion acquired lease early: %+v", leases)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCancelResourceWaiterReleasesOnlyWaitingLease(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	m := &Manager{store: s, deps: Deps{Now: func() time.Time { return runtimeStoreTestTime }}, wake: make(chan struct{}, 1)}
	r := createRuntimeTestRun(t, s, "resource-cancel", runtimeStoreTestTime)
	_, err := s.change(ctx, r.ID, "resource-fixture", func(tx *sql.Tx, current *Run) error {
		current.Status = StateWaitingResource
		for _, state := range []string{"waiting", "unknown"} {
			if err := saveResourceLease(ctx, tx, ResourceLease{ID: state, RunID: r.ID, State: state}); err != nil {
				return err
			}
		}
		return saveRun(ctx, tx, current)
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := m.Cancel(ctx, r.ID)
	if err != nil || got.Status != StateCancelled {
		t.Fatalf("resource waiter not cancelled: %+v %v", got, err)
	}
	leases, err := m.ResourceLeases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, lease := range leases {
		if lease.ID == "waiting" && lease.State != "released" || lease.ID == "unknown" && lease.State != "unknown" {
			t.Fatalf("wrong cancellation lease result: %+v", lease)
		}
	}
}
