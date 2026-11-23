package sqlite

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
	"testing"
	"time"
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

func TestRecordReconcileAfterSelectedOwnerIsPurged(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	run := createRuntimeTestRun(t, s, "purge-after-selection", runtimeStoreTestTime)
	owner := recordOwner{"batch-run", run.ID}
	_, before := readRecordLines(t, s, owner)
	path, err := s.recordPath(owner)
	if err != nil {
		t.Fatal(err)
	}
	owners, err := s.recordOwners("SELECT DISTINCT owner_kind,owner_id FROM agent_record_outbox")
	if err != nil || len(owners) != 1 || owners[0] != owner {
		t.Fatalf("未选中待核对的记录：%v %v", owners, err)
	}
	// 清理事务在 worker 选中归属之后、读取 outbox 之前提交。
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err := purgeRecordOwner(ctx, tx, owner); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := s.reconcileRecordOwner(owners[0], false); err != nil {
		t.Fatalf("已提交的清理不应被判为记录完整性故障：%v", err)
	}
	if after, err := os.ReadFile(path); err != nil || !bytes.Equal(after, before) {
		t.Fatalf("未由清理循环处理的文件不应改写：%v", err)
	}
	if err := s.reconcileRecords(false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("记录文件没有清理：%v", err)
	}
	for _, table := range []string{"agent_record_cleanup", "agent_record_watermarks"} {
		if n := runtimeStoreCount(t, s, table); n != 0 {
			t.Fatalf("%s 留下 %d 项清理后的状态", table, n)
		}
	}
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
	for _, kind := range []string{"sessions", "tasks", "runs", "run_events", "messages", "calls", "model_requests", "operations", "approvals", "execution_barriers"} {
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
			if err != nil {
				t.Fatal(err)
			}
			if opened.recordsFault() == nil {
				opened.close()
				t.Fatal("unverifiable JSONL must freeze dispatch while retaining readable history")
			}
			if _, err := opened.get(context.Background(), r.ID); err != nil {
				t.Fatal(err)
			}
			opened.close()
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
