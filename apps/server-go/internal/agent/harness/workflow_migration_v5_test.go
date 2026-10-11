package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// Build an actual v4 database: only the old schema exists, and accepted
// Operations/approvals do not contain the resource fields introduced in v5.
func workflowV4Fixture(t *testing.T, sourcePath string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "v4.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(schema + sessionSchema + capabilitySchema + workflowSchema + "PRAGMA user_version=4;"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("ATTACH DATABASE ? AS source", sourcePath); err != nil {
		t.Fatal(err)
	}
	rows, err := db.Query("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	var tables []string
	for rows.Next() {
		var table string
		if err = rows.Scan(&table); err != nil {
			t.Fatal(err)
		}
		tables = append(tables, table)
	}
	if err = rows.Close(); err != nil {
		t.Fatal(err)
	}
	for _, table := range tables {
		if _, err = db.Exec("INSERT INTO main." + table + " SELECT * FROM source." + table); err != nil {
			t.Fatal(table, err)
		}
	}
	for _, statement := range []string{
		`UPDATE operations SET document=json_remove(document,'$.resourceClaims','$.resourceRules','$.claimsDigest')`,
		`UPDATE approvals SET document=json_remove(document,'$.operation.resourceClaims','$.operation.resourceRules','$.operation.claimsDigest')`,
		`UPDATE workflow_instances SET document=json_remove(document,'$.languageVersion','$.rootScopeId','$.definitions','$.gateClosed','$.executionTree')`,
		`UPDATE workflow_definitions SET document=json_remove(document,'$.languageVersion')`,
	} {
		if _, err = db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func TestWorkflowV4MigrationKeepsActiveV1ApprovalSemantics(t *testing.T) {
	for _, state := range []string{"pending", "approved"} {
		t.Run(state, func(t *testing.T) {
			ctx := context.Background()
			var calls atomic.Int32
			m, source := workflowTestManager(t, &operationCatalog{execute: func(_ context.Context, o Operation) (CapabilityResult, error) {
				calls.Add(1)
				if o.ArgumentsJSON != `{"n":9007199254740993}` {
					t.Errorf("迁移改变精确参数: %s", o.ArgumentsJSON)
				}
				return CapabilityResult{Value: json.RawMessage(o.ArgumentsJSON)}, nil
			}})
			w := workflowStepsTest(t, m, source, workflowOneOperation("test_write"))
			w = workflowWait(t, m, w.ID, StateWaitingApproval)
			a := waitingApproval(t, m, w.ActiveRunID)
			workflowIdle(t, m)
			if state == "approved" {
				var paused atomic.Bool
				m.mu.Lock()
				m.deps.DispatchGuard = func() error {
					if paused.Load() {
						return errors.New("迁移前暂停派发")
					}
					return nil
				}
				m.store.beforeWrite = func(op string) error {
					if op == "approval-decision" {
						paused.Store(true)
					}
					return nil
				}
				m.mu.Unlock()
				if _, err := m.Decide(ctx, a.ID, "approved"); err != nil {
					t.Fatal(err)
				}
			}
			if err := m.Close(ctx); err != nil {
				t.Fatal(err)
			}
			path := workflowV4Fixture(t, m.deps.Path)
			db, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			var oldWorkflow, oldOperation, oldApproval string
			for _, item := range []struct {
				table, id string
				output    *string
			}{{"workflow_instances", w.ID, &oldWorkflow}, {"operations", a.OperationID, &oldOperation}, {"approvals", a.ID, &oldApproval}} {
				if err = db.QueryRow("SELECT document FROM "+item.table+" WHERE id=?", item.id).Scan(item.output); err != nil {
					t.Fatal(err)
				}
			}
			if err = db.Close(); err != nil {
				t.Fatal(err)
			}
			upgraded, err := openStore(path, time.Now)
			if err != nil {
				t.Fatal(err)
			}
			var version int
			if err = upgraded.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != schemaVersion {
				t.Fatalf("未完成v4→当前版本: %d %v", version, err)
			}
			for _, item := range []struct{ table, id, original string }{{"workflow_instances", w.ID, oldWorkflow}, {"operations", a.OperationID, oldOperation}, {"approvals", a.ID, oldApproval}} {
				var got string
				if err = upgraded.db.QueryRow("SELECT document FROM "+item.table+" WHERE id=?", item.id).Scan(&got); err != nil || got != item.original {
					t.Fatalf("迁移改写旧%s事实: %v", item.table, err)
				}
			}
			for _, table := range []string{"workflow_scopes", "workflow_nodes", "resource_rules", "resource_leases", "wiki_pages", "wiki_embedding_requests"} {
				var count int
				if err = upgraded.db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 0 {
					t.Fatalf("新表%s未正确创建: %d %v", table, count, err)
				}
			}
			if err = upgraded.close(); err != nil {
				t.Fatal(err)
			}
			deps := m.deps
			deps.Path, deps.DispatchGuard = path, nil
			m, err = New(deps)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = m.Close(context.Background()) })
			if state == "pending" {
				workflowWait(t, m, w.ID, StateWaitingApproval)
				if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
					t.Fatal(err)
				}
			}
			runtimeEventually(t, func() bool {
				fresh, e := m.GetWorkflow(ctx, w.ID)
				if e == nil {
					w = fresh
				}
				return e == nil && (terminal(w.Status) || w.Status == StateRecoveryRequired)
			})
			if w.Status != StateSucceeded || workflowV2(w) || w.ExecutionTree != nil || w.CurrentStepID != "act" || w.OutputJSON != `{"n":9007199254740993}` || calls.Load() != 1 {
				t.Fatalf("活动v1流程迁移后语义改变: calls=%d workflow=%+v", calls.Load(), w)
			}
			m = reopenOperationManager(t, m)
			if got := workflowWait(t, m, w.ID, StateSucceeded); got.OutputJSON != w.OutputJSON || calls.Load() != 1 {
				t.Fatal("迁移后重启重放旧审批")
			}
		})
	}
}
