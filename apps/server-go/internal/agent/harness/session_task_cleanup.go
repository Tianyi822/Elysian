package harness

import (
	"context"
	"errors"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/tools"
)

func isNotFound(err error) bool {
	var typed *Error
	return errors.Is(err, sessionstore.ErrNotFound) || errors.As(err, &typed) && typed.Status == 404
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
	refs, err := readView(m.ctx, m.store).PendingTaskCancellations(m.ctx, stamp(m.deps.Now()))
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
		err = writeStore(m.store, m.ctx, "session-task-cancel-attempt", func(tx sessionstore.Tx) error {
			_, err := tx.RecordTaskCancellationFailure(m.ctx, stamp(m.deps.Now().Add(30*time.Second)), hstate.DigestJSON(original))
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
		_ = writeStore(m.store, m.ctx, "session-task-cancelled", func(tx sessionstore.Tx) error {
			_, err := tx.RemoveTaskCancellation(m.ctx, hstate.DigestJSON(original))
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
	if err := writeStore(m.store, context.Background(), "deleted-session-late-task", func(tx sessionstore.Tx) error { return enqueueTaskCancellation(context.Background(), tx, ref) }); err != nil {
		m.storageFailedLocked()
		return
	}
	select {
	case m.taskCancelWake <- struct{}{}:
	default:
	}
}
