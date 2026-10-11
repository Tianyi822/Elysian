package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	_ "modernc.org/sqlite"
)

// store 只由面板进程持有。状态和事实事件始终在同一事务提交。
type store struct {
	db   *sql.DB
	lock *os.File
	now  func() time.Time
	// beforeWrite 只供故障注入测试；生产恒 nil。
	beforeWrite func(string) error
	// failNextCommit 非空时使下一次提交按失败返回，只供故障注入测试；生产恒 nil。
	failNextCommit error
}

const schema = `
CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, input TEXT NOT NULL, document TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), state TEXT NOT NULL,
 created_at TEXT NOT NULL, ended_at TEXT NOT NULL DEFAULT '', document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_state ON runs(state);
CREATE TABLE IF NOT EXISTS calls (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 step_index INTEGER NOT NULL, state TEXT NOT NULL, document TEXT NOT NULL,
 UNIQUE(run_id,step_index)
);
CREATE TABLE IF NOT EXISTS run_events (
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
 document TEXT NOT NULL, PRIMARY KEY(run_id,seq)
);
PRAGMA user_version=1;`

func openStore(path string, now func() time.Time) (*store, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, errors.New("运行数据库必须使用绝对路径")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, fmt.Errorf("创建运行数据目录失败：%w", err)
	}
	for _, name := range []string{path, path + ".lock"} {
		if info, err := os.Lstat(name); err == nil && !info.Mode().IsRegular() {
			return nil, errors.New("运行数据库与锁必须是普通文件")
		} else if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
	}
	lock, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		lock.Close()
		return nil, errors.New("运行数据库已由另一个面板进程持有")
	}
	s := &store{lock: lock, now: now}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		s.close()
		return nil, err
	}
	f.Close()
	if err = os.Chmod(path, 0600); err != nil {
		s.close()
		return nil, err
	}
	s.db, err = sql.Open("sqlite", path)
	if err != nil {
		s.close()
		return nil, err
	}
	s.db.SetMaxOpenConns(1)
	s.db.SetMaxIdleConns(1)
	for _, p := range []string{"PRAGMA busy_timeout=5000", "PRAGMA foreign_keys=ON", "PRAGMA journal_mode=WAL", "PRAGMA synchronous=FULL"} {
		if _, err = s.db.Exec(p); err != nil {
			s.close()
			return nil, fmt.Errorf("初始化运行数据库失败：%w", err)
		}
	}
	err = migrateStore(s.db)
	if err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

func (s *store) close() error {
	var errs []error
	if s.db != nil {
		_, err := s.db.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
		errs = append(errs, err, s.db.Close())
		s.db = nil
	}
	if s.lock != nil {
		errs = append(errs, syscall.Flock(int(s.lock.Fd()), syscall.LOCK_UN), s.lock.Close())
		s.lock = nil
	}
	return errors.Join(errs...)
}

