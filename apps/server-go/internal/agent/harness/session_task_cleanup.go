package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"elysian/server/internal/agent/tools"
)

// 仅保留取消所需的精确域任务身份，不保留已删会话正文，也不重放原操作。
const sessionTaskCleanupSchema = `CREATE TABLE IF NOT EXISTS session_task_cleanup (
 id TEXT PRIMARY KEY, document TEXT NOT NULL, retry_at TEXT NOT NULL DEFAULT ''
);`

func enqueueTaskCancellation(ctx context.Context, tx *sql.Tx, ref tools.TaskReference) error {
	if ref.Domain == "" || ref.ID == "" && ref.RequestID == "" {
		return nil
	}
	raw, err := json.Marshal(ref)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO session_task_cleanup(id,document) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET retry_at=''", digestJSON(ref), string(raw))
	return err
}

func isNotFound(err error) bool {
	var typed *Error
	return errors.As(err, &typed) && typed.Status == 404
}

func (m *Manager) cancelDeletedSessionTasks() {
	if m.deps.CancelTask == nil {
		return
	}
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	refs, err := readDocuments[tools.TaskReference](m.ctx, m.store.db, "SELECT document FROM session_task_cleanup WHERE retry_at<=? ORDER BY retry_at,id LIMIT 32", stamp(m.deps.Now()))
	m.mu.Unlock()
	if err != nil {
		return
	}
	// 每个接缝有独立时限；失败只重试取消，不阻塞会话删除或恢复原任务。
	for _, original := range refs {
		if m.ctx.Err() != nil {
			return
		}
		m.mu.Lock()
		err = m.store.write(m.ctx, "session-task-cancel-attempt", func(tx *sql.Tx) error {
			_, err := tx.ExecContext(m.ctx, "UPDATE session_task_cleanup SET retry_at=? WHERE id=?", stamp(m.deps.Now().Add(30*time.Second)), digestJSON(original))
			return err
		})
		m.mu.Unlock()
		if err != nil {
			continue
		}
		ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
		ref := original
		if m.deps.LookupTask != nil && (ref.ID == "" || ref.RequestID == "") {
			ref, err = m.deps.LookupTask(ctx, original)
		}
		if err == nil && ref.Domain == original.Domain && ref.ID != "" && ref.RequestID != "" && (original.ID == "" || original.ID == ref.ID) && (original.RequestID == "" || original.RequestID == ref.RequestID) {
			err = m.deps.CancelTask(ctx, ref)
		} else if err == nil {
			err = errors.New("后台任务身份尚未确认")
		}
		cancel()
		if err != nil {
			continue
		}
		m.mu.Lock()
		_ = m.store.write(m.ctx, "session-task-cancelled", func(tx *sql.Tx) error {
			_, err := tx.ExecContext(m.ctx, "DELETE FROM session_task_cleanup WHERE id=?", digestJSON(original))
			return err
		})
		m.mu.Unlock()
	}
}

func (m *Manager) taskCleanupLoop() {
	defer close(m.taskCleanupDone)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		m.cancelDeletedSessionTasks()
		select {
		case <-m.ctx.Done():
			return
		case <-m.taskCancelWake:
		case <-ticker.C:
		}
	}
}

func (m *Manager) rememberExecutionTask(execution *executionState, ref tools.TaskReference) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	if !execution.deleted && !execution.maintenance {
		execution.tasks = append(execution.tasks, ref)
		return
	}
	if err := m.store.write(context.Background(), "deleted-session-late-task", func(tx *sql.Tx) error { return enqueueTaskCancellation(context.Background(), tx, ref) }); err != nil {
		m.storageFailedLocked()
		return
	}
	select {
	case m.taskCancelWake <- struct{}{}:
	default:
	}
}
