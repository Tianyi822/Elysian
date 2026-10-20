package harness

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

// The outbox is part of the same SQLite transaction as each fact. It retains
// the exact persisted document until its owner expires, so a missing JSONL
// file can be reconstructed without asking a model or replaying an operation.
const recordSchema = `
CREATE TABLE agent_record_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('session','batch-run','mcp-probe')),
 owner_id TEXT NOT NULL,
 fact_type TEXT NOT NULL,
 fact_key TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('snapshot','insert','update')),
 document TEXT NOT NULL
);
CREATE INDEX agent_record_owner ON agent_record_outbox(owner_kind,owner_id,seq);
CREATE TABLE agent_record_dirty (
 owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
 PRIMARY KEY(owner_kind,owner_id)
);
CREATE TRIGGER agent_record_mark_dirty AFTER INSERT ON agent_record_outbox BEGIN
 INSERT INTO agent_record_dirty(owner_kind,owner_id)
 SELECT NEW.owner_kind,NEW.owner_id WHERE NOT EXISTS(
  SELECT 1 FROM agent_record_dirty WHERE owner_kind=NEW.owner_kind AND owner_id=NEW.owner_id);
END;
CREATE TABLE agent_record_watermarks (
 owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
 last_seq INTEGER NOT NULL, file_bytes INTEGER NOT NULL,
 PRIMARY KEY(owner_kind,owner_id)
);
CREATE TABLE agent_record_cleanup (
 owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL,
 PRIMARY KEY(owner_kind,owner_id)
);`

// ROW is substituted only with NEW (trigger) or x (snapshot query). Every
// other part is a fixed SQL fragment, never caller-provided text.
type recordSpec struct{ table, key, session, run string }

var sessionAuthorizationRecordSpec = recordSpec{"session_authorizations", "ROW.id", "ROW.session_id", "''"}

var userInputRecordSpec = recordSpec{"user_inputs", "ROW.id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"}
var resourceLeaseRecordSpec = recordSpec{"resource_leases", "ROW.id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"}

