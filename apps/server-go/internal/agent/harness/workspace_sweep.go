package harness

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

// sweep 在 Manager 锁内执行（启动期还未启动 Worker），先删除数据库任务，再
// 明确核对已无引用后删除对应归档；磁盘清理失败不能恢复已过期的任务事实。
func (m *Manager) sweep(ctx context.Context) error {
	if err := m.store.Sweep(ctx, m.deps.Limits.RetentionDays); err != nil {
		return err
	}
	if m.deps.Workspaces == nil {
		return nil
	}
	rows, err := readView(ctx, m.store).WorkspaceCleanup(ctx)
	if err != nil {
		return err
	}
	ids := []string{}
	for _, record := range rows {
		var id string
		id = record.TaskID
		ids = append(ids, id)
	}

	if err != nil {
		return err
	}
	for _, id := range ids {
		var count int
		if err = readView(ctx, m.store).TaskExists(ctx, id, &count); err != nil {
			return err
		}
		if count == 0 {
			if err = m.deps.Workspaces.RemoveTask(ctx, id); err != nil {
				return err
			}
			if err = writeStore(m.store, ctx, "workspace-cleanup", func(tx sessionstore.Tx) error { _, e := tx.RemoveWorkspaceCleanup(ctx, id); return e }); err != nil {
				return err
			}
		}
	}
	return nil
}
