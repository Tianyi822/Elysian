package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"
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
	seq, err := numberCursor(session.LastSeq)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO sessions(id,last_activity_at,active_run_id,last_seq,document,active_workflow_id) VALUES(?,?,?,?,?,?)
 ON CONFLICT(id) DO UPDATE SET last_activity_at=excluded.last_activity_at,active_run_id=excluded.active_run_id,last_seq=excluded.last_seq,document=excluded.document,active_workflow_id=excluded.active_workflow_id`, session.ID, session.LastActivityAt, session.ActiveRunID, seq, string(raw), session.ActiveWorkflowID)
	return err
}

func (s *store) createSession(ctx context.Context, session Session) error {
	return s.write(ctx, "create-session", func(tx *sql.Tx) error { return saveSession(ctx, tx, session) })
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
	seq, err := numberCursor(session.LastSeq)
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
			if err = json.Unmarshal([]byte(prior), &run); err != nil {
				return err
			}
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
			if err = validateAttachmentSet(rows, run.Limits); err != nil {
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
		if err = snapshotWikiRunSpaces(ctx, tx, run.ID, session.ID); err != nil {
			return err
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

// ModelPointerPublic 防止内部凭据对象被快照长期持有。
func (r *Run) ModelPointerPublic() {
	if r.Model != nil {
		public := r.Model.Public()
		r.Model = &public
	}
}

func (s *store) releaseSession(ctx context.Context, tx *sql.Tx, r *Run) error {
	if terminal(r.Status) {
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

// sessionDeletableGuardSQL 是会话可删除的硬性守卫：无排队或运行中的 Run，也没有
// 结果未确认的执行（非终态 Run、held/unknown 资源租约、dispatched/unknown 执行屏障）。
// 保留期清理与手工删除共用同一谓词，防止两路判定漂移；屏障与租约只能经显式结果
// 或执行对账解除，先拒删而不是留下外键失败或永久锁死派发的孤儿行。
const sessionDeletableGuardSQL = `active_run_id='' AND active_workflow_id=''
 AND NOT EXISTS(SELECT 1 FROM runs WHERE runs.session_id=sessions.id AND state IN ('queued','running','waiting-approval','waiting-resource'))
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

func (s *store) deleteSession(ctx context.Context, id string) error {
	return s.write(ctx, "delete-session", func(tx *sql.Tx) error {
		session, err := readSession(ctx, tx, id)
		if err != nil {
			return err
		}
		if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
			return &Error{Status: 409, Code: "session-busy", Message: "会话仍有任务排队或运行，请结束后再删除"}
		}
		var deletable int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM sessions WHERE id=? AND "+sessionDeletableGuardSQL, id).Scan(&deletable); err != nil {
			return err
		}
		if deletable == 0 {
			return &Error{Status: 409, Code: "session-unresolved", Message: "会话存在结果未确认的执行（如面板重启时的在途操作），暂不能删除；需经执行对账接口确认停止后解除"}
		}
		return s.deleteSessionRows(ctx, tx, id)
	})
}

// deleteSessionRows 按固定次序级联删除一个会话的全部行：purgeRecordOwner 先登记
// JSONL 清理账本，dispatched/unknown 屏障刻意不删（调用方守卫已拒删这类会话），
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
	if _, err := tx.ExecContext(ctx, "DELETE FROM execution_barriers WHERE run_id IN (SELECT id FROM runs WHERE session_id=?) AND state NOT IN ('dispatched','unknown')", id); err != nil {
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

// 取消保留已接收的公开片段，既不提交成功终答，也不触发记忆整理。
func (s *store) saveStoppedReply(ctx context.Context, tx *sql.Tx, run Run) error {
	records, err := readDocuments[ModelRequestRecord](ctx, tx, "SELECT document FROM model_requests WHERE run_id=? ORDER BY request_index", run.ID)
	if err != nil {
		return err
	}
	output := chatOutput(run, records)
	if output.Content == "" {
		return nil
	}
	message := Message{ID: randomID(), SessionID: run.SessionID, TaskID: run.TaskID, RunID: run.ID, Role: "assistant", Content: output.Content, RunStatus: StateCancelled}
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
		msg := Message{ID: randomID(), SessionID: r.SessionID, TaskID: r.TaskID, RunID: r.ID, Role: "assistant", Content: answer, CreatedAt: stamp(s.now()), RunStatus: r.Status}
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
