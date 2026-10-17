package harness

import (
	"database/sql"
	"encoding/json"
	"errors"
)

// schemaVersion is bumped whenever a durable execution fact or a memory
// reference changes shape. v6 adds a transactional JSONL record outbox.
// v7 adds the agent chat attachment table; its BLOB bytes never enter the
// JSONL record copy — only reference descriptors ride on Message/Run documents.
// v8 保存可恢复的用户澄清请求。
const schemaVersion = 8

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

func migrateStore(db *sql.DB) error {
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return err
	}
	if version > schemaVersion {
		return errors.New("运行数据库版本高于当前程序，拒绝降级打开")
	}
	if version == schemaVersion {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if version == 0 {
		if _, err = tx.Exec(schema); err != nil {
			return err
		}
	}
	if version < 2 {
		if _, err = tx.Exec(sessionSchema); err != nil {
			return err
		}
		rows, err := tx.Query("SELECT id,request_id,document FROM runs")
		if err != nil {
			return err
		}
		type row struct{ id, request, raw string }
		var records []row
		for rows.Next() {
			var r row
			if err = rows.Scan(&r.id, &r.request, &r.raw); err != nil {
				rows.Close()
				return err
			}
			records = append(records, r)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, record := range records {
			var document map[string]any
			if err = json.Unmarshal([]byte(record.raw), &document); err != nil {
				return err
			}
			document["requestId"], document["runNumber"] = record.request, 1
			encoded, marshalErr := json.Marshal(document)
			if marshalErr != nil {
				return marshalErr
			}
			if _, err = tx.Exec("UPDATE runs SET document=? WHERE id=?", string(encoded), record.id); err != nil {
				return err
			}
		}
	}
	if version < 3 {
		if _, err = tx.Exec(capabilitySchema); err != nil {
			return err
		}
	}
	if version < 4 {
		if _, err = tx.Exec(workflowSchema); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(wikiSchema); err != nil {
		return err
	}
	if _, err = tx.Exec(resourceSchema); err != nil {
		return err
	}
	if _, err = tx.Exec(workflowV2Schema); err != nil {
		return err
	}
	if version < 8 {
		if _, err = tx.Exec(userInputSchema); err != nil {
			return err
		}
		if version >= 6 {
			if err = installRecordTriggers(tx, userInputRecordSpec); err != nil {
				return err
			}
		}
	}
	if version < 6 {
		if err = migrateRecordOutbox(tx); err != nil {
			return err
		}
	}
	if version < 7 {
		if _, err = tx.Exec(attachmentSchema); err != nil {
			return err
		}
	}
	if _, err = tx.Exec("PRAGMA user_version=8"); err != nil {
		return err
	}
	return tx.Commit()
}
