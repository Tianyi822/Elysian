package harness

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func readRecordLines(t *testing.T, s *store, owner recordOwner) ([]recordLine, []byte) {
	t.Helper()
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

func TestAgentRecordsTransactionalMessagesAndFacts(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	session, task, run := sessionStoreFixture(t, s, "records", runtimeStoreTestTime)
	run = acceptSessionTestRun(t, s, task, run, true)
	owner := recordOwner{"session", session.ID}
	_, before := readRecordLines(t, s, owner)
	count := runtimeStoreCount(t, s, "agent_record_outbox")
	err := s.write(ctx, "rollback-records", func(tx *sql.Tx) error {
		if err := saveCall(ctx, tx, Call{ID: "rolled-back", RunID: run.ID, Tool: "test", StepIndex: 0, Status: StateSucceeded, Result: json.RawMessage(`{"value":9007199254740993}`)}); err != nil {
			return err
		}
		return errors.New("rollback")
	})
	if err == nil || runtimeStoreCount(t, s, "agent_record_outbox") != count {
		t.Fatal("rollback leaked transactional outbox records")
	}
	_, after := readRecordLines(t, s, owner)
	if !bytes.Equal(before, after) {
		t.Fatal("rollback altered JSONL")
	}
	if err := s.write(ctx, "all-facts", func(tx *sql.Tx) error {
		if err := saveCall(ctx, tx, Call{ID: "stored-call", RunID: run.ID, Tool: "test", StepIndex: 0, Status: StateSucceeded, Result: json.RawMessage(`{"value":9007199254740993}`)}); err != nil {
			return err
		}
		if err := saveModelRequest(ctx, tx, ModelRequestRecord{ID: "stored-response", RunID: run.ID, Index: 1, Status: StateSucceeded}); err != nil {
			return err
		}
		for _, q := range []string{
			`INSERT INTO operations VALUES('operation',?,'stored-response',0,'completed','{"id":"operation","argumentsJson":"{\"n\":9007199254740993}"}')`,
			`INSERT INTO approvals VALUES('approval','operation',?,'approved','','{"id":"approval"}')`,
			`INSERT INTO execution_barriers VALUES('barrier','operation',?,'confirmed-completed','{"id":"barrier"}')`,
		} {
			if _, err := tx.ExecContext(ctx, q, run.ID); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	finishSessionTestRun(t, s, run.ID, "完整的答复\n第二行 <tag>&", nil)
	lines, all := readRecordLines(t, s, owner)
	seen := map[string]bool{}
	for _, line := range lines {
		seen[line.Type] = true
	}
	for _, kind := range []string{"sessions", "tasks", "runs", "run_events", "messages", "calls", "model_requests", "operations", "approvals", "execution_barriers", "wiki_run_spaces"} {
		if !seen[kind] {
			t.Errorf("missing persisted fact %s", kind)
		}
	}
	if !bytes.Contains(all, []byte("9007199254740993")) || bytes.Contains(all, []byte("should-not-persist")) {
		t.Fatal("JSONL changed exact integers or leaked a model credential")
	}
}

func TestAgentRecordsRecoverCommitAndAppendCrashPoints(t *testing.T) {
	for _, stage := range []string{"append", "synced", "partial", "missing"} {
		t.Run(stage, func(t *testing.T) {
			s, path := openRuntimeTestStore(t)
			run := createRuntimeTestRun(t, s, stage, runtimeStoreTestTime)
			owner := recordOwner{"batch-run", run.ID}
			s.recordHook = func(at string) error {
				if at == stage || stage == "partial" && at == "synced" || stage == "missing" && at == "synced" {
					return errors.New("injected disk failure")
				}
				return nil
			}
			// The database commit is successful even if its file copy fails.
			_, err := s.change(context.Background(), run.ID, "receipt", func(tx *sql.Tx, r *Run) error {
				r.Status, r.EndedAt = StateSucceeded, stamp(s.now())
				return s.event(context.Background(), tx, r, "run/succeeded", "", nil, nil)
			})
			if err != nil || s.recordsFault() == nil {
				t.Fatalf("post-commit failure was misreported or not frozen: %v", err)
			}
			file, _ := s.recordPath(owner)
			if stage == "partial" {
				info, err := os.Stat(file)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Truncate(file, info.Size()-17); err != nil {
					t.Fatal(err)
				}
			}
			if stage == "missing" {
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.close(); err != nil {
				t.Fatal(err)
			}
			opened, err := openStore(path, s.now)
			if err != nil {
				t.Fatal(err)
			}
			defer opened.close()
			lines, before := readRecordLines(t, opened, owner)
			if len(lines) < 4 {
				t.Fatal("recovery lost committed records")
			}
			if err := opened.reconcileRecords(true); err != nil {
				t.Fatal(err)
			}
			_, after := readRecordLines(t, opened, owner)
			if !bytes.Equal(before, after) {
				t.Fatal("repeated recovery appended duplicate facts")
			}
			actual, err := opened.get(context.Background(), run.ID)
			if err != nil || actual.Status != StateSucceeded {
				t.Fatalf("file recovery changed authoritative run: %+v %v", actual, err)
			}
		})
	}
}

func TestAgentRecordsPermissionsTamperingAndSymlinks(t *testing.T) {
	for _, mode := range []string{"corrupt", "extra", "symlink", "directory-symlink"} {
		t.Run(mode, func(t *testing.T) {
			s, path := openRuntimeTestStore(t)
			r := createRuntimeTestRun(t, s, mode, runtimeStoreTestTime)
			file, _ := s.recordPath(recordOwner{"batch-run", r.ID})
			for _, dir := range []string{s.recordsRoot, filepath.Dir(file)} {
				info, err := os.Stat(dir)
				if err != nil || info.Mode().Perm() != 0700 {
					t.Fatalf("record directory permissions: %v %v", info, err)
				}
			}
			info, err := os.Stat(file)
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatalf("record permissions: %v %v", info, err)
			}
			if err := s.close(); err != nil {
				t.Fatal(err)
			}
			b, _ := os.ReadFile(file)
			switch mode {
			case "corrupt":
				b[0] = '['
				err = os.WriteFile(file, b, 0600)
			case "extra":
				err = os.WriteFile(file, append(b, []byte("{}\n")...), 0600)
			case "symlink":
				target := filepath.Join(t.TempDir(), "untouched")
				if err := os.WriteFile(target, []byte("private"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				err = os.Symlink(target, file)
			case "directory-symlink":
				dir := filepath.Dir(file)
				if err := os.Rename(dir, dir+"-original"); err != nil {
					t.Fatal(err)
				}
				err = os.Symlink(dir+"-original", dir)
			}
			if err != nil {
				t.Fatal(err)
			}
			opened, err := openStore(path, s.now)
			if err == nil {
				opened.close()
				t.Fatal("unverifiable JSONL must block startup")
			}
		})
	}
}

func TestAgentRecordsMigrateV5AsCurrentSnapshots(t *testing.T) {
	path := filepath.Join(t.TempDir(), "harness.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(schema + sessionSchema + capabilitySchema + workflowSchema + wikiSchema + resourceSchema + workflowV2Schema + "PRAGMA user_version=5;"); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`INSERT INTO tasks(id,request_id,input,document) VALUES('old-task','old-request','input',' { "id" : "old-task", "goal" : "<tag>&" } ');
 INSERT INTO runs(id,task_id,state,created_at,document,request_id) VALUES('old-run','old-task','succeeded','','{"id":"old-run"}','old-request');
 INSERT INTO calls VALUES('old-call','old-run',0,'succeeded','{"id":"old-call","result":{"n":9007199254740993}}');`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	s, err := openStore(path, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	lines, _ := readRecordLines(t, s, recordOwner{"batch-run", "old-run"})
	if len(lines) != 3 {
		t.Fatalf("expected only current rows, got %d", len(lines))
	}
	for _, line := range lines {
		if line.Action != "snapshot" {
			t.Fatal("migration fabricated historic mutations")
		}
	}
}

func TestAgentRecordsRetentionAndCleanupRecovery(t *testing.T) {
	s, path := openRuntimeTestStore(t)
	old := runtimeStoreTestTime.Add(-40 * 24 * time.Hour)
	session, task, run := sessionStoreFixture(t, s, "retained", old)
	run = acceptSessionTestRun(t, s, task, run, true)
	finishSessionTestRun(t, s, run.ID, "done", nil)
	batch := createRuntimeTestRun(t, s, "old-batch", old)
	if err := s.write(context.Background(), "age-runs", func(tx *sql.Tx) error {
		session.LastActivityAt = stamp(old)
		if err := saveSession(context.Background(), tx, session); err != nil {
			return err
		}
		batch.Status, batch.EndedAt = StateSucceeded, stamp(old)
		return saveRun(context.Background(), tx, &batch)
	}); err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, owner := range []recordOwner{{"session", session.ID}, {"batch-run", batch.ID}} {
		file, _ := s.recordPath(owner)
		paths = append(paths, file)
	}
	// A replica fault leaves persistent cleanup work; restart removes both
	// files before deleting their cleanup markers.
	s.failRecords(errors.New("disk unavailable"))
	if err := s.sweep(context.Background(), 30); err != nil {
		t.Fatal(err)
	}
	if runtimeStoreCount(t, s, "agent_record_cleanup") != 2 || runtimeStoreCount(t, s, "agent_record_outbox") != 0 {
		t.Fatal("retention did not atomically queue record cleanup")
	}
	if err := s.close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(path, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	for _, file := range paths {
		if _, err := os.Stat(file); !os.IsNotExist(err) {
			t.Fatalf("retained record file was not removed: %s %v", file, err)
		}
	}
	if runtimeStoreCount(t, reopened, "agent_record_cleanup") != 0 {
		t.Fatal("record cleanup did not finish")
	}
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
	m.store.recordHook = func(string) error { return errors.New("disk full") }
	_, err := m.store.change(context.Background(), first.ID, "replica-fault", func(tx *sql.Tx, r *Run) error {
		return m.store.event(context.Background(), tx, r, "test/fact", "", nil, nil)
	})
	m.mu.Unlock()
	if err != nil || m.store.recordsFault() == nil {
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
	if info := m.Info(); info.Storage != "unavailable" || info.Available || info.Workflow.Available || info.Approvals.Available {
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
	m.store.recordHook = func(string) error { return errors.New("disk full") }
	_, err := m.store.change(context.Background(), w.ActiveRunID, "fault-during-check", func(tx *sql.Tx, r *Run) error {
		return m.store.event(context.Background(), tx, r, "test/fault", "", nil, nil)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	close(release)
	runtimeEventually(t, func() bool {
		r, err := m.Get(context.Background(), w.ActiveRunID)
		return err == nil && terminal(r.Status)
	})
	if calls.Load() != 0 {
		t.Fatal("external operation dispatched after the record replica failed")
	}
}

func TestAgentRecordsDoNotReviveDeletedWikiOwners(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	if err := s.write(context.Background(), "orphan-wiki-job", func(tx *sql.Tx) error {
		_, err := tx.Exec(`INSERT INTO wiki_jobs VALUES('job','extraction','run','deleted-run','interrupted',?, '')`, `{"id":"job","runId":"deleted-run","taskId":"deleted-task"}`)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if count := runtimeStoreCount(t, s, "agent_record_outbox"); count != 0 {
		t.Fatalf("orphan wiki recovery recreated records for an expired owner: %d", count)
	}
	if strings.Contains(filepath.Base(s.recordsRoot), "sqlite") {
		t.Fatal("record directory must be separate from the database file")
	}
}
