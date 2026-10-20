package harness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/mcp"
)

func TestProbeRecordsIncludeRequestDecisionProgressAndCancellation(t *testing.T) {
	m, e, server := probeManager(t, func(context.Context, mcp.Server) (mcp.Duplex, error) { return newProbeDuplex(), nil })
	attachProbeRuntime(t, e, server.Stdio.Image)
	ctx := context.Background()
	p, err := m.RequestProbeAccess(ctx, e, server, "probe-record-confirm")
	if err != nil {
		t.Fatal(err)
	}
	owner := recordOwner{"mcp-probe", p.ID}
	lines, _ := readRecordLines(t, m.store, owner)
	if len(lines) != 1 || lines[0].Type != "resource_leases" || lines[0].Action != "insert" {
		t.Fatalf("proposal omitted from same transaction ledger: %+v", lines)
	}
	if _, err := m.DecideProbeAccess(ctx, e, p.ID, ProbeAccessDecision{RequestID: "probe-record-decision", ExpectedVersion: p.Version, ExpectedDigest: p.Digest, Decision: "allow-once"}); err != nil {
		t.Fatal(err)
	}
	if settled := waitProbe(t, m, p.ID); settled.State != "completed" {
		t.Fatalf("probe did not complete: %+v", settled)
	}
	m.mu.Lock()
	lines, _ = readRecordLines(t, m.store, owner)
	m.mu.Unlock()
	states := map[string]bool{}
	for _, line := range lines {
		var lease ResourceLease
		if err := json.Unmarshal(line.Document, &lease); err != nil {
			t.Fatal(err)
		}
		if lease.Probe != nil {
			states[lease.Probe.State] = true
		}
	}
	for _, state := range []string{"waiting", "preparing", "running", "completed"} {
		if !states[state] {
			t.Errorf("probe ledger missing %s: %+v", state, states)
		}
	}
	for _, decision := range []string{"deny", "cancel"} {
		p, err := m.RequestProbeAccess(ctx, e, server, "probe-record-"+decision)
		if err != nil {
			t.Fatal(err)
		}
		if decision == "deny" {
			_, err = m.DecideProbeAccess(ctx, e, p.ID, ProbeAccessDecision{RequestID: "probe-denied", ExpectedVersion: p.Version, ExpectedDigest: p.Digest, Decision: "deny"})
		} else {
			_, err = m.CancelProbeAccess(ctx, p.ID, "probe-cancelled")
		}
		if err != nil {
			t.Fatal(err)
		}
		lines, _ := readRecordLines(t, m.store, recordOwner{"mcp-probe", p.ID})
		if len(lines) != 2 || lines[1].Action != "update" {
			t.Fatalf("probe %s missing update: %+v", decision, lines)
		}
	}
}

func TestProbeRecordsFailureFreezesDispatchAndRebuildsCommittedDecisions(t *testing.T) {
	for _, stage := range []string{"request", "decision"} {
		t.Run(stage, func(t *testing.T) {
			var opens atomic.Int32
			m, e, server := probeManager(t, func(context.Context, mcp.Server) (mcp.Duplex, error) { opens.Add(1); return newProbeDuplex(), nil })
			attachProbeRuntime(t, e, server.Stdio.Image)
			ctx := context.Background()
			fail := func(string) error { return errors.New("injected probe replica failure") }
			if stage == "request" {
				m.mu.Lock()
				m.store.recordHook = fail
				m.mu.Unlock()
			}
			p, err := m.RequestProbeAccess(ctx, e, server, "probe-fault-"+stage)
			if err != nil {
				t.Fatal(err)
			}
			if stage == "decision" {
				m.mu.Lock()
				m.store.recordHook = fail
				m.mu.Unlock()
			}
			_, err = m.DecideProbeAccess(ctx, e, p.ID, ProbeAccessDecision{RequestID: "probe-fault-decision", ExpectedVersion: p.Version, ExpectedDigest: p.Digest, Decision: "allow-once"})
			if stage == "request" {
				runtimeErrorCode(t, err, "record-storage-unavailable")
			} else {
				if err != nil {
					t.Fatal(err)
				}
				settled := waitProbe(t, m, p.ID)
				if settled.State != "failed" {
					t.Fatalf("replica fault did not stop preparation: %+v", settled)
				}
			}
			if m.store.recordsFault() == nil || opens.Load() != 0 {
				t.Fatalf("replica fault permitted external execution: fault=%v opens=%d", m.store.recordsFault(), opens.Load())
			}
			var count int
			if err := m.store.db.QueryRow("SELECT COUNT(*) FROM agent_record_outbox WHERE owner_kind='mcp-probe' AND owner_id=?", p.ID).Scan(&count); err != nil || count < 1 {
				t.Fatalf("committed decision lost outbox: %d %v", count, err)
			}
			m = reopenOperationManager(t, m)
			lines, _ := readRecordLines(t, m.store, recordOwner{"mcp-probe", p.ID})
			if len(lines) != count || m.store.recordsFault() != nil || opens.Load() != 0 {
				t.Fatalf("recovery replayed or lost receipts: lines=%d expected=%d opens=%d", len(lines), count, opens.Load())
			}
		})
	}
}

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
