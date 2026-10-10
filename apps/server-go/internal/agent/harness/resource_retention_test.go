package harness

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

func TestResourceUnknownLeasePinsWorkflowHistoryAndProbeSurvivesCleanup(t *testing.T) {
	ctx := context.Background()
	m, source := workflowTestManager(t, &operationCatalog{})
	w := createWorkflowV2Test(t, m, source, workflowV2CompositeDefinition("foreach"), `[{}]`)
	w = workflowWait(t, m, w.ID, StateSucceeded)
	var runID string
	for _, node := range w.ExecutionTree.Nodes {
		if node.RunID != "" {
			runID = node.RunID
		}
	}
	if runID == "" {
		t.Fatal("fixture missing leaf run")
	}
	m.mu.Lock()
	err := m.store.write(ctx, "resource-retention-fixture", func(tx *sql.Tx) error {
		s, err := readSession(ctx, tx, w.SessionID)
		if err != nil {
			return err
		}
		s.LastActivityAt = stamp(m.deps.Now().Add(-31 * 24 * time.Hour))
		if err = saveSession(ctx, tx, s); err != nil {
			return err
		}
		for _, lease := range []ResourceLease{{ID: "unknown-operation", RunID: runID, State: "unknown"}, {ID: "unknown-probe", Source: "mcp-probe", ScopeID: "durable-scope", ContainerID: "durable-container", State: "unknown"}} {
			if err = saveResourceLease(ctx, tx, lease); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		err = m.sweep(ctx)
	}
	if err == nil {
		_, err = readWorkflow(ctx, m.store.db, w.ID)
	}
	if err == nil {
		err = m.store.write(ctx, "confirmed-lease-fixture", func(tx *sql.Tx) error {
			return saveResourceLease(ctx, tx, ResourceLease{ID: "unknown-operation", RunID: runID, State: "released", Evidence: "外部已确认停止", Decision: "confirmed-stopped"})
		})
	}
	if err == nil {
		err = m.sweep(ctx)
	}
	var sessions int
	if err == nil {
		err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sessions WHERE id=?", w.SessionID).Scan(&sessions)
	}
	leases, leaseErr := readDocuments[ResourceLease](ctx, m.store.db, "SELECT document FROM resource_leases WHERE id='unknown-probe'")
	m.mu.Unlock()
	if err != nil || sessions != 0 {
		t.Fatalf("未决资源或已核实后的清理边界错误: %d %v", sessions, err)
	}
	if leaseErr != nil || len(leases) != 1 || leases[0].State != "unknown" || leases[0].ScopeID != "durable-scope" || leases[0].ContainerID != "durable-container" {
		t.Fatalf("任务清理丢失独立probe租约: %+v %v", leases, leaseErr)
	}
	m = reopenOperationManager(t, m)
	got, err := m.ResourceLeases(ctx)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, lease := range got {
		if lease.ID == "unknown-probe" {
			found = lease.State == "unknown"
		}
	}
	if !found {
		t.Fatal("重启清理丢失未知probe租约")
	}
}
