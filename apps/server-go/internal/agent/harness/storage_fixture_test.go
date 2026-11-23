package harness

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	storesqlite "elysian/server/internal/agent/harness/sessionstore/sqlite"
	"elysian/server/internal/agent/tools"
)

// 测试夹具通过真实 SQLite 端口运行；独立连接只用于植入旧数据与检查物理账本。
type store struct {
	closed           bool
	injectedReplica  error
	freezeContinuous bool
	sessionstore.SessionStore
	path                              string
	db                                *sql.DB
	now                               func() time.Time
	recordsRoot                       string
	beforeWrite                       func(string) error
	failNextCommit, errorPlaceholder  error
	failNextRollback, failAfterCommit error
	recordHookMu                      sync.RWMutex
	recordHook                        func(string) error
}

func fixture(m *Manager) *store { return m.store.(*store) }
func fixtureDeps(d any) *store {
	switch v := d.(type) {
	case Deps:
		return v.Store.(*store)
	case *Deps:
		return v.Store.(*store)
	}
	panic("无效依赖夹具")
}
func mustFixtureStore(t *testing.T, paths ...string) *store {
	path := filepath.Join(paths...)
	t.Helper()
	s, e := openStore(path, time.Now)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.close() })
	return s
}
func openStore(path string, now func() time.Time) (*store, error) { return openFixture(path, now, nil) }
func openFixture(path string, now func() time.Time, connector driver.Connector) (*store, error) {
	s := &store{path: path, now: now, recordsRoot: filepath.Join(filepath.Dir(path), "agent-records")}
	if err := s.open(connector); err != nil {
		return nil, err
	}
	fixtureStores = append(fixtureStores, s)
	return s, nil
}

func (s *store) open(connector driver.Connector) error {
	backend, e := storesqlite.Open(storesqlite.Options{Connector: connector, Path: s.path, Now: func() time.Time { return s.now() }, Fault: func(stage, op string) error {
		if stage == "write" && s.beforeWrite != nil {
			return s.beforeWrite(op)
		}
		if stage == "commit" {
			e := s.failNextCommit
			s.failNextCommit = nil
			return e
		}
		if stage == "rollback" {
			e := s.failNextRollback
			s.failNextRollback = nil
			return e
		}
		if stage == "acknowledge" {
			e := s.failAfterCommit
			s.failAfterCommit = nil
			return e
		}
		if stage == "record" {
			s.recordHookMu.RLock()
			f := s.recordHook
			s.recordHookMu.RUnlock()
			if f != nil {
				return f(op)
			}
		}
		return nil
	}})
	if e != nil {
		return e
	}
	s.SessionStore = backend
	s.db, e = sql.Open("sqlite", "file:"+s.path+"?_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)")
	if e != nil {
		backend.Close(context.Background())
		return e
	}
	s.db.SetMaxOpenConns(1)
	s.closed = false
	return nil
}
func (s *store) close() error {
	s.closed = true
	e := s.SessionStore.Close(context.Background())
	return errors.Join(e, s.db.Close())
}
func (s *store) write(ctx context.Context, op string, fn func(sessionstore.Tx) error) error {
	_, e := s.Update(ctx, op, fn)
	return e
}
func (s *store) change(ctx context.Context, id, op string, fn func(sessionstore.Tx, *Run) error) (Run, error) {
	return s.ChangeRun(ctx, id, op, fn)
}
func (s *store) setRecordHook(f func(string) error) {
	s.recordHookMu.Lock()
	defer s.recordHookMu.Unlock()
	s.recordHook = f
}
func (s *store) startRecordWorker(func()) {}
func (s *store) stopRecordWorker()        {}
func (s *store) wakeRecordWorker() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_ = s.waitRecords(ctx)
}
func (s *store) waitRecords(ctx context.Context) error { return waitRecords(s, ctx) }
func (s *store) reconcileRecords(bool) error {
	if s.Health().Write != "ready" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.waitRecords(ctx)
}
func (s *store) recordsFault() error                    { return s.DispatchError() }
func (s *store) health() StorageHealth                  { return s.Health() }
func (s *store) sweep(ctx context.Context, n int) error { return s.Sweep(ctx, n) }

