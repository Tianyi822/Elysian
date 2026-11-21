package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"time"

	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/tools"
)

type rowReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readSession(ctx context.Context, q rowReader, id string) (Session, error) {
	var raw string
	var session Session
	err := q.QueryRowContext(ctx, "SELECT document FROM sessions WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return session, &Error{Status: 404, Code: "session-not-found", Message: "Agent 会话不存在"}
	}
	if err != nil {
		return session, err
	}
	err = json.Unmarshal([]byte(raw), &session)
	return session, err
}

func readTask(ctx context.Context, q rowReader, id string) (Task, error) {
	var raw string
	var task Task
	err := q.QueryRowContext(ctx, "SELECT document FROM tasks WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return task, &Error{Status: 404, Code: "task-not-found", Message: "Agent 任务不存在"}
	}
	if err != nil {
		return task, err
	}
	err = json.Unmarshal([]byte(raw), &task)
	return task, err
}

func saveSession(ctx context.Context, tx *sql.Tx, session Session) error {
	session.ModelChange = nil
	session.Notices = nil
	raw, err := json.Marshal(session)
	if err != nil {
		return err
	}
	seq, err := hstate.NumberCursor(session.LastSeq)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO sessions(id,last_activity_at,active_run_id,last_seq,document,active_workflow_id) VALUES(?,?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET last_activity_at=excluded.last_activity_at,active_run_id=excluded.active_run_id,last_seq=excluded.last_seq,document=excluded.document,active_workflow_id=excluded.active_workflow_id`, session.ID, session.LastActivityAt, session.ActiveRunID, seq, string(raw), session.ActiveWorkflowID)
	return err
}

func (s *store) createSession(ctx context.Context, session Session) error {
	return s.write(ctx, "create-session", func(tx *sql.Tx) error {
		if err := saveSession(ctx, tx, session); err != nil {
			return err
		}
		if session.WikiStrategy != wikiNavigationStrategy {
			return nil
		}
		space, err := ensureGlobalWikiSpace(ctx, tx, stamp(s.now()))
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(WikiSpaceSelection{SpaceID: space.ID})
		_, err = tx.ExecContext(ctx, "INSERT INTO wiki_session_spaces(session_id,document) VALUES(?,?)", session.ID, string(raw))
		return err
	})
}

func (s *store) switchModel(ctx context.Context, id, profile string, revision int) (Session, error) {
	var session Session
	err := s.write(ctx, "switch-model", func(tx *sql.Tx) error {
		var err error
		session, err = readSession(ctx, tx, id)
		if err != nil {
			return err
		}
		if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
			return &Error{Status: 409, Code: "session-busy", Message: "会话仍有任务排队或运行，请结束后再切换模型"}
		}
		if session.ModelProfileID == profile && session.ModelRevision == revision {
			return nil
		}
		session.ModelProfileID, session.ModelRevision = profile, revision
		session.LastActivityAt = stamp(s.now())
		session.Notices = []string{"模型能力可能变化；切换后的首轮缓存命中率可能下降，实际取决于模型与供应商"}
		return saveSession(ctx, tx, session)
	})
	return session, err
}

func (s *store) appendMessage(ctx context.Context, tx *sql.Tx, msg *Message) error {
	session, err := readSession(ctx, tx, msg.SessionID)
	if err != nil {
		return err
	}
	seq, err := hstate.NumberCursor(session.LastSeq)
	if err != nil {
		return err
	}
	if seq == int64(^uint64(0)>>1) {
		return errors.New("会话消息序号已达到上限")
	}
	msg.Seq = strconv.FormatInt(seq+1, 10)
	if msg.CreatedAt == "" {
		msg.CreatedAt = stamp(s.now())
	}
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO messages(id,session_id,task_id,run_id,seq,role,document) VALUES(?,?,?,?,?,?,?)", msg.ID, msg.SessionID, msg.TaskID, msg.RunID, seq+1, msg.Role, string(raw)); err != nil {
		return err
	}
	session.LastSeq, session.LastActivityAt = msg.Seq, msg.CreatedAt
	return saveSession(ctx, tx, session)
}

// acceptAgent 同一事务内去重、分配轮次、占用会话并追加用户消息。
func (s *store) acceptAgent(ctx context.Context, task Task, run Run, canonical, messageID string, newTask bool) (Run, bool, error) {
	duplicate := false
	err := s.write(ctx, "submit-agent", func(tx *sql.Tx) error {
		var prior, priorInput string
		err := tx.QueryRowContext(ctx, "SELECT document,canonical_input FROM runs WHERE request_id=?", run.RequestID).Scan(&prior, &priorInput)
		if err == nil {
			if priorInput != canonical {
				return &Error{Status: 409, Code: "request-conflict", Message: "请求标识已用于不同的任务输入"}
			}
			var accepted Run
			if err = json.Unmarshal([]byte(prior), &accepted); err != nil {
				return err
			}
			if accepted.SessionID != run.SessionID || !newTask && accepted.TaskID != task.ID {
				return &Error{Status: 409, Code: "request-conflict", Message: "请求标识已绑定其它会话或任务"}
			}
			run = accepted
			oldTask, err := readTask(ctx, tx, run.TaskID)
			if err != nil {
				return err
			}
			run.Task = &oldTask
			duplicate = true
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		session, err := readSession(ctx, tx, run.SessionID)
		if err != nil {
			return err
		}
		if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
			return &Error{Status: 409, Code: "session-busy", Message: "会话仍有任务排队或运行，请结束后再输入"}
		}
		if run.Model == nil || run.Model.ID != session.ModelProfileID || run.Model.Revision != session.ModelRevision {
			return &Error{Status: 409, Code: "model-changed", Message: "会话模型已变化，请重新提交"}
		}
		var queue int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(&queue); err != nil {
			return err
		}
		if queue >= run.Limits.QueueCapacity {
			return &Error{Status: 429, Code: "queue-full", Message: "任务队列已满，请稍后重试"}
		}
		if newTask {
			raw, err := json.Marshal(task)
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO tasks(id,request_id,input,document,session_id) VALUES(?,?,?,?,?)", task.ID, task.RequestID, canonical, string(raw), task.SessionID); err != nil {
				return err
			}
		} else {
			task, err = readTask(ctx, tx, task.ID)
			if err != nil {
				return err
			}
			if task.SessionID != session.ID || task.Kind != "agent" {
				return bad("invalid-task", "该任务不支持会话续轮")
			}
		}
		if err := prepareContinuation(ctx, tx, &run); err != nil {
			return err
		}
		var attachmentDescs []MessageAttachment
		if run.Selection != nil && len(run.Selection.Attachments) > 0 {
			// 附件绑定与任务接受同事务：任一 id 不存在或已绑定其他会话即整体回滚；
			// 「已绑定本会话」放行以支撑编辑重发复用原轮 id（replaceLastMessage 只标
			// supersededByRunId，旧轮附件仍绑定本会话）。核对以本事务内 SELECT 为准，
			// 不依赖驱动 RowsAffected 对「值未变化行」的计数口径。
			rows, err := readAttachmentRows(ctx, tx, run.Selection.Attachments, session.ID)
			if err != nil {
				return err
			}
			if err = hstate.ValidateAttachmentSet(rows, run.Limits); err != nil {
				return err
			}
			if err = bindAttachments(ctx, tx, session.ID, run.Selection.Attachments); err != nil {
				return err
			}
			attachmentDescs = make([]MessageAttachment, 0, len(rows))
			for _, row := range rows {
				attachmentDescs = append(attachmentDescs, row.MessageAttachment)
			}
		}
		msg := Message{Attachments: attachmentDescs, ID: messageID, SessionID: session.ID, TaskID: task.ID, RunID: run.ID, Role: "user", Content: run.Input, CreatedAt: run.CreatedAt}
		if run.Selection != nil && run.Selection.ReplaceMessageID != "" {
			if err = s.replaceLastMessage(ctx, tx, &task, &run, &msg); err != nil {
				return err
			}
		}
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(run_number),0)+1 FROM runs WHERE task_id=?", task.ID).Scan(&run.RunNumber); err != nil {
			return err
		}
		if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(revision),0) FROM working_memories WHERE task_id=?", task.ID).Scan(&run.InitialMemoryRevision); err != nil {
			return err
		}
		run.MemoryStatus = "stale"
		run.HistorySeq = session.LastSeq
		run.ModelPointerPublic()
		raw, err := json.Marshal(run)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO runs(id,task_id,state,created_at,document,session_id,request_id,canonical_input,run_number) VALUES(?,?,?,?,?,?,?,?,?)", run.ID, task.ID, run.Status, run.CreatedAt, string(raw), session.ID, run.RequestID, canonical, run.RunNumber); err != nil {
			return err
		}
		if run.WikiStrategy != wikiDisabledStrategy {
			if err = snapshotWikiRunSpaces(ctx, tx, run.ID, session.ID); err != nil {
				return err
			}
		}
		session.ActiveRunID, session.Notices = run.ID, nil
		if err = saveSession(ctx, tx, session); err != nil {
			return err
		}
		if err = s.appendMessage(ctx, tx, &msg); err != nil {
			return err
		}
		if err = s.event(ctx, tx, &run, "run/queued", "", nil, nil); err != nil {
			return err
		}
		run.Task = &task
		return nil
	})
	return run, duplicate, err
}

func (s *store) releaseSession(ctx context.Context, tx *sql.Tx, r *Run) error {
	if hstate.Terminal(r.Status) {
		if err := cancelUserInputs(ctx, tx, r.ID, stamp(s.now())); err != nil {
			return err
		}
		if err := releaseWaitingResourceLeases(ctx, tx, r.ID, stamp(s.now())); err != nil {
			return err
		}
	}
	if r.SessionID == "" {
		return nil
	}
	var pending int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM model_requests WHERE run_id=? AND state='running'", r.ID).Scan(&pending); err != nil {
		return err
	}
	if pending > 0 {
		r.Usage.ActualTokens = nil
		r.Usage.CachedTokens = nil
		if err := saveRun(ctx, tx, r); err != nil {
			return err
		}
	}
	if err := interruptModelRequests(ctx, tx, r.ID, s.now()); err != nil {
		return err
	}
	if r.WorkflowID != "" {
		if err := s.finishWorkflowRun(ctx, tx, r); err != nil {
			return err
		}
		w, err := readWorkflow(ctx, tx, r.WorkflowID)
		if err != nil {
			return err
		}
		return s.releaseWorkflowSession(ctx, tx, w)
	}
	session, err := readSession(ctx, tx, r.SessionID)
	if err != nil {
		return err
	}
	if session.ActiveRunID != r.ID {
		return nil
	}
	session.ActiveRunID = ""
	session.LastActivityAt = r.EndedAt
	if session.LastActivityAt == "" {
		session.LastActivityAt = stamp(s.now())
	}
	return saveSession(ctx, tx, session)
}

// sessionDeletableGuardSQL 仅用于自动保留期清理；人工删除由管理员显式强制终止。
const sessionDeletableGuardSQL = `active_run_id='' AND active_workflow_id=''
 AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.session_id=sessions.id AND state IN ('queued','running','waiting-input','waiting-approval','waiting-resource','waiting-task','waiting-recovery','waiting-model','waiting-storage'))
 AND NOT EXISTS(SELECT 1 FROM resource_leases l JOIN runs r ON r.id=l.run_id WHERE r.session_id=sessions.id AND l.state IN ('held','unknown'))
 AND NOT EXISTS(SELECT 1 FROM execution_barriers b JOIN runs r ON r.id=b.run_id WHERE r.session_id=sessions.id AND b.state IN ('dispatched','unknown'))`

func (s *store) renameSession(ctx context.Context, id, title string) (Session, error) {
	var session Session
	err := s.write(ctx, "rename-session", func(tx *sql.Tx) error {
		var err error
		session, err = readSession(ctx, tx, id)
		if err != nil {
			return err
		}
		session.Title = title
		return saveSession(ctx, tx, session)
	})
	return session, err
}

func (s *store) deleteSession(ctx context.Context, id string, extraTasks ...tools.TaskReference) error {
	return s.write(ctx, "delete-session", func(tx *sql.Tx) error {
		if _, err := readSession(ctx, tx, id); err != nil {
			return err
		}
		// 与删除同事务保存取消清单；进程退出或域暂不可用时继续收尾。
		operations, err := readDocuments[Operation](ctx, tx, "SELECT document FROM operations WHERE run_id IN (SELECT id FROM runs WHERE session_id=?) AND state IN ('dispatched','unknown','waiting-task')", id)
		if err != nil {
			return err
		}
		for _, operation := range operations {
			if operation.Task != nil {
				if err := enqueueTaskCancellation(ctx, tx, *operation.Task); err != nil {
					return err
				}
			}
		}
		for _, ref := range extraTasks {
			if err := enqueueTaskCancellation(ctx, tx, ref); err != nil {
				return err
			}
		}
		return s.deleteSessionRows(ctx, tx, id)
	})
}

// deleteSessionRows 按固定次序级联删除一个会话的全部行：purgeRecordOwner 先登记
// JSONL 清理账本，显式清除屏障与无外键的租约，
// workflow_instances 必须先于 tasks（V2 scope 持有 Task 引用）。
func (s *store) deleteSessionRows(ctx context.Context, tx *sql.Tx, id string) error {
	if err := purgeRecordOwner(ctx, tx, recordOwner{kind: "session", id: id}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO wiki_cleared_sources(run_id,cleared_at) SELECT id,? FROM runs WHERE session_id=?", stamp(s.now()), id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM wiki_visible_pages WHERE (owner_kind='run' AND owner_id IN (SELECT id FROM runs WHERE session_id=?)) OR (owner_kind='workflow' AND owner_id IN (SELECT id FROM workflow_instances WHERE session_id=?))", id, id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO workspace_cleanup(task_id) SELECT id FROM tasks WHERE session_id=?", id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM execution_barriers WHERE run_id IN (SELECT id FROM runs WHERE session_id=?)", id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM resource_leases WHERE run_id IN (SELECT id FROM runs WHERE session_id=?)", id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM runs WHERE session_id=?", id); err != nil {
		return err
	}
	// V2 scopes retain Task references. Remove their owning instances first
	// so the scope/node cascades finish before deleting session Tasks.
	if _, err := tx.ExecContext(ctx, "DELETE FROM workflow_instances WHERE session_id=?", id); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM tasks WHERE session_id=?", id); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", id)
	return err
}

func (s *store) sweepSessions(ctx context.Context, tx *sql.Tx, cutoff string) error {
	rows, err := tx.QueryContext(ctx, `SELECT id FROM sessions WHERE `+sessionDeletableGuardSQL+` AND julianday(last_activity_at)<julianday(?)`, cutoff)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err = s.deleteSessionRows(ctx, tx, id); err != nil {
			return err
		}
	}
	return nil
}

func saveModelRequest(ctx context.Context, tx *sql.Tx, record ModelRequestRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO model_requests(id,run_id,request_index,state,document) VALUES(?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, record.ID, record.RunID, record.Index, record.Status, string(raw))
	return err
}

// 取消或维护中断保留已接收的公开片段，不提交成功终答或触发记忆整理。
func (s *store) saveStoppedReply(ctx context.Context, tx *sql.Tx, run Run) error {
	records, err := readDocuments[ModelRequestRecord](ctx, tx, "SELECT document FROM model_requests WHERE run_id=? ORDER BY request_index", run.ID)
	if err != nil {
		return err
	}
	output := hstate.ProjectChatOutput(run, records)
	if output.Content == "" {
		return nil
	}
	message := Message{ID: hstate.RandomID(), SessionID: run.SessionID, TaskID: run.TaskID, RunID: run.ID, Role: "assistant", Content: output.Content, RunStatus: run.Status}
	if err = s.appendMessage(ctx, tx, &message); err != nil {
		return err
	}
	return recordWikiRunArtifact(ctx, tx, run, "message", message.ID)
}

func interruptModelRequests(ctx context.Context, tx *sql.Tx, runID string, now time.Time) error {
	rows, err := tx.QueryContext(ctx, "SELECT document FROM model_requests WHERE run_id=? AND state='running'", runID)
	if err != nil {
		return err
	}
	var records []ModelRequestRecord
	for rows.Next() {
		var raw string
		var record ModelRequestRecord
		if err = rows.Scan(&raw); err == nil {
			err = json.Unmarshal([]byte(raw), &record)
		}
		if err != nil {
			rows.Close()
			return err
		}
		records = append(records, record)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, record := range records {
		record.Status = StateInterrupted
		record.EndedAt = stamp(now)
		record.Error = &Failure{Code: "outcome-unknown", Message: "模型请求中断，结果未确认"}
		if err = saveModelRequest(ctx, tx, record); err != nil {
			return err
		}
	}
	return nil
}

func saveWorkingMemory(ctx context.Context, tx *sql.Tx, memory WorkingMemory) error {
	var current int
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(revision),0) FROM working_memories WHERE task_id=?", memory.TaskID).Scan(&current); err != nil {
		return err
	}
	if memory.Revision != current+1 {
		return &Error{Status: 409, Code: "memory-conflict", Message: "任务工作记忆版本已变化"}
	}
	snapshot := memory
	snapshot.Objective = ""
	snapshot.MemoryStatus = ""
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO working_memories(task_id,revision,document) VALUES(?,?,?)", memory.TaskID, memory.Revision, string(raw))
	return err
}

// finalizeAgent 只提交答复和记忆；终态优先级由调用方在同一事务内裁决。
func (s *store) finalizeAgent(ctx context.Context, tx *sql.Tx, r *Run, answer string, memory *WorkingMemory) error {
	if r.SessionID == "" {
		return nil
	}
	if answer != "" && r.Status == StateSucceeded {
		msg := Message{ID: hstate.RandomID(), SessionID: r.SessionID, TaskID: r.TaskID, RunID: r.ID, Role: "assistant", Content: answer, CreatedAt: stamp(s.now()), RunStatus: r.Status}
		if err := s.appendMessage(ctx, tx, &msg); err != nil {
			return err
		}
	}
	if memory != nil {
		if r.Status != StateSucceeded {
			return errors.New("非成功运行不能更新工作记忆")
		}
		copy := *memory
		copy.TaskID = r.TaskID
		copy.UpdatedAt = stamp(s.now())
		copy.MemoryStatus = ""
		if err := saveWorkingMemory(ctx, tx, copy); err != nil {
			return err
		}
		r.MemoryStatus = "updated"
	}
	return nil
}

func documentPage[T any](rows *sql.Rows, limit int, nextOffset int64, retainCursor string) (Page[T], error) {
	page := Page[T]{Items: []T{}, NextCursor: retainCursor}
	defer rows.Close()
	var last int64
	for rows.Next() {
		var index int64
		var raw string
		var item T
		if err := rows.Scan(&index, &raw); err != nil {
			return page, err
		}
		if len(page.Items) == limit {
			page.HasMore = true
			break
		}
		if err := json.Unmarshal([]byte(raw), &item); err != nil {
			return page, err
		}
		page.Items = append(page.Items, item)
		last = index + nextOffset
	}
	if page.HasMore || (retainCursor != "" && len(page.Items) > 0) {
		page.NextCursor = strconv.FormatInt(last, 10)
	}
	return page, rows.Err()
}

func (s *store) sessions(ctx context.Context, cursorRaw string, n int) (Page[Session], error) {
	return storeRead(ctx, s, "sessions", func(ctx context.Context) (Page[Session], error) {
		limit, err := hstate.PageSize(n, 50)
		if err != nil {
			return Page[Session]{}, err
		}
		cursor, err := hstate.NumberCursor(cursorRaw)
		if err != nil {
			return Page[Session]{}, err
		}
		rows, err := s.reader(ctx).QueryContext(ctx, "SELECT rowid,document FROM sessions WHERE (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?", cursor, cursor, limit+1)
		if err != nil {
			return Page[Session]{}, err
		}
		return documentPage[Session](rows, limit, 0, "")
	})
}

func (s *store) tasks(ctx context.Context, sessionID, cursorRaw string, n int) (Page[Task], error) {
	return storeRead(ctx, s, "tasks", func(ctx context.Context) (Page[Task], error) {
		if _, err := readSession(ctx, s.reader(ctx), sessionID); err != nil {
			return Page[Task]{}, err
		}
		limit, err := hstate.PageSize(n, 50)
		if err != nil {
			return Page[Task]{}, err
		}
		cursor, err := hstate.NumberCursor(cursorRaw)
		if err != nil {
			return Page[Task]{}, err
		}
		rows, err := s.reader(ctx).QueryContext(ctx, "SELECT rowid,document FROM tasks WHERE session_id=? AND (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?", sessionID, cursor, cursor, limit+1)
		if err != nil {
			return Page[Task]{}, err
		}
		return documentPage[Task](rows, limit, 0, "")
	})
}

func (s *store) messages(ctx context.Context, sessionID, after string, n int) (Page[Message], error) {
	return storeRead(ctx, s, "messages", func(ctx context.Context) (Page[Message], error) {
		session, err := readSession(ctx, s.reader(ctx), sessionID)
		if err != nil {
			return Page[Message]{}, err
		}
		limit, err := hstate.PageSize(n, 100)
		if err != nil {
			return Page[Message]{}, err
		}
		cursor, err := hstate.NumberCursor(after)
		if err != nil {
			return Page[Message]{}, err
		}
		last, err := hstate.NumberCursor(session.LastSeq)
		if err != nil {
			return Page[Message]{}, err
		}
		if cursor > last {
			return Page[Message]{}, bad("future-cursor", "消息游标超过当前会话进度")
		}
		// runConfig 从 Run 固定快照回填，旧消息无需迁移即可获得所属轮次的模型与思考等级；
		// 模型已被删除或旧记录没有快照时字段为空，前端按未知处理。
		rows, err := s.reader(ctx).QueryContext(ctx, `SELECT m.seq,json_set(m.document,'$.runStatus',r.state,'$.runConfig',json_object(
		'modelName',json_extract(r.document,'$.model.model'),
		'modelService',json_extract(r.document,'$.model.service.name'),
		'modelProfileId',json_extract(r.document,'$.model.id'),
		'modelRevision',json_extract(r.document,'$.model.revision'),
		'reasoningLevel',json_extract(r.document,'$.selection.reasoningLevel')
	)) FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.session_id=? AND m.seq>? AND `+visibleRunSQL+` ORDER BY m.seq LIMIT ?`, sessionID, cursor, limit+1)
		if err != nil {
			return Page[Message]{}, err
		}
		return documentPage[Message](rows, limit, 0, strconv.FormatInt(cursor, 10))
	})
}

func (s *store) memory(ctx context.Context, taskID string, revision int) (WorkingMemory, error) {
	return storeRead(ctx, s, "memory", func(ctx context.Context) (WorkingMemory, error) {
		task, err := readTask(ctx, s.reader(ctx), taskID)
		if err != nil {
			return WorkingMemory{}, err
		}
		if task.Kind != "agent" && task.Kind != "workflow" {
			return WorkingMemory{}, bad("invalid-task", "该任务不包含 Agent 工作记忆")
		}
		if revision < 0 {
			return WorkingMemory{}, bad("invalid-revision", "工作记忆版本不能为负数")
		}
		var raw string
		err = s.reader(ctx).QueryRowContext(ctx, "SELECT document FROM working_memories WHERE task_id=? AND (?=0 OR revision=?) ORDER BY revision DESC LIMIT 1", taskID, revision, revision).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			if revision > 0 {
				return WorkingMemory{}, &Error{Status: 404, Code: "memory-not-found", Message: "工作记忆版本不存在"}
			}
			return WorkingMemory{TaskID: taskID, Objective: task.Goal, Coverage: MemoryCursor{EventSeq: "0"}, Constraints: []string{}, Facts: []MemoryFact{}, Todos: []string{}, OpenQuestions: []string{}}, nil
		}
		if err != nil {
			return WorkingMemory{}, err
		}
		var memory WorkingMemory
		err = json.Unmarshal([]byte(raw), &memory)
		memory.Objective = task.Goal
		return memory, err
	})
}

func (s *store) modelRequests(ctx context.Context, id, cursorRaw string, n int) (Page[ModelRequestRecord], error) {
	return storeRead(ctx, s, "modelRequests", func(ctx context.Context) (Page[ModelRequestRecord], error) {
		if _, err := readRun(ctx, s.reader(ctx), id); err != nil {
			return Page[ModelRequestRecord]{}, err
		}
		limit, err := hstate.PageSize(n, 50)
		if err != nil {
			return Page[ModelRequestRecord]{}, err
		}
		cursor, err := hstate.NumberCursor(cursorRaw)
		if err != nil {
			return Page[ModelRequestRecord]{}, err
		}
		rows, err := s.reader(ctx).QueryContext(ctx, "SELECT request_index,document FROM model_requests WHERE run_id=? AND request_index>=? ORDER BY request_index LIMIT ?", id, cursor, limit+1)
		if err != nil {
			return Page[ModelRequestRecord]{}, err
		}
		return documentPage[ModelRequestRecord](rows, limit, 1, "")
	})
}

func (s *store) latestRun(ctx context.Context, taskID string) (*Run, error) {
	return storeRead(ctx, s, "latestRun", func(ctx context.Context) (*Run, error) {
		var raw string
		err := s.reader(ctx).QueryRowContext(ctx, "SELECT document FROM runs WHERE task_id=? ORDER BY run_number DESC LIMIT 1", taskID).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		var run Run
		err = json.Unmarshal([]byte(raw), &run)
		run.Task = nil
		if err == nil {
			run.Continuation, err = continuation(ctx, s.reader(ctx), run)
		}
		return &run, err
	})
}

func (s *store) sessionsByActivity(ctx context.Context, cursorRaw string, n int) (Page[Session], error) {
	return storeRead(ctx, s, "sessionsByActivity", func(ctx context.Context) (Page[Session], error) {
		page := Page[Session]{Items: []Session{}}
		limit, err := hstate.PageSize(n, 50)
		if err != nil {
			return page, err
		}
		cursor, err := decodeSessionActivityCursor(cursorRaw)
		if err != nil {
			return page, err
		}
		var activityMS int64
		if cursor.ActivityMS != nil {
			activityMS = *cursor.ActivityMS
		}
		rows, err := s.reader(ctx).QueryContext(ctx, `WITH activity_sessions AS (
 SELECT id,document,`+sessionActivityMillisSQL+` AS activity_ms FROM sessions
 ) SELECT activity_ms,id,document FROM activity_sessions
 WHERE (?='' OR activity_ms<? OR (activity_ms=? AND id<?))
 ORDER BY activity_ms DESC,id DESC LIMIT ?`, cursorRaw, activityMS, activityMS, cursor.ID, limit+1)
		if err != nil {
			return page, err
		}
		defer rows.Close()
		var lastMS int64
		var lastID string
		for rows.Next() {
			if len(page.Items) == limit {
				page.HasMore = true
				break
			}
			var raw string
			var session Session
			if err = rows.Scan(&lastMS, &lastID, &raw); err != nil {
				return page, err
			}
			if err = json.Unmarshal([]byte(raw), &session); err != nil {
				return page, err
			}
			page.Items = append(page.Items, session)
		}
		if page.HasMore {
			page.NextCursor = encodeSessionActivityCursor(lastMS, lastID)
		}
		return page, rows.Err()
	})
}

func decodeSessionActivityCursor(raw string) (sessionActivityCursor, error) {
	var cursor sessionActivityCursor
	if raw == "" {
		return cursor, nil
	}
	invalid := func() (sessionActivityCursor, error) {
		return sessionActivityCursor{}, bad("invalid-cursor", "会话活动分页游标无效，请刷新列表")
	}
	if len(raw) > 256 {
		return invalid()
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(raw)
	if err != nil {
		return invalid()
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&cursor); err != nil || cursor.Version != 1 || cursor.ActivityMS == nil || cursor.ID == "" {
		return invalid()
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return invalid()
	}
	return cursor, nil
}

func encodeSessionActivityCursor(ms int64, id string) string {
	payload, _ := json.Marshal(sessionActivityCursor{Version: 1, ActivityMS: &ms, ID: id})
	return base64.RawURLEncoding.EncodeToString(payload)
}

// stamp 保证活动时间为 UTC RFC3339Nano。先取整秒再截断小数至毫秒，
// 避免 RFC3339Nano 的可变小数位字典序及 SQLite 日期函数四舍五入改变边界。
const sessionActivityMillisSQL = `CAST(strftime('%s', substr(last_activity_at,1,19) || 'Z') AS INTEGER) * 1000
 + CASE WHEN substr(last_activity_at,20,1)='.'
   THEN CAST(substr(rtrim(substr(last_activity_at,21),'Z') || '000',1,3) AS INTEGER)
   ELSE 0 END`

// 活动游标与原有 rowid 数字游标属于不同分页协议，不能互换。
type sessionActivityCursor struct {
	Version    int    `json:"v"`
	ActivityMS *int64 `json:"ms"`
	ID         string `json:"id"`
}

func (s *store) replaceLastMessage(ctx context.Context, tx *sql.Tx, task *Task, run *Run, replacement *Message) error {
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT m.document FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.session_id=? AND m.role='user' AND "+visibleRunSQL+" ORDER BY m.seq DESC LIMIT 1", run.SessionID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return bad("invalid-replacement", "没有可以编辑的用户消息")
	}
	if err != nil {
		return err
	}
	var message Message
	if err = json.Unmarshal([]byte(raw), &message); err != nil {
		return err
	}
	if message.ID != run.Selection.ReplaceMessageID || message.TaskID != task.ID {
		return &Error{Status: 409, Code: "message-changed", Message: "最后一条消息已变化，请重新读取后编辑"}
	}
	// 连续编辑沿用原始消息标识，错过中间版本的标签页也能移除旧轮。
	replacement.ReplacesMessageID = message.ID
	if message.ReplacesMessageID != "" {
		replacement.ReplacesMessageID = message.ReplacesMessageID
	}
	old, err := readRun(ctx, tx, message.RunID)
	if err != nil {
		return err
	}
	if !hstate.Terminal(old.Status) || old.WorkflowID != "" {
		return &Error{Status: 409, Code: "session-busy", Message: "会话仍在运行，请结束后再编辑"}
	}
	var latest string
	if err = tx.QueryRowContext(ctx, "SELECT id FROM runs WHERE task_id=? ORDER BY run_number DESC LIMIT 1", task.ID).Scan(&latest); err != nil {
		return err
	}
	if latest != old.ID {
		return &Error{Status: 409, Code: "message-changed", Message: "最后一轮已变化，请重新读取后编辑"}
	}

	// 恢复开始前的快照，但分配新的修订，历史记忆和 JSONL 均保持可追溯。
	memory := WorkingMemory{TaskID: task.ID, Coverage: MemoryCursor{EventSeq: "0"}, Constraints: []string{}, Facts: []MemoryFact{}, Todos: []string{}, OpenQuestions: []string{}}
	if old.InitialMemoryRevision > 0 {
		if err = tx.QueryRowContext(ctx, "SELECT document FROM working_memories WHERE task_id=? AND revision=?", task.ID, old.InitialMemoryRevision).Scan(&raw); err != nil {
			return err
		}
		if err = json.Unmarshal([]byte(raw), &memory); err != nil {
			return err
		}
	}
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(revision),0)+1 FROM working_memories WHERE task_id=?", task.ID).Scan(&memory.Revision); err != nil {
		return err
	}
	memory.UpdatedAt = run.CreatedAt
	if err = saveWorkingMemory(ctx, tx, memory); err != nil {
		return err
	}
	before, after := task.ID+":"+strconv.Itoa(old.InitialMemoryRevision), task.ID+":"+strconv.Itoa(memory.Revision)
	if _, err = tx.ExecContext(ctx, "INSERT INTO wiki_artifacts(kind,id,task_id,run_id,generation,invalidated) SELECT kind,?,task_id,run_id,generation,invalidated FROM wiki_artifacts WHERE kind='memory' AND id=?", after, before); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO wiki_dependencies(kind,id,page_id,revision,digest) SELECT kind,?,page_id,revision,digest FROM wiki_dependencies WHERE kind='memory' AND id=?", after, before); err != nil {
		return err
	}

	var earlier int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs r WHERE task_id=? AND run_number<? AND "+visibleRunSQL, task.ID, old.RunNumber).Scan(&earlier); err != nil {
		return err
	}
	if earlier == 0 {
		task.Goal = run.Input
		data, err := json.Marshal(task)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE tasks SET document=? WHERE id=?", string(data), task.ID); err != nil {
			return err
		}
	}
	old.SupersededByRunID = run.ID
	return saveRun(ctx, tx, &old)
}

// 旧轮仍保留审计记录，公开对话和后续模型上下文只读取有效轮次。
const visibleRunSQL = "COALESCE(json_extract(r.document,'$.supersededByRunId'),'')=''"

func enqueueTaskCancellation(ctx context.Context, tx *sql.Tx, ref tools.TaskReference) error {
	if ref.Domain == "" || ref.ID == "" && ref.RequestID == "" {
		return nil
	}
	raw, err := json.Marshal(ref)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO session_task_cleanup(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET retry_at=''", hstate.DigestJSON(ref), string(raw))
	return err
}

// 仅保留取消所需的精确域任务身份，不保留已删会话正文，也不重放原操作。
const sessionTaskCleanupSchema = `CREATE TABLE IF NOT EXISTS session_task_cleanup (
 id TEXT PRIMARY KEY, document TEXT NOT NULL, retry_at TEXT NOT NULL DEFAULT ''
);`

func isNotFound(err error) bool {
	var typed *Error
	return errors.As(err, &typed) && typed.Status == 404
}
