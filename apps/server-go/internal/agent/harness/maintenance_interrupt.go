package harness

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

func updateMaintenanceError(err error) bool {
	var failure *Error
	return errors.As(err, &failure) && failure.Code == "panel-update-active"
}

// 更新受理后立即冻结并中断聊天；不等在途模型返回，也不把维护写成工具失败。
// 独立于 Worker 执行槽，所有槽都在等待上游时也能发出取消。
func (m *Manager) maintenanceLoop() {
	defer close(m.maintenanceDone)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if m.deps.DispatchGuard != nil && updateMaintenanceError(m.deps.DispatchGuard()) {
			m.mu.Lock()
			if !m.closed && !m.storageError {
				m.interruptForMaintenanceLocked()
			}
			m.mu.Unlock()
		}
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (m *Manager) interruptForMaintenanceLocked() {
	ctx := context.Background()
	runs, err := readDocuments[Run](ctx, m.store.db, "SELECT document FROM runs WHERE session_id<>'' AND workflow_id='' AND state IN ('queued','running','waiting-input','waiting-approval','waiting-resource','waiting-task','waiting-recovery','recovery-required')")
	if err != nil {
		m.storageFailedLocked()
		return
	}
	for _, run := range runs {
		execution := m.executionLocked(run.ID)
		if execution != nil && execution.maintenance {
			continue
		}
		// 与中断事实一同持久保存精确取消身份；只取消旧任务，绝不重投旧操作。
		err = m.store.write(ctx, "maintenance-task-cancellation", func(tx *sql.Tx) error {
			operations, err := readDocuments[Operation](ctx, tx, "SELECT document FROM operations WHERE run_id=? AND state IN ('dispatched','unknown','waiting-task')", run.ID)
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
			if execution != nil {
				for _, ref := range execution.tasks {
					if err := enqueueTaskCancellation(ctx, tx, ref); err != nil {
						return err
					}
				}
			}
			return nil
		})
		if err != nil {
			m.storageFailedLocked()
			return
		}
		if execution != nil {
			execution.maintenance = true
			execution.cancel()
		} else {
			m.finishLocked(run.ID, StateInterrupted, "panel-update", "面板更新中断了任务，进度已保存，请在更新结束后手动继续")
		}
	}
	select {
	case m.taskCancelWake <- struct{}{}:
	default:
	}
}