var recordSpecs = []recordSpec{
	sessionAuthorizationRecordSpec,
	userInputRecordSpec,
	{"sessions", "ROW.id", "ROW.id", "''"},
	{"tasks", "ROW.id", "ROW.session_id", "(SELECT id FROM runs WHERE task_id=ROW.id ORDER BY run_number LIMIT 1)"},
	{"environments", "ROW.session_id || ':' || ROW.revision", "ROW.session_id", "''"},
	{"runs", "ROW.id", "ROW.session_id", "ROW.id"},
	{"run_events", "ROW.run_id || ':' || ROW.seq", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"calls", "ROW.id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"messages", "ROW.id", "ROW.session_id", "ROW.run_id"},
	{"model_requests", "ROW.id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"operations", "ROW.id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"approvals", "ROW.id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"execution_barriers", "ROW.id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"context_items", "ROW.id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	resourceLeaseRecordSpec,
	{"workspace_versions", "ROW.task_id || ':' || ROW.revision", "(SELECT session_id FROM tasks WHERE id=ROW.task_id)", "''"},
	{"working_memories", "ROW.task_id || ':' || ROW.revision", "(SELECT session_id FROM tasks WHERE id=ROW.task_id)", "''"},
	{"workflow_instances", "ROW.id", "ROW.session_id", "''"},
	{"workflow_events", "ROW.workflow_id || ':' || ROW.seq", "(SELECT session_id FROM workflow_instances WHERE id=ROW.workflow_id)", "''"},
	{"workflow_attempts", "ROW.workflow_id || ':' || ROW.step_id || ':' || ROW.number", "(SELECT session_id FROM workflow_instances WHERE id=ROW.workflow_id)", "ROW.run_id"},
	{"workflow_recoveries", "ROW.workflow_id || ':' || ROW.request_id", "(SELECT session_id FROM workflow_instances WHERE id=ROW.workflow_id)", "''"},
	{"workflow_scopes", "ROW.id", "(SELECT session_id FROM workflow_instances WHERE id=ROW.workflow_id)", "''"},
	{"workflow_nodes", "ROW.id", "(SELECT session_id FROM workflow_instances WHERE id=ROW.workflow_id)", "''"},
	{"wiki_session_spaces", "ROW.session_id", "ROW.session_id", "''"},
	{"wiki_run_spaces", "ROW.run_id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"wiki_recalls", "ROW.run_id", "(SELECT session_id FROM runs WHERE id=ROW.run_id)", "ROW.run_id"},
	{"wiki_task_contexts", "ROW.task_id", "(SELECT session_id FROM tasks WHERE id=ROW.task_id)", "''"},
	{"wiki_visible_pages", "ROW.owner_kind || ':' || ROW.owner_id || ':' || ROW.page_id", "CASE WHEN ROW.owner_kind='workflow' THEN (SELECT session_id FROM workflow_instances WHERE id=ROW.owner_id) ELSE (SELECT session_id FROM runs WHERE id=ROW.owner_id) END", "CASE WHEN ROW.owner_kind='run' THEN ROW.owner_id ELSE '' END"},
	{"wiki_artifacts", "ROW.kind || ':' || ROW.id", "COALESCE((SELECT session_id FROM tasks WHERE id=ROW.task_id),(SELECT session_id FROM runs WHERE id=ROW.run_id))", "ROW.run_id"},
	{"wiki_dependencies", "ROW.kind || ':' || ROW.id || ':' || ROW.page_id || ':' || ROW.revision", "(SELECT t.session_id FROM wiki_artifacts a JOIN tasks t ON t.id=a.task_id WHERE a.kind=ROW.kind AND a.id=ROW.id)", "(SELECT run_id FROM wiki_artifacts WHERE kind=ROW.kind AND id=ROW.id)"},
	{"wiki_jobs", "ROW.id", "(SELECT session_id FROM tasks WHERE id=json_extract(ROW.document,'$.taskId'))", "COALESCE(json_extract(ROW.document,'$.runId'),'')"},
}

func recordExpr(expr, row string) string { return strings.ReplaceAll(expr, "ROW", row) }

func recordDocument(table, row string) string {
	columns := map[string][]string{
		"wiki_task_contexts": {"task_id", "generation"},
		"wiki_visible_pages": {"owner_kind", "owner_id", "page_id", "revision", "digest"},
		"wiki_artifacts":     {"kind", "id", "task_id", "run_id", "generation", "invalidated"},
		"wiki_dependencies":  {"kind", "id", "page_id", "revision", "digest"},
	}
	if columns[table] == nil {
		return row + ".document"
	}
	var values []string
	for _, column := range columns[table] {
		values = append(values, "'"+column+"'", row+"."+column)
	}
	return "json_object(" + strings.Join(values, ",") + ")"
}

func recordInsertSQL(spec recordSpec, row, action, from string) string {
	session := recordExpr(spec.session, row)
	run := recordExpr(spec.run, row)
	key := recordExpr(spec.key, row)
	probe := "0"
	if spec.table == "resource_leases" {
		probe = fmt.Sprintf("%s.run_id='' AND %s.operation_id='' AND json_extract(%s.document,'$.source')='mcp-probe'", row, row, row)
	}
	return fmt.Sprintf(`INSERT INTO agent_record_outbox(owner_kind,owner_id,fact_type,fact_key,action,document)
 SELECT CASE WHEN %s THEN 'mcp-probe' WHEN COALESCE(%s,'')<>'' THEN 'session' ELSE 'batch-run' END,
 CASE WHEN %s THEN %s ELSE CASE WHEN COALESCE(%s,'')<>'' THEN %s ELSE %s END END,
 '%s',%s,'%s',%s %s
 WHERE (COALESCE(%s,'')<>'' AND EXISTS(SELECT 1 FROM sessions WHERE id=%s))
 OR (COALESCE(%s,'')='' AND EXISTS(SELECT 1 FROM runs WHERE id=%s AND session_id='')) OR (%s)`, probe, session, probe, key, session, session, run, spec.table, key, action, recordDocument(spec.table, row), from, session, session, session, run, probe)
}

func migrateRecordOutbox(tx *sql.Tx) error {
	if _, err := tx.Exec(recordSchema); err != nil {
		return err
	}
	for _, spec := range recordSpecs {
		// Existing v5 rows are current-state snapshots, not invented history.
		if _, err := tx.Exec(recordInsertSQL(spec, "x", "snapshot", "FROM "+spec.table+" AS x") + " ORDER BY x.rowid"); err != nil {
			return fmt.Errorf("记录旧 %s 状态快照失败：%w", spec.table, err)
		}
		if err := installRecordTriggers(tx, spec); err != nil {
			return err
		}
	}
	// A batch Task is inserted before its Run, so its owner cannot be resolved
	// in the Task trigger. Bind it when the first batch Run is inserted.
	return installBatchTaskRecordTrigger(tx)
}

func installBatchTaskRecordTrigger(tx *sql.Tx) error {
	_, err := tx.Exec(`CREATE TRIGGER agent_record_batch_task AFTER INSERT ON runs WHEN NEW.session_id='' BEGIN
 INSERT INTO agent_record_outbox(owner_kind,owner_id,fact_type,fact_key,action,document)
 SELECT 'batch-run',NEW.id,'tasks',id,'insert',document FROM tasks WHERE id=NEW.task_id;
 END`)
	if err != nil {
		return err
	}
	return nil
}

// v9 widens the outbox owner CHECK without modifying existing sequences or
// documents. JSONL bytes and watermarks remain valid; only previously omitted
// standalone probe leases receive current-state snapshots.
func migrateProbeRecordOwners(tx *sql.Tx) error {
	var previousSequence int64
	if err := tx.QueryRow("SELECT COALESCE(MAX(seq),0) FROM sqlite_sequence WHERE name='agent_record_outbox'").Scan(&previousSequence); err != nil {
		return err
	}
	for _, spec := range recordSpecs {
		for _, action := range []string{"insert", "update"} {
			if _, err := tx.Exec("DROP TRIGGER IF EXISTS agent_record_" + spec.table + "_" + action); err != nil {
				return err
			}
		}
	}
	if _, err := tx.Exec(`DROP TRIGGER IF EXISTS agent_record_batch_task;
DROP TRIGGER IF EXISTS agent_record_mark_dirty;
CREATE TABLE agent_record_outbox_v9 (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('session','batch-run','mcp-probe')),
 owner_id TEXT NOT NULL, fact_type TEXT NOT NULL, fact_key TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('snapshot','insert','update')), document TEXT NOT NULL);
INSERT INTO agent_record_outbox_v9 SELECT * FROM agent_record_outbox ORDER BY seq;
DROP TABLE agent_record_outbox;
ALTER TABLE agent_record_outbox_v9 RENAME TO agent_record_outbox;
CREATE INDEX agent_record_owner ON agent_record_outbox(owner_kind,owner_id,seq);
CREATE TRIGGER agent_record_mark_dirty AFTER INSERT ON agent_record_outbox BEGIN
 INSERT INTO agent_record_dirty(owner_kind,owner_id)
 SELECT NEW.owner_kind,NEW.owner_id WHERE NOT EXISTS(
  SELECT 1 FROM agent_record_dirty WHERE owner_kind=NEW.owner_kind AND owner_id=NEW.owner_id);
END;`); err != nil {
		return err
	}
	for _, spec := range recordSpecs {
		if err := installRecordTriggers(tx, spec); err != nil {
			return err
		}
	}
	if err := installBatchTaskRecordTrigger(tx); err != nil {
		return err
	}
	from := `FROM (SELECT * FROM resource_leases l WHERE l.run_id='' AND l.operation_id='' AND json_extract(l.document,'$.source')='mcp-probe'
AND NOT EXISTS(SELECT 1 FROM agent_record_outbox o WHERE o.owner_kind='mcp-probe' AND o.owner_id=l.id)) AS x`
	if _, err := tx.Exec("UPDATE sqlite_sequence SET seq=MAX(seq,?) WHERE name='agent_record_outbox'", previousSequence); err != nil {
		return err
	}
	if _, err := tx.Exec("INSERT INTO sqlite_sequence(name,seq) SELECT 'agent_record_outbox',? WHERE NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='agent_record_outbox')", previousSequence); err != nil {
		return err
	}
	_, err := tx.Exec(recordInsertSQL(resourceLeaseRecordSpec, "x", "snapshot", from))
	return err
}

type recordOwner struct{ kind, id string }

func installRecordTriggers(tx *sql.Tx, spec recordSpec) error {
	for _, action := range []string{"insert", "update"} {
		trigger := fmt.Sprintf("agent_record_%s_%s", spec.table, action)
		statement := fmt.Sprintf("CREATE TRIGGER %s AFTER %s ON %s BEGIN %s; END", trigger, strings.ToUpper(action), spec.table, recordInsertSQL(spec, "NEW", action, ""))
		if _, err := tx.Exec(statement); err != nil {
			return fmt.Errorf("安装 %s 记录触发器失败：%w", spec.table, err)
		}
	}
	return nil
}

type recordLine struct {
	Version  int             `json:"version"`
	Sequence string          `json:"sequence"`
	Owner    string          `json:"owner"`
	OwnerID  string          `json:"ownerId"`
	Type     string          `json:"type"`
	Key      string          `json:"key"`
	Action   string          `json:"action"`
	Document json.RawMessage `json:"document"`
	Digest   string          `json:"documentSha256"`
}

func (s *store) recordsFault() error {
	s.recordsStateMu.RLock()
	defer s.recordsStateMu.RUnlock()
	return s.recordsErr
}

func (s *store) failRecords(err error) error {
	s.recordsStateMu.Lock()
	if s.recordsErr == nil {
		s.recordsErr = fmt.Errorf("Agent JSONL 记录副本不可用，派发已暂停：%w", err)
	}
	fault := s.recordsErr
	s.recordsStateMu.Unlock()
	return fault
}

func recordDirectory(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("记录目录必须是真实目录")
	}
	return os.Chmod(path, 0700)
}

func (s *store) prepareRecords() error {
	if err := recordDirectory(s.recordsRoot); err != nil {
		return err
	}
	for _, name := range []string{"sessions", "batch-runs", "mcp-probes"} {
		if err := recordDirectory(filepath.Join(s.recordsRoot, name)); err != nil {
			return err
		}
	}
	if err := syncRecordDir(s.recordsRoot); err != nil {
		return err
	}
	return syncRecordDir(filepath.Dir(s.recordsRoot))
}

func (s *store) recordPath(owner recordOwner) (string, error) {
	var dir string
	switch owner.kind {
	case "session":
		dir = "sessions"
	case "batch-run":
		dir = "batch-runs"
	case "mcp-probe":
		dir = "mcp-probes"
	default:
		return "", errors.New("记录归属类型无效")
	}
	if owner.id == "" {
		return "", errors.New("记录归属标识为空")
	}
	digest := sha256.Sum256([]byte(owner.id))
	return filepath.Join(s.recordsRoot, dir, hex.EncodeToString(digest[:])+".jsonl"), nil
}

func syncRecordDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func openRecordFile(path string) (*os.File, bool, error) {
	_, statErr := os.Lstat(path)
	if statErr != nil && !os.IsNotExist(statErr) {
		return nil, false, statErr
	}
	if statErr == nil {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return nil, false, errors.New("记录文件必须是普通文件")
		}
	}
	fd, err := syscall.Open(path, syscall.O_CREAT|syscall.O_RDWR|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, false, err
	}
	f := os.NewFile(uintptr(fd), path)
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		f.Close()
		return nil, false, errors.New("记录文件必须是普通文件")
	}
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return nil, false, err
	}
	return f, os.IsNotExist(statErr), nil
}

