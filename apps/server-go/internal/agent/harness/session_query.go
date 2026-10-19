package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

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
	limit, err := pageSize(n, 50)
	if err != nil {
		return Page[Session]{}, err
	}
	cursor, err := numberCursor(cursorRaw)
	if err != nil {
		return Page[Session]{}, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT rowid,document FROM sessions WHERE (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?", cursor, cursor, limit+1)
	if err != nil {
		return Page[Session]{}, err
	}
	return documentPage[Session](rows, limit, 0, "")
}

func (s *store) tasks(ctx context.Context, sessionID, cursorRaw string, n int) (Page[Task], error) {
	if _, err := readSession(ctx, s.db, sessionID); err != nil {
		return Page[Task]{}, err
	}
	limit, err := pageSize(n, 50)
	if err != nil {
		return Page[Task]{}, err
	}
	cursor, err := numberCursor(cursorRaw)
	if err != nil {
		return Page[Task]{}, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT rowid,document FROM tasks WHERE session_id=? AND (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?", sessionID, cursor, cursor, limit+1)
	if err != nil {
		return Page[Task]{}, err
	}
	return documentPage[Task](rows, limit, 0, "")
}

func (s *store) messages(ctx context.Context, sessionID, after string, n int) (Page[Message], error) {
	session, err := readSession(ctx, s.db, sessionID)
	if err != nil {
		return Page[Message]{}, err
	}
	limit, err := pageSize(n, 100)
	if err != nil {
		return Page[Message]{}, err
	}
	cursor, err := numberCursor(after)
	if err != nil {
		return Page[Message]{}, err
	}
	last, err := numberCursor(session.LastSeq)
	if err != nil {
		return Page[Message]{}, err
	}
	if cursor > last {
		return Page[Message]{}, bad("future-cursor", "消息游标超过当前会话进度")
	}
	// runConfig 从 Run 固定快照回填，旧消息无需迁移即可获得所属轮次的模型与思考等级；
	// 模型已被删除或旧记录没有快照时字段为空，前端按未知处理。
	rows, err := s.db.QueryContext(ctx, `SELECT m.seq,json_set(m.document,'$.runStatus',r.state,'$.runConfig',json_object(
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
}

func (s *store) memory(ctx context.Context, taskID string, revision int) (WorkingMemory, error) {
	task, err := readTask(ctx, s.db, taskID)
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
	err = s.db.QueryRowContext(ctx, "SELECT document FROM working_memories WHERE task_id=? AND (?=0 OR revision=?) ORDER BY revision DESC LIMIT 1", taskID, revision, revision).Scan(&raw)
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
}

func (s *store) modelRequests(ctx context.Context, id, cursorRaw string, n int) (Page[ModelRequestRecord], error) {
	if _, err := readRun(ctx, s.db, id); err != nil {
		return Page[ModelRequestRecord]{}, err
	}
	limit, err := pageSize(n, 50)
	if err != nil {
		return Page[ModelRequestRecord]{}, err
	}
	cursor, err := numberCursor(cursorRaw)
	if err != nil {
		return Page[ModelRequestRecord]{}, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT request_index,document FROM model_requests WHERE run_id=? AND request_index>=? ORDER BY request_index LIMIT ?", id, cursor, limit+1)
	if err != nil {
		return Page[ModelRequestRecord]{}, err
	}
	return documentPage[ModelRequestRecord](rows, limit, 1, "")
}

func (s *store) latestRun(ctx context.Context, taskID string) (*Run, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT document FROM runs WHERE task_id=? ORDER BY run_number DESC LIMIT 1", taskID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var run Run
	err = json.Unmarshal([]byte(raw), &run)
	run.Task = nil
	return &run, err
}
