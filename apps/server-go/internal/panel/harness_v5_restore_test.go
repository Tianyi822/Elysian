package panel

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMaintenancePreservesV5ScopeWikiAndUnknownProbeFacts(t *testing.T) {
	root, snapshot := t.TempDir(), t.TempDir()
	createRestoreDatabase(t, root,
		"PRAGMA user_version=5",
		"CREATE TABLE execution_barriers(state TEXT NOT NULL)",
		"CREATE TABLE resource_leases(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL)",
		`INSERT INTO resource_leases VALUES('probe','unknown','{"source":"mcp-probe","scopeId":"probe-scope","containerId":"retained-container"}')`,
		"CREATE TABLE workflow_instances(id TEXT PRIMARY KEY,state TEXT NOT NULL)",
		"INSERT INTO workflow_instances VALUES('workflow','succeeded')",
		"CREATE TABLE workflow_scopes(id TEXT PRIMARY KEY,document TEXT NOT NULL)",
		`INSERT INTO workflow_scopes VALUES('scope','{"taskId":"branch-task","outputJson":"{\"value\":9007199254740993}"}')`,
		"CREATE TABLE workflow_nodes(id TEXT PRIMARY KEY,document TEXT NOT NULL)",
		`INSERT INTO workflow_nodes VALUES('node','{"status":"succeeded","runId":"branch-run"}')`,
		"CREATE TABLE wiki_pages(id TEXT PRIMARY KEY,document TEXT NOT NULL)",
		`INSERT INTO wiki_pages VALUES('page','{"revision":3,"markdown":"当前知识"}')`,
		"CREATE TABLE wiki_dependencies(kind TEXT,id TEXT,page_id TEXT)",
		"INSERT INTO wiki_dependencies VALUES('workflow-node','node','page')",
	)
	writeRestoreFixture(t, root, "config/agent/embeddings.json", "当前embedding修订")
	writeRestoreFixture(t, snapshot, "config/agent/embeddings.json", "旧embedding修订")
	writeRestoreFixture(t, snapshot, "data/harness.sqlite", "不得回放的旧库")
	writeRestoreFixture(t, root, "data/agent-workspaces/branch-task.3.tar", "当前分支产物")
	writeRestoreFixture(t, snapshot, "data/agent-workspaces/branch-task.1.tar", "旧分支产物")
	backup := t.TempDir()
	if err := copyPanelData(root, backup); err != nil {
		t.Fatal(err)
	}
	backedUp, err := sql.Open("sqlite", filepath.Join(backup, "data", "harness.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	var backedUpState string
	if err = backedUp.QueryRow("SELECT state FROM resource_leases WHERE id='probe'").Scan(&backedUpState); err != nil || backedUpState != "unknown" {
		t.Fatalf("备份丢失未知probe租约: %q %v", backedUpState, err)
	}
	if err = backedUp.Close(); err != nil {
		t.Fatal(err)
	}
	if needed, err := AgentExecutionRecoveryRequired(root); err != nil || !needed {
		t.Fatalf("未知probe租约未触发容器核实: %t %v", needed, err)
	}
	if err := restorePanelData(snapshot, root); err != nil {
		t.Fatal(err)
	}
	assertRestoreFixture(t, root, "config/agent/embeddings.json", "当前embedding修订")
	assertRestoreFixture(t, root, "data/agent-workspaces/branch-task.3.tar", "当前分支产物")
	assertWorkflowRecoveryFence(t, root)
	db, err := sql.Open("sqlite", filepath.Join(root, "data", "harness.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, table := range []string{"workflow_scopes", "workflow_nodes", "wiki_pages", "wiki_dependencies", "resource_leases"} {
		var count int
		if err = db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil || count != 1 {
			t.Fatalf("恢复丢失v5事实%s: %d %v", table, count, err)
		}
	}
	var state, document string
	if err = db.QueryRow("SELECT state,document FROM resource_leases WHERE id='probe'").Scan(&state, &document); err != nil || state != "unknown" || document != `{"source":"mcp-probe","scopeId":"probe-scope","containerId":"retained-container"}` {
		t.Fatalf("恢复改变未知探测证据: %s %s %v", state, document, err)
	}
	if needed, err := AgentExecutionRecoveryRequired(root); err != nil || !needed {
		t.Fatalf("恢复误释未知probe租约: %t %v", needed, err)
	}
}

func TestMaintenanceV5RequiresReadableResourceLeases(t *testing.T) {
	for _, kind := range []string{"missing", "malformed", "held", "released"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			statements := []string{"PRAGMA user_version=5", "CREATE TABLE execution_barriers(state TEXT NOT NULL)"}
			switch kind {
			case "malformed":
				statements = append(statements, "CREATE TABLE resource_leases(id TEXT)")
			case "held", "released":
				statements = append(statements, "CREATE TABLE resource_leases(state TEXT NOT NULL)", "INSERT INTO resource_leases VALUES('"+kind+"')")
			}
			createRestoreDatabase(t, root, statements...)
			pending, err := preserveAgentFacts(root)
			if kind == "missing" || kind == "malformed" {
				if err == nil {
					t.Fatal("不能核实schema5租约时仍允许恢复")
				}
				return
			}
			if err != nil || pending != (kind == "held") {
				t.Fatalf("租约判断错误: %t %v", pending, err)
			}
		})
	}
}