func (s *store) recordOwners(query string) ([]recordOwner, error) {
	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var owners []recordOwner
	for rows.Next() {
		var owner recordOwner
		if err := rows.Scan(&owner.kind, &owner.id); err != nil {
			return nil, err
		}
		owners = append(owners, owner)
	}
	return owners, rows.Err()
}

func (s *store) cleanupRecords() error {
	owners, err := s.recordOwners("SELECT owner_kind,owner_id FROM agent_record_cleanup ORDER BY owner_kind,owner_id")
	if err != nil {
		return err
	}
	for _, owner := range owners {
		path, err := s.recordPath(owner)
		if err != nil {
			return err
		}
		if info, err := os.Lstat(path); err == nil {
			if !info.Mode().IsRegular() {
				return errors.New("待清理的记录文件不是普通文件")
			}
			if err := os.Remove(path); err != nil {
				return err
			}
		} else if !os.IsNotExist(err) {
			return err
		}
		if err := syncRecordDir(filepath.Dir(path)); err != nil {
			return err
		}
		if _, err := s.db.Exec("DELETE FROM agent_record_cleanup WHERE owner_kind=? AND owner_id=?", owner.kind, owner.id); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) reconcileRecords(all bool) error {
	if err := s.cleanupRecords(); err != nil {
		return err
	}
	query := "SELECT owner_kind,owner_id FROM agent_record_dirty ORDER BY owner_kind,owner_id"
	if all {
		query = "SELECT DISTINCT owner_kind,owner_id FROM agent_record_outbox ORDER BY owner_kind,owner_id"
	}
	owners, err := s.recordOwners(query)
	if err != nil {
		return err
	}
	for _, owner := range owners {
		if err := s.reconcileRecordOwner(owner, all); err != nil {
			return fmt.Errorf("核对 %s %s 的 JSONL 记录失败：%w", owner.kind, owner.id, err)
		}
	}
	return nil
}

func (s *store) reconcileRecordOwner(owner recordOwner, verifyAll bool) error {
	path, err := s.recordPath(owner)
	if err != nil {
		return err
	}
	f, created, err := openRecordFile(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var offset, lastSeq int64
	if !verifyAll && !created {
		err := s.db.QueryRow("SELECT last_seq,file_bytes FROM agent_record_watermarks WHERE owner_kind=? AND owner_id=?", owner.kind, owner.id).Scan(&lastSeq, &offset)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		info, err := f.Stat()
		if err != nil {
			return err
		}
		if info.Size() != offset {
			lastSeq, offset = 0, 0
		}
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return err
		}
	}
	rows, err := s.db.Query(`SELECT seq,fact_type,fact_key,action,document FROM agent_record_outbox
 WHERE owner_kind=? AND owner_id=? AND seq>? ORDER BY seq`, owner.kind, owner.id, lastSeq)
	if err != nil {
		return err
	}
	reader := bufio.NewReader(f)
	appending := false
	for rows.Next() {
		var line recordLine
		var sequence int64
		var raw string
		if err := rows.Scan(&sequence, &line.Type, &line.Key, &line.Action, &raw); err != nil {
			rows.Close()
			return err
		}
		encoded, err := json.Marshal(json.RawMessage(raw))
		if err != nil {
			rows.Close()
			return err
		}
		line.Version, line.Owner, line.OwnerID, line.Document = 1, owner.kind, owner.id, encoded
		line.Sequence = strconv.FormatInt(sequence, 10)
		digest := sha256.Sum256(encoded)
		line.Digest = hex.EncodeToString(digest[:])
		b, err := json.Marshal(line)
		if err != nil {
			rows.Close()
			return err
		}
		b = append(b, '\n')
		if !appending {
			actual := make([]byte, len(b))
			n, readErr := io.ReadFull(reader, actual)
			actual = actual[:n]
			switch {
			case readErr == nil && bytes.Equal(actual, b):
				offset += int64(len(b))
			case (errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF)) && len(actual) < len(b) && bytes.HasPrefix(b, actual):
				// An interrupted append may leave only a prefix of the next
				// committed line. The authoritative outbox supplies the rest.
				if err := f.Truncate(offset); err != nil {
					rows.Close()
					return err
				}
				if _, err := f.Seek(offset, io.SeekStart); err != nil {
					rows.Close()
					return err
				}
				appending = true
			default:
				rows.Close()
				return errors.New("记录文件与已提交的数据库事实不一致")
			}
		}
		if appending {
			if err := s.recordStage("append"); err != nil {
				rows.Close()
				return err
			}
			if _, err := f.Write(b); err != nil {
				rows.Close()
				return err
			}
			offset += int64(len(b))
		}
		lastSeq = sequence
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if !appending {
		if _, err := reader.ReadByte(); err == nil {
			return errors.New("记录文件含有数据库外的额外内容")
		} else if !errors.Is(err, io.EOF) {
			return err
		}
	}
	if err := f.Sync(); err != nil {
		return err
	}
	if err := s.recordStage("synced"); err != nil {
		return err
	}
	if created || verifyAll {
		if err := syncRecordDir(filepath.Dir(path)); err != nil {
			return err
		}
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.Exec(`INSERT INTO agent_record_watermarks(owner_kind,owner_id,last_seq,file_bytes) VALUES(?,?,?,?)
 ON CONFLICT(owner_kind,owner_id) DO UPDATE SET last_seq=excluded.last_seq,file_bytes=excluded.file_bytes`, owner.kind, owner.id, lastSeq, offset)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM agent_record_dirty WHERE owner_kind=? AND owner_id=?
 AND NOT EXISTS(SELECT 1 FROM agent_record_outbox WHERE owner_kind=? AND owner_id=? AND seq>?)`, owner.kind, owner.id, owner.kind, owner.id, lastSeq); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *store) recordStage(stage string) error {
	if s.recordHook != nil {
		return s.recordHook(stage)
	}
	return nil
}

func purgeRecordOwner(ctx context.Context, tx *sql.Tx, owner recordOwner) error {
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO agent_record_cleanup(owner_kind,owner_id) VALUES(?,?)", owner.kind, owner.id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM agent_record_outbox WHERE owner_kind=? AND owner_id=?", owner.kind, owner.id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM agent_record_dirty WHERE owner_kind=? AND owner_id=?", owner.kind, owner.id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM agent_record_watermarks WHERE owner_kind=? AND owner_id=?", owner.kind, owner.id)
	return err
}
