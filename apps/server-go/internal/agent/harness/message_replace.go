package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
)

// 旧轮仍保留审计记录，公开对话和后续模型上下文只读取有效轮次。
const visibleRunSQL = "COALESCE(json_extract(r.document,'$.supersededByRunId'),'')=''"

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
		return &Error{409, "message-changed", "最后一条消息已变化，请重新读取后编辑"}
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
	if !terminal(old.Status) || old.WorkflowID != "" {
		return &Error{409, "session-busy", "会话仍在运行，请结束后再编辑"}
	}
	var latest string
	if err = tx.QueryRowContext(ctx, "SELECT id FROM runs WHERE task_id=? ORDER BY run_number DESC LIMIT 1", task.ID).Scan(&latest); err != nil {
		return err
	}
	if latest != old.ID {
		return &Error{409, "message-changed", "最后一轮已变化，请重新读取后编辑"}
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
