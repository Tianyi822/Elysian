package panel

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestMaintenancePreservesV9AuthorizationDecisionsAndRevocations(t *testing.T) {
	root, snapshot := t.TempDir(), t.TempDir()
	currentAuthorization := `{"id":"allow-1","sessionId":"session-1","revision":2,"status":"revoked","revokeRequestId":"revoke-1"}`
	currentOperation := `{"id":"operation-1","status":"unknown","authorization":{"id":"operation-1","digest":"approved-digest","sessionAuthorizationId":"allow-1"}}`
	currentApproval := `{"id":"approval-1","status":"consumed","accessDecision":{"requestId":"decision-1","expectedRevision":1,"expectedDigest":"approved-digest","decision":"session"}}`
	createRestoreDatabase(t, root,
		"PRAGMA user_version=9",
		"CREATE TABLE execution_barriers(state TEXT NOT NULL)",
		"INSERT INTO execution_barriers VALUES('unknown')",
		"CREATE TABLE resource_leases(state TEXT NOT NULL)",
		"INSERT INTO resource_leases VALUES('unknown')",
		"CREATE TABLE session_authorizations(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL)",
		"INSERT INTO session_authorizations VALUES('allow-1','revoked','"+currentAuthorization+"')",
		"CREATE TABLE operations(id TEXT PRIMARY KEY,document TEXT NOT NULL)",
		"INSERT INTO operations VALUES('operation-1','"+currentOperation+"')",
		"CREATE TABLE approvals(id TEXT PRIMARY KEY,document TEXT NOT NULL)",
		"INSERT INTO approvals VALUES('approval-1','"+currentApproval+"')",
	)
	createRestoreDatabase(t, snapshot,
		"PRAGMA user_version=8",
		"CREATE TABLE session_authorizations(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL)",
		`INSERT INTO session_authorizations VALUES('allow-1','active','{"status":"active","revision":1}')`,
	)
	currentRecords := `{"seq":"4","kind":"session_authorizations","document":{"status":"revoked"}}` + "\n"
	currentConfig := `{"schema":1,"profiles":[],"grants":[]}`
	writeRestoreFixture(t, root, "data/agent-records/sessions/session-1.jsonl", currentRecords)
	writeRestoreFixture(t, snapshot, "data/agent-records/sessions/session-1.jsonl", "old-records\n")
	writeRestoreFixture(t, root, "config/agent/execution.json", currentConfig)
	writeRestoreFixture(t, snapshot, "config/agent/execution.json", `{"schema":1,"profiles":[{"enabled":false}],"grants":[]}`)
	backup := t.TempDir()
	if err := copyPanelData(root, backup); err != nil {
		t.Fatal(err)
	}
	if err := restorePanelData(snapshot, root); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{root, backup} {
		db, err := sql.Open("sqlite", filepath.Join(target, "data", "harness.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		var version int
		if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 9 {
			t.Fatalf("schema9 was replaced or downgraded: %d %v", version, err)
		}
		for table, expected := range map[string]string{"session_authorizations": currentAuthorization, "operations": currentOperation, "approvals": currentApproval} {
			var actual string
			if err := db.QueryRow("SELECT document FROM " + table).Scan(&actual); err != nil || actual != expected {
				t.Fatalf("%s lost current %s fact: %q %v", target, table, actual, err)
			}
		}
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
		assertRestoreFixture(t, target, "data/agent-records/sessions/session-1.jsonl", currentRecords)
		assertRestoreFixture(t, target, "config/agent/execution.json", currentConfig)
		if needed, err := AgentExecutionRecoveryRequired(target); err != nil || !needed {
			t.Fatalf("unknown runtime execution was released: %t %v", needed, err)
		}
	}
	assertWorkflowRecoveryFence(t, root)
}

func TestMaintenanceV9StillRequiresReadableExecutionEvidence(t *testing.T) {
	for _, kind := range []string{"missing-leases", "malformed-leases", "missing-barriers"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			statements := []string{"PRAGMA user_version=9", "CREATE TABLE session_authorizations(id TEXT PRIMARY KEY,document TEXT NOT NULL)"}
			if kind != "missing-barriers" {
				statements = append(statements, "CREATE TABLE execution_barriers(state TEXT NOT NULL)")
			}
			if kind == "malformed-leases" {
				statements = append(statements, "CREATE TABLE resource_leases(id TEXT)")
			}
			createRestoreDatabase(t, root, statements...)
			if _, err := preserveAgentFacts(root); err == nil {
				t.Fatal("schema9 accepted without readable execution evidence")
			}
		})
	}
}
