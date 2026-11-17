package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProbeRecordsMigrationPreservesExistingLedgerAndAddsSnapshots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "harness.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	oldRecordSchema := strings.Replace(recordSchema, "'session','batch-run','mcp-probe'", "'session','batch-run'", 1)
	if _, err = db.Exec(schema + sessionSchema + capabilitySchema + workflowSchema + wikiSchema + resourceSchema + workflowV2Schema + userInputSchema + attachmentSchema + oldRecordSchema + "PRAGMA user_version=8;"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO tasks(id,request_id,input,document) VALUES('old-task','old-request','input','{"id":"old-task"}');
INSERT INTO runs(id,task_id,state,created_at,document,request_id) VALUES('old-run','old-task','succeeded','','{"id":"old-run"}','old-request');
INSERT INTO agent_record_outbox(seq,owner_kind,owner_id,fact_type,fact_key,action,document) VALUES(17,'batch-run','old-run','runs','old-run','insert','{"id":"old-run"}');
UPDATE sqlite_sequence SET seq=99 WHERE name='agent_record_outbox';
INSERT INTO resource_leases(id,run_id,operation_id,state,document) VALUES('old-probe','','','unknown','{"id":"old-probe","source":"mcp-probe","scopeId":"old-probe","state":"unknown"}');`); err != nil {
		t.Fatal(err)
	}
	tempStore := &store{db: db, recordsRoot: filepath.Join(filepath.Dir(path), "agent-records")}
	if err := tempStore.prepareRecords(); err != nil {
		t.Fatal(err)
	}
	if err := tempStore.reconcileRecords(true); err != nil {
		t.Fatal(err)
	}
	_, before := readRecordLines(t, tempStore, recordOwner{"batch-run", "old-run"})
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	s, err := openStore(path, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	_, after := readRecordLines(t, s, recordOwner{"batch-run", "old-run"})
	if !bytes.Equal(before, after) {
		t.Fatal("migration rewrote existing JSONL")
	}
	lines, _ := readRecordLines(t, s, recordOwner{"mcp-probe", "old-probe"})
	if len(lines) != 1 || lines[0].Action != "snapshot" || lines[0].Sequence != "100" {
		t.Fatalf("probe migration fabricated history or reused sequence: %+v", lines)
	}
	if err := s.write(context.Background(), "probe-upgraded", func(tx *sql.Tx) error {
		return saveResourceLease(context.Background(), tx, ResourceLease{ID: "new-probe", Source: "mcp-probe", ScopeID: "new-probe", State: "released", CreatedAt: stamp(time.Now()), EndedAt: stamp(time.Now())})
	}); err != nil {
		t.Fatal(err)
	}
	lines, _ = readRecordLines(t, s, recordOwner{"mcp-probe", "new-probe"})
	if len(lines) != 1 || lines[0].Action != "insert" {
		t.Fatal("upgraded probe trigger missing")
	}
}
func TestProbeRecordsRetentionPreservesUnconfirmedAndPendingLeases(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	old := stamp(s.now().Add(-40 * 24 * time.Hour))
	for _, state := range []string{"released", "unknown", "held", "awaiting-approval"} {
		lease := ResourceLease{ID: "probe-retained-" + state, Source: "mcp-probe", ScopeID: "scope", State: state, CreatedAt: old, EndedAt: old}
		if err := s.write(ctx, "probe-retention-fixture", func(tx *sql.Tx) error { return saveResourceLease(ctx, tx, lease) }); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.sweep(ctx, 30); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{"released", "unknown", "held", "awaiting-approval"} {
		id := "probe-retained-" + state
		var count int
		if err := s.db.QueryRow("SELECT COUNT(*) FROM resource_leases WHERE id=?", id).Scan(&count); err != nil {
			t.Fatal(err)
		}
		path, _ := s.recordPath(recordOwner{"mcp-probe", id})
		_, fileErr := os.Stat(path)
		if state == "released" {
			if count != 0 || !os.IsNotExist(fileErr) {
				t.Fatalf("expired released probe not cleaned: %d %v", count, fileErr)
			}
		} else if count != 1 || fileErr != nil {
			t.Fatalf("unconfirmed or waiting probe lost: %s %d %v", state, count, fileErr)
		}
	}
}