// write 结束后调用方可能仍持有事务内准备的候选产物：fn 返回错误意味着事务
// 已回滚、数据库不引用任何候选；Commit 失败则提交结果未确认，数据库可能已经
// 引用候选版本，错误以 unconfirmedCommit 包装返回，清理路径必须保留候选。
func (s *store) write(ctx context.Context, op string, fn func(*sql.Tx) error) error {
	if s.beforeWrite != nil {
		if err := s.beforeWrite(op); err != nil {
			return err
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	if s.failNextCommit != nil {
		err = s.failNextCommit
		s.failNextCommit = nil
		return &unconfirmedCommit{op: op, err: err}
	}
	if err = tx.Commit(); err != nil {
		return &unconfirmedCommit{op: op, err: err}
	}
	return nil
}

// unconfirmedCommit 表示事务体已执行完毕但提交结果未知：数据库可能已落盘，
// 也可能没有；调用方不得按「已回滚」清理与该事务关联的候选产物。
type unconfirmedCommit struct {
	op  string
	err error
}

func (e *unconfirmedCommit) Error() string {
	return "事务提交结果未确认（" + e.op + "）：" + e.err.Error()
}
func (e *unconfirmedCommit) Unwrap() error { return e.err }

// commitUnconfirmed 判定写事务错误是否停在「提交结果未知」：数据库指针可能
// 已经引用候选工作区版本，Discard 会删掉被引用的归档，必须保留待后续核实。
func commitUnconfirmed(err error) bool {
	var unconfirmed *unconfirmedCommit
	return errors.As(err, &unconfirmed)
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
func notFound() error {
	return &Error{Status: 404, Code: "not-found", Message: "运行记录不存在"}
}
func readRun(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (Run, error) {
	var raw string
	var r Run
	err := q.QueryRowContext(ctx, "SELECT document FROM runs WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return r, notFound()
	}
	if err != nil {
		return r, err
	}
	err = json.Unmarshal([]byte(raw), &r)
	return r, err
}
func saveRun(ctx context.Context, tx *sql.Tx, r *Run) error {
	copy := *r
	copy.Task = nil
	b, err := json.Marshal(copy)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE runs SET state=?,ended_at=?,document=? WHERE id=?", r.Status, r.EndedAt, string(b), r.ID)
	return err
}
func (s *store) event(ctx context.Context, tx *sql.Tx, r *Run, kind, callID string, index *int, data any) error {
	seq, err := strconv.ParseInt(r.LastSeq, 10, 64)
	if err != nil {
		return fmt.Errorf("运行事件序号无效：%w", err)
	}
	seq++
	var payload json.RawMessage
	if data != nil {
		payload, err = json.Marshal(data)
		if err != nil {
			return err
		}
	}
	e := Event{RunID: r.ID, Seq: strconv.FormatInt(seq, 10), Type: kind, At: stamp(s.now()), CallID: callID, StepIndex: index, Data: payload}
	b, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO run_events(run_id,seq,document) VALUES(?,?,?)", r.ID, seq, string(b)); err != nil {
		return err
	}
	r.LastSeq = e.Seq
	if err := saveRun(ctx, tx, r); err != nil {
		return err
	}
	return s.syncWorkflowRun(ctx, tx, r)
}
func (s *store) change(ctx context.Context, id, op string, fn func(*sql.Tx, *Run) error) (Run, error) {
	var r Run
	err := s.write(ctx, op, func(tx *sql.Tx) error {
		var err error
		r, err = readRun(ctx, tx, id)
		if err != nil {
			return err
		}
		if err = fn(tx, &r); err != nil {
			return err
		}
		if terminal(r.Status) {
			return s.releaseSession(ctx, tx, &r)
		}
		return nil
	})
	return r, err
}
func (s *store) get(ctx context.Context, id string) (Run, error) {
	r, err := readRun(ctx, s.db, id)
	if err != nil {
		return r, err
	}
	var raw string
	if err = s.db.QueryRowContext(ctx, "SELECT document FROM tasks WHERE id=?", r.TaskID).Scan(&raw); err != nil {
		return r, err
	}
	var task Task
	if err = json.Unmarshal([]byte(raw), &task); err != nil {
		return r, err
	}
	r.Task = &task
	return r, nil
}
func (s *store) request(ctx context.Context, key string) (Run, string, error) {
	var id, input string
	err := s.db.QueryRowContext(ctx, "SELECT id,canonical_input FROM runs WHERE request_id=?", key).Scan(&id, &input)
	if errors.Is(err, sql.ErrNoRows) {
		return Run{}, "", nil
	}
	if err != nil {
		return Run{}, "", err
	}
	r, err := s.get(ctx, id)
	return r, input, err
}
func (s *store) create(ctx context.Context, t Task, r Run, input string) error {
	if r.RequestID == "" {
		r.RequestID = t.RequestID
	}
	if r.RunNumber == 0 {
		r.RunNumber = 1
	}
	return s.write(ctx, "submit", func(tx *sql.Tx) error {
		tb, err := json.Marshal(t)
		if err != nil {
			return err
		}
		rb, err := json.Marshal(r)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO tasks(id,request_id,input,document,session_id) VALUES(?,?,?,?,?)", t.ID, t.RequestID, input, string(tb), t.SessionID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO runs(id,task_id,state,created_at,document,session_id,request_id,canonical_input,run_number) VALUES(?,?,?,?,?,?,?,?,?)", r.ID, t.ID, r.Status, r.CreatedAt, string(rb), r.SessionID, r.RequestID, input, r.RunNumber); err != nil {
			return err
		}
		return s.event(ctx, tx, &r, "run/queued", "", nil, nil)
	})
}

func saveCall(ctx context.Context, tx *sql.Tx, c Call) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO calls(id,run_id,step_index,state,document) VALUES(?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, c.ID, c.RunID, c.StepIndex, c.Status, string(b))
	return err
}

func (s *store) queued(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT id FROM runs WHERE state='queued' ORDER BY rowid")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *store) recover(ctx context.Context) error {
	return s.write(ctx, "recover", func(tx *sql.Tx) error {
		if err := recoverOperations(ctx, tx, s.now()); err != nil {
			return err
		}
		rows, err := tx.QueryContext(ctx, "SELECT document FROM runs WHERE state='running'")
		if err != nil {
			return err
		}
		var runs []Run
		for rows.Next() {
			var b string
			var r Run
			if err = rows.Scan(&b); err == nil {
				err = json.Unmarshal([]byte(b), &r)
			}
			if err != nil {
				rows.Close()
				return err
			}
			runs = append(runs, r)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for i := range runs {
			r := &runs[i]
			r.Status = StateInterrupted
			if r.SessionID != "" {
				r.MemoryStatus = "stale"
			}
			r.EndReason = "panel-restarted"
			r.EndedAt = stamp(s.now())
			r.Error = &Failure{Code: r.EndReason, Message: "面板重启中断了运行，未自动重跑"}
			if err = interruptCalls(ctx, tx, r.ID, s.now()); err != nil {
				return err
			}
			if err = s.event(ctx, tx, r, "run/interrupted", "", nil, r.Error); err != nil {
				return err
			}
			if err = s.releaseSession(ctx, tx, r); err != nil {
				return err
			}
		}
		return nil
	})
}
func interruptCalls(ctx context.Context, tx *sql.Tx, id string, now time.Time) error {
	rows, err := tx.QueryContext(ctx, "SELECT document FROM calls WHERE run_id=? AND state='running'", id)
	if err != nil {
		return err
	}
	var calls []Call
	for rows.Next() {
		var raw string
		var c Call
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal([]byte(raw), &c)
		}
		if err != nil {
			rows.Close()
			return err
		}
		calls = append(calls, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, c := range calls {
		c.Status = StateInterrupted
		c.EndedAt = stamp(now)
		c.Error = &Failure{Code: "outcome-unknown", Message: "调用中断，结果未确认"}
		if err = saveCall(ctx, tx, c); err != nil {
			return err
		}
	}
	return nil
}

func (s *store) sweep(ctx context.Context, days int) error {
	cutoff := stamp(s.now().Add(-time.Duration(days) * 24 * time.Hour))
	return s.write(ctx, "sweep", func(tx *sql.Tx) error {
		if err := s.sweepSessions(ctx, tx, cutoff); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM runs WHERE session_id='' AND state IN ('succeeded','failed','cancelled','interrupted') AND ended_at<>'' AND julianday(ended_at)<julianday(?)
 AND NOT EXISTS(SELECT 1 FROM resource_leases l WHERE l.run_id=runs.id AND l.state IN ('held','unknown'))
 AND NOT EXISTS(SELECT 1 FROM execution_barriers b WHERE b.run_id=runs.id AND b.state IN ('dispatched','unknown'))`, cutoff); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, "DELETE FROM tasks WHERE session_id='' AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.task_id=tasks.id)")
		return err
	})
}
