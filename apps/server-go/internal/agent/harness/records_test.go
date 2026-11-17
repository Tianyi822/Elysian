package harness

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
)

func readRecordLines(t *testing.T, s *store, owner recordOwner) ([]recordLine, []byte) {
	t.Helper()
	if err := s.reconcileRecords(false); err != nil {
		t.Fatal(err)
	}
	path, err := s.recordPath(owner)
	if err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) == 0 || b[len(b)-1] != '\n' {
		t.Fatal("JSONL must end in a complete newline")
	}
	var lines []recordLine
	var lastSeq int64
	for _, raw := range bytes.Split(bytes.TrimSuffix(b, []byte{'\n'}), []byte{'\n'}) {
		var line recordLine
		if err := json.Unmarshal(raw, &line); err != nil {
			t.Fatal(err)
		}
		seq, err := strconv.ParseInt(line.Sequence, 10, 64)
		if err != nil || seq <= lastSeq || line.Version != 1 || line.Owner != owner.kind || line.OwnerID != owner.id {
			t.Fatalf("invalid JSONL envelope: %+v", line)
		}
		digest := sha256.Sum256(line.Document)
		if hex.EncodeToString(digest[:]) != line.Digest {
			t.Fatalf("document digest does not match: %+v", line)
		}
		lastSeq = seq
		lines = append(lines, line)
	}
	var count int
	if err := s.db.QueryRow("SELECT count(*) FROM agent_record_outbox WHERE owner_kind=? AND owner_id=?", owner.kind, owner.id).Scan(&count); err != nil || count != len(lines) {
		t.Fatalf("JSONL and transactional outbox differ: %d vs %d, %v", count, len(lines), err)
	}
	return lines, b
}

func TestAgentRecordsFaultPreservesOtherInflightReceipts(t *testing.T) {
	entered := make(chan string, 2)
	release := make(chan struct{})
	tools := &runtimeTestTools{execute: func(ctx context.Context, name string) (any, error) {
		entered <- name
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
			return map[string]bool{"confirmed": true}, nil
		}
	}}
	m := runtimeManager(t, tools, func(d *Deps) { d.Limits.Concurrency = 2 })
	first := runtimeSubmit(t, m, "replica-first", "docker_images_list")
	second := runtimeSubmit(t, m, "replica-second", "docker_containers_list")
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent calls did not start")
		}
	}
	m.mu.Lock()
	fixture(m).setRecordHook(func(string) error { return errors.New("disk full") })
	_, err := fixture(m).change(context.Background(), first.ID, "replica-fault", func(tx sessionstore.Tx, r *Run) error {
		return fixture(m).event(context.Background(), tx, r, "test/fact", "", nil, nil)
	})
	m.mu.Unlock()
	runtimeEventually(t, func() bool { return fixture(m).recordsFault() != nil })
	if err != nil || fixture(m).recordsFault() == nil {
		t.Fatalf("committed fault injection failed: %v", err)
	}
	close(release)
	for _, run := range []Run{first, second} {
		finished := runtimeFinished(t, m, run.ID)
		calls, err := m.Calls(context.Background(), run.ID, "", 10)
		if err != nil || finished.Status != StateSucceeded || len(calls.Items) != 1 || calls.Items[0].Status != StateSucceeded || !bytes.Contains(calls.Items[0].Result, []byte("confirmed")) {
			t.Fatalf("replica failure lost confirmed receipt: %+v %+v %v", finished, calls, err)
		}
	}
	if info := m.Info(); info.Storage != "unavailable" || info.Available || info.Wiki.Available || info.ResourceLocks.Available || info.Approvals.Available {
		t.Fatalf("replica fault not visible in runtime diagnostics: %+v", info)
	}
}

func TestAgentRecordsFaultBlocksExternalCallAfterCatalogCheck(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	var pause atomic.Bool
	catalog := &operationCatalog{
		check: func(ctx context.Context, _ Operation) error {
			if pause.CompareAndSwap(true, false) {
				close(entered)
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-release:
				}
			}
			return nil
		},
		execute: func(context.Context, Operation) (CapabilityResult, error) {
			calls.Add(1)
			return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
		},
	}
	m, source := workflowTestManager(t, catalog)
	w := workflowStepsTest(t, m, source, workflowOneOperation("test_write"))
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	a := waitingApproval(t, m, w.ActiveRunID)
	pause.Store(true)
	if _, err := m.Decide(context.Background(), a.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("catalog check did not start")
	}
	m.mu.Lock()
	fixture(m).setRecordHook(func(string) error { return errors.New("disk full") })
	_, err := fixture(m).change(context.Background(), w.ActiveRunID, "fault-during-check", func(tx sessionstore.Tx, r *Run) error {
		return fixture(m).event(context.Background(), tx, r, "test/fault", "", nil, nil)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	runtimeEventually(t, func() bool {
		r, err := m.Get(context.Background(), w.ActiveRunID)
		return err == nil && hstate.Terminal(r.Status)
	})
	if calls.Load() != 0 {
		t.Fatal("external operation dispatched after the record replica failed")
	}
}