type recordOwner struct{ kind, id string }

func (s *store) recordPath(owner recordOwner) (string, error) {
	dirs := map[string]string{"session": "sessions", "batch-run": "batch-runs", "mcp-probe": "mcp-probes"}
	d := sha256.Sum256([]byte(owner.id))
	return filepath.Join(s.recordsRoot, dirs[owner.kind], hex.EncodeToString(d[:])+".jsonl"), nil
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
type unconfirmedCommit struct {
	op  string
	err error
}

func (e *unconfirmedCommit) Error() string        { return e.err.Error() }
func (e *unconfirmedCommit) Unwrap() error        { return e.err }
func (e *unconfirmedCommit) Is(target error) bool { return target == sessionstore.ErrCommitUnknown }
func readDocuments[T any](ctx context.Context, q *sql.DB, query string, args ...any) ([]T, error) {
	rows, e := q.QueryContext(ctx, query, args...)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var raw string
		var v T
		if e = rows.Scan(&raw); e != nil {
			return nil, e
		}
		if e = json.Unmarshal([]byte(raw), &v); e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (s *store) sweepOrphanAttachments(ctx context.Context, tx sessionstore.Tx) error {
	return tx.SweepOrphanAttachments(ctx)
}
func (s *store) thawContinuousRuns(ctx context.Context, tx sessionstore.Tx) error {
	return tx.ThawContinuousRuns(ctx)
}
func (s *store) freezeContinuousRuns(ctx context.Context, tx sessionstore.Tx) error {
	return tx.FreezeContinuousRuns(ctx)
}
func (s *store) recoverContinuous(ctx context.Context, tx sessionstore.Tx, r *Run) (bool, error) {
	return tx.RecoverContinuous(ctx, r)
}
func (s *store) replaceLastMessage(ctx context.Context, tx sessionstore.Tx, task *Task, run *Run, replacement *Message) error {
	return tx.ReplaceLastMessage(ctx, task, run, replacement)
}
func (s *store) events(ctx context.Context, id, after string, n int) (Page[Event], error) {
	return s.Events(ctx, id, after, n)
}
func (s *store) calls(ctx context.Context, id, rawCursor string, n int) (Page[Call], error) {
	return s.Calls(ctx, id, rawCursor, n)
}
func (s *store) list(ctx context.Context, q ListQuery) (Page[Run], error) { return s.List(ctx, q) }
func (s *store) recoverRuntimePreparations(ctx context.Context, tx sessionstore.Tx) error {
	return tx.RecoverRuntimePreparations(ctx)
}
func (s *store) failWorkflowV2Budget(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, current *Run, failure *Failure) error {
	return tx.FailWorkflowV2Budget(ctx, w, current, failure)
}
func (s *store) refreshWorkflowV2(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance) error {
	return tx.RefreshWorkflowV2(ctx, w)
}
func (s *store) failWorkflowV2Node(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, node *WorkflowNodeExecution, failure *Failure) error {
	return tx.FailWorkflowV2Node(ctx, w, node, failure)
}
func (s *store) advanceWorkflowV2Scope(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, scope *WorkflowScope, node WorkflowNodeExecution, step WorkflowStepDefinition, next string) error {
	return tx.AdvanceWorkflowV2Scope(ctx, w, scope, node, step, next)
}
func (s *store) finishWorkflowV2Run(ctx context.Context, tx sessionstore.Tx, r *Run) error {
	return tx.FinishWorkflowV2Run(ctx, r)
}
func (s *store) syncWorkflowV2Run(ctx context.Context, tx sessionstore.Tx, r *Run) error {
	return tx.SyncWorkflowV2Run(ctx, r)
}
func (s *store) sessionsByActivity(ctx context.Context, cursorRaw string, n int) (Page[Session], error) {
	return s.SessionsByActivity(ctx, cursorRaw, n)
}
func (s *store) latestRun(ctx context.Context, taskID string) (*Run, error) {
	return s.LatestRun(ctx, taskID)
}
func (s *store) modelRequests(ctx context.Context, id, cursorRaw string, n int) (Page[ModelRequestRecord], error) {
	return s.ModelRequests(ctx, id, cursorRaw, n)
}
func (s *store) memory(ctx context.Context, taskID string, revision int) (WorkingMemory, error) {
	return s.Memory(ctx, taskID, revision)
}
func (s *store) messages(ctx context.Context, sessionID, after string, n int) (Page[Message], error) {
	return s.Messages(ctx, sessionID, after, n)
}
func (s *store) tasks(ctx context.Context, sessionID, cursorRaw string, n int) (Page[Task], error) {
	return s.Tasks(ctx, sessionID, cursorRaw, n)
}
func (s *store) sessions(ctx context.Context, cursorRaw string, n int) (Page[Session], error) {
	return s.Sessions(ctx, cursorRaw, n)
}
func (s *store) finalizeAgent(ctx context.Context, tx sessionstore.Tx, r *Run, answer string, memory *WorkingMemory) error {
	return tx.FinalizeAgent(ctx, r, answer, memory)
}
func (s *store) saveStoppedReply(ctx context.Context, tx sessionstore.Tx, run Run) error {
	return tx.SaveStoppedReply(ctx, run)
}
func (s *store) sweepSessions(ctx context.Context, tx sessionstore.Tx, cutoff string) error {
	return tx.SweepSessions(ctx, cutoff)
}
func (s *store) deleteSession(ctx context.Context, id string, extraTasks ...tools.TaskReference) error {
	return s.DeleteSession(ctx, id, extraTasks...)
}
func (s *store) renameSession(ctx context.Context, id, title string) (Session, error) {
	return s.RenameSession(ctx, id, title)
}
func (s *store) releaseSession(ctx context.Context, tx sessionstore.Tx, r *Run) error {
	return tx.ReleaseSession(ctx, r)
}
func (s *store) acceptAgent(ctx context.Context, task Task, run Run, canonical, messageID string, newTask bool) (Run, bool, error) {
	return s.AcceptAgent(ctx, task, run, canonical, messageID, newTask)
}
func (s *store) appendMessage(ctx context.Context, tx sessionstore.Tx, msg *Message) error {
	return tx.AppendMessage(ctx, msg)
}
func (s *store) switchModel(ctx context.Context, id, profile string, revision int) (Session, error) {
	return s.SwitchModel(ctx, id, profile, revision)
}
func (s *store) createSession(ctx context.Context, session Session) error {
	return s.CreateSession(ctx, session)
}
func (s *store) recover(ctx context.Context) error            { return s.Recover(ctx, s.freezeContinuous) }
func (s *store) queued(ctx context.Context) ([]string, error) { return s.Queued(ctx) }
func (s *store) create(ctx context.Context, t Task, r Run, input string) error {
	return s.Create(ctx, t, r, input)
}
func (s *store) request(ctx context.Context, key string) (Run, string, error) {
	return s.Request(ctx, key)
}
func (s *store) get(ctx context.Context, id string) (Run, error) { return s.Get(ctx, id) }
func (s *store) event(ctx context.Context, tx sessionstore.Tx, r *Run, kind, callID string, index *int, data any) error {
	return tx.Event(ctx, r, kind, callID, index, data)
}
func (s *store) saveTerminalResult(ctx context.Context, tx sessionstore.Tx, r *Run) error {
	return tx.SaveTerminalResult(ctx, r)
}
func (s *store) terminalResult(ctx context.Context, q reportReader, r Run) (*TerminalResult, error) {
	return s.TerminalResult(ctx, r)
}
func (s *store) releaseWorkflowSession(ctx context.Context, tx sessionstore.Tx, w WorkflowInstance) error {
	return tx.ReleaseWorkflowSession(ctx, w)
}
func (s *store) failWorkflowActiveBudget(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, current *Run) error {
	return tx.FailWorkflowActiveBudget(ctx, w, current)
}
func (s *store) syncWorkflowRun(ctx context.Context, tx sessionstore.Tx, r *Run) error {
	return tx.SyncWorkflowRun(ctx, r)
}
func (s *store) advanceWorkflow(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, a WorkflowAttempt, next string) error {
	return tx.AdvanceWorkflow(ctx, w, a, next)
}
func (s *store) finishWorkflowRun(ctx context.Context, tx sessionstore.Tx, r *Run) error {
	return tx.FinishWorkflowRun(ctx, r)
}
func (s *store) workflowEvent(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, kind, detail string) error {
	return tx.WorkflowEvent(ctx, w, kind, detail)
}

func closeFixtureManager(m *Manager, contexts ...context.Context) error {
	ctx := context.Background()
	if len(contexts) > 0 {
		ctx = contexts[0]
	}
	return errors.Join(m.Close(ctx), fixture(m).close())
}
func newFixtureManager(t *testing.T, d Deps) (*Manager, error) {
	s := fixtureDeps(d)
	if s.closed {
		n, e := openStore(s.path, s.now)
		if e != nil {
			return nil, e
		}
		d.Store = n
		t.Cleanup(func() { n.close() })
	}
	return New(d)
}

type interruptedRead struct{}

func (interruptedRead) Error() string { return "测试中断" }
func (interruptedRead) Code() int     { return 9 }

func fixtureRawWrite(s *store, ctx context.Context, fn func(*sql.Tx) error) error {
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	if e = fn(tx); e != nil {
		return e
	}
	return tx.Commit()
}

const schemaVersion = 12
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
const sessionSchema = `
CREATE TABLE sessions (
 id TEXT PRIMARY KEY, last_activity_at TEXT NOT NULL, active_run_id TEXT NOT NULL DEFAULT '',
 last_seq INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL
);
CREATE TABLE messages (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 seq INTEGER NOT NULL, role TEXT NOT NULL, document TEXT NOT NULL,
 UNIQUE(session_id,seq), UNIQUE(run_id,role)
);
CREATE TABLE working_memories (
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
 document TEXT NOT NULL, PRIMARY KEY(task_id,revision)
);
CREATE TABLE model_requests (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 request_index INTEGER NOT NULL, state TEXT NOT NULL, document TEXT NOT NULL,
 UNIQUE(run_id,request_index)
);
ALTER TABLE tasks ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN session_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN request_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN canonical_input TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN run_number INTEGER NOT NULL DEFAULT 1;
UPDATE runs SET request_id=(SELECT request_id FROM tasks WHERE tasks.id=runs.task_id),
 canonical_input=(SELECT input FROM tasks WHERE tasks.id=runs.task_id);
CREATE UNIQUE INDEX runs_request_id ON runs(request_id);
CREATE UNIQUE INDEX runs_task_number ON runs(task_id,run_number);
CREATE INDEX tasks_session ON tasks(session_id);
CREATE INDEX runs_session ON runs(session_id);
CREATE INDEX sessions_activity ON sessions(last_activity_at);
`

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
const capabilitySchema = `
CREATE TABLE workspace_cleanup (task_id TEXT PRIMARY KEY);
CREATE TABLE capability_revocations (kind TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(kind,id,revision));
CREATE TABLE environments (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(session_id,revision));
CREATE TABLE operations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 model_request_id TEXT NOT NULL, call_index INTEGER NOT NULL, state TEXT NOT NULL, document TEXT NOT NULL,
 UNIQUE(run_id,model_request_id,call_index));
CREATE TABLE approvals (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, state TEXT NOT NULL, expires_at TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE execution_barriers (id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE REFERENCES operations(id),
 run_id TEXT NOT NULL REFERENCES runs(id), state TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE context_items (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, document TEXT NOT NULL);
CREATE TABLE workspace_versions (task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, document TEXT NOT NULL);
`
const workflowSchema = `
CREATE TABLE workflow_definitions(id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL, PRIMARY KEY(id,revision));
CREATE TABLE workflow_instances(id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, canonical_input TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, state TEXT NOT NULL, ready_at TEXT NOT NULL, document TEXT NOT NULL);
CREATE TABLE workflow_attempts(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
 step_id TEXT NOT NULL, number INTEGER NOT NULL, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
 state TEXT NOT NULL, document TEXT NOT NULL, PRIMARY KEY(workflow_id,step_id,number));
CREATE TABLE workflow_events(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,seq INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(workflow_id,seq));
CREATE TABLE workflow_recoveries(workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,request_id TEXT NOT NULL,canonical_input TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(workflow_id,request_id));
ALTER TABLE sessions ADD COLUMN active_workflow_id TEXT NOT NULL DEFAULT '';
ALTER TABLE runs ADD COLUMN workflow_id TEXT NOT NULL DEFAULT '';
CREATE INDEX runs_workflow ON runs(workflow_id);
ALTER TABLE approvals RENAME TO approvals_v3;
CREATE TABLE approvals(id TEXT PRIMARY KEY,operation_id TEXT REFERENCES operations(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,state TEXT NOT NULL,expires_at TEXT NOT NULL,document TEXT NOT NULL);
INSERT INTO approvals SELECT * FROM approvals_v3;
DROP TABLE approvals_v3;
CREATE UNIQUE INDEX approval_active_operation ON approvals(operation_id) WHERE state IN ('pending','approved');
CREATE INDEX workflow_ready ON workflow_instances(state,ready_at);
`
const wikiSchema = `
CREATE TABLE IF NOT EXISTS wiki_spaces(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_space_revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS wiki_cleared_sources(run_id TEXT PRIMARY KEY,cleared_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS wiki_global_space ON wiki_spaces(kind) WHERE kind='global';
CREATE TABLE IF NOT EXISTS wiki_pages(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES wiki_spaces(id),slug TEXT NOT NULL,
 current_revision INTEGER NOT NULL,status TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(space_id,slug));
CREATE TABLE IF NOT EXISTS wiki_page_revisions(page_id TEXT NOT NULL REFERENCES wiki_pages(id),revision INTEGER NOT NULL,
 digest TEXT NOT NULL,document TEXT NOT NULL,PRIMARY KEY(page_id,revision));
CREATE TABLE IF NOT EXISTS wiki_candidates(id TEXT PRIMARY KEY,space_id TEXT NOT NULL REFERENCES wiki_spaces(id),state TEXT NOT NULL,
 origin_kind TEXT NOT NULL,origin_id TEXT NOT NULL,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_session_spaces(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_run_spaces(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_visible_pages(owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,page_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id,page_id));
CREATE TABLE IF NOT EXISTS wiki_recalls(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,document TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wiki_task_contexts(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,generation INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS wiki_artifacts(kind TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL DEFAULT '',run_id TEXT NOT NULL DEFAULT '',
 generation INTEGER NOT NULL DEFAULT 0,invalidated INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(kind,id));
CREATE INDEX IF NOT EXISTS wiki_artifacts_task ON wiki_artifacts(task_id,invalidated);
CREATE TABLE IF NOT EXISTS wiki_dependencies(kind TEXT NOT NULL,id TEXT NOT NULL,page_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,
 PRIMARY KEY(kind,id,page_id,revision),FOREIGN KEY(kind,id) REFERENCES wiki_artifacts(kind,id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS wiki_dependencies_page ON wiki_dependencies(page_id,revision);
CREATE TABLE IF NOT EXISTS wiki_jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,origin_kind TEXT NOT NULL,origin_id TEXT NOT NULL,
 state TEXT NOT NULL,document TEXT NOT NULL,input TEXT NOT NULL,UNIQUE(kind,origin_kind,origin_id));
CREATE INDEX IF NOT EXISTS wiki_jobs_state ON wiki_jobs(state);
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(page_id UNINDEXED,space_id UNINDEXED,title,body,tokenize='unicode61');
` + embeddingSchema
const resourceSchema = `
CREATE TABLE IF NOT EXISTS resource_rules (
 id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL,
 PRIMARY KEY(id,revision)
);
CREATE TABLE IF NOT EXISTS resource_leases (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL DEFAULT '', operation_id TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL, document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_leases_state ON resource_leases(state,sequence);
CREATE INDEX IF NOT EXISTS resource_leases_run ON resource_leases(run_id);
`
const workflowV2Schema = `
CREATE TABLE IF NOT EXISTS workflow_scopes(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
 parent_node_id TEXT NOT NULL,task_id TEXT NOT NULL REFERENCES tasks(id),ordinal INTEGER NOT NULL,state TEXT NOT NULL,document TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS workflow_scopes_parent ON workflow_scopes(parent_node_id,ordinal);
CREATE TABLE IF NOT EXISTS workflow_nodes(id TEXT PRIMARY KEY,workflow_id TEXT NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
 scope_id TEXT NOT NULL REFERENCES workflow_scopes(id) ON DELETE CASCADE,step_id TEXT NOT NULL,
 state TEXT NOT NULL,document TEXT NOT NULL,UNIQUE(scope_id,step_id));
CREATE INDEX IF NOT EXISTS workflow_nodes_ready ON workflow_nodes(workflow_id,state);
`
const userInputSchema = `CREATE TABLE user_inputs (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 model_request_id TEXT NOT NULL, model_call_id TEXT NOT NULL, state TEXT NOT NULL,
 document TEXT NOT NULL, UNIQUE(run_id,model_request_id,model_call_id));
 CREATE UNIQUE INDEX user_inputs_pending ON user_inputs(run_id) WHERE state='pending';`

// attachmentSchema 暂存上传后未绑定会话的图片字节；接受任务时在同一事务内置位
// session_id，会话删除经外键级联带走，孤儿由周期 sweep 按 24 小时清理。
// session_id 可空（NULL 表示未绑定）：外键约束下非空值必须命中 sessions 行，
// 不能用空串充当「未绑定」，孤儿判定因此统一走 IS NULL。
const attachmentSchema = `
CREATE TABLE agent_attachments (
 id TEXT PRIMARY KEY,
 session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
 mime_type TEXT NOT NULL,
 bytes INTEGER NOT NULL,
 width INTEGER NOT NULL,
 height INTEGER NOT NULL,
 name TEXT NOT NULL,
 created_at TEXT NOT NULL,
 content BLOB NOT NULL
);
CREATE INDEX agent_attachments_session ON agent_attachments(session_id);
`

func (s *store) failRecords(e error) { s.injectedReplica = e }
func (s *store) DispatchError() error {
	if s.injectedReplica != nil {
		return s.injectedReplica
	}
	return s.SessionStore.DispatchError()
}
func migrateStore(db *sql.DB) error {
	var seq int
	var name, path string
	if e := db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &path); e != nil {
		return e
	}
	for _, s := range fixtureStores {
		if s.path == path {
			if e := s.close(); e != nil {
				return e
			}
			return s.open(nil)
		}
	}
	return errors.New("未登记的测试存储")
}

var fixtureStores []*store

// embeddingSchema is deliberately SQLite-only. Vectors are JSON arrays so the
// page revision and its digest remain the authoritative index key; an optional
// native vector extension can be added without changing the Wiki contract.
const embeddingSchema = `
CREATE TABLE IF NOT EXISTS wiki_embedding_profiles(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,
 PRIMARY KEY(id,revision));
CREATE TABLE IF NOT EXISTS wiki_embedding_indexes(page_id TEXT NOT NULL,page_revision INTEGER NOT NULL,digest TEXT NOT NULL,
 profile_id TEXT NOT NULL,profile_revision INTEGER NOT NULL,vector TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(page_id,page_revision,profile_id,profile_revision));
CREATE INDEX IF NOT EXISTS wiki_embedding_page ON wiki_embedding_indexes(page_id,page_revision);
CREATE TABLE IF NOT EXISTS wiki_embedding_requests(id TEXT PRIMARY KEY,state TEXT NOT NULL,document TEXT NOT NULL);
`
