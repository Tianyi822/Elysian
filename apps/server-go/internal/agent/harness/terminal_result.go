package harness

import (
	"context"
	"database/sql"
	"strings"
)

// TerminalResult 是运行内核生成的公开结果，不代表模型答复或已完成的外部操作。
type TerminalResult struct {
	Origin  string `json:"origin"`
	Content string `json:"content"`
}

func (s *store) terminalResult(ctx context.Context, q rowReader, r Run) (*TerminalResult, error) {
	if r.SessionID == "" || r.WorkflowID != "" || r.Status != StateFailed && r.Status != StateInterrupted && r.Status != StateCancelled {
		return nil, nil
	}
	// 旧取消记录缺少来源时保留原行为；系统撤回等明确错误导致的自动终止仍给结果。
	if r.Status == StateCancelled && (r.CancelRequestedAt == "" || r.Error == nil || r.Error.Code == "cancelled") {
		return nil, nil
	}
	// 自动撤回资料也会设置 CancelRequestedAt；只有明确的取消事件代表操作者停止。
	var stopped bool
	if r.CancelRequestedAt != "" {
		if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND json_extract(document,'$.type')='run/cancel-requested')`, r.ID).Scan(&stopped); err != nil {
			return nil, err
		}
	}
	if stopped {
		return nil, nil
	}
	reason := "运行异常结束，未获得可用结果"
	if r.Error != nil && strings.TrimSpace(r.Error.Message) != "" {
		reason = strings.TrimSpace(r.Error.Message)
	}
	return &TerminalResult{Origin: "runtime", Content: "本轮任务未能完成。\n\n原因：" + reason}, nil
}

// 保存发生在终态事件的同一事务，按 Run 去重；只读快照使用相同生成逻辑兼容旧记录。
func (s *store) saveTerminalResult(ctx context.Context, tx *sql.Tx, r Run) error {
	result, err := s.terminalResult(ctx, tx, r)
	if err != nil || result == nil {
		return err
	}
	var exists bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM messages WHERE run_id=? AND role='assistant' AND json_extract(document,'$.origin')='runtime')`, r.ID).Scan(&exists); err != nil || exists {
		return err
	}
	message := Message{ID: randomID(), SessionID: r.SessionID, TaskID: r.TaskID, RunID: r.ID, Role: "assistant", Origin: result.Origin, Content: result.Content, RunStatus: r.Status, CreatedAt: r.EndedAt}
	return s.appendMessage(ctx, tx, &message)
}
