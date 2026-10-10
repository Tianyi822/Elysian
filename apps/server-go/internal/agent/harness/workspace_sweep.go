package harness

import "context"

// sweep 在 Manager 锁内执行（启动期还未启动 Worker），先删除数据库任务，再
// 明确核对已无引用后删除对应归档；磁盘清理失败不能恢复已过期的任务事实。
func (m *Manager) sweep(ctx context.Context) error {
	if err := m.store.sweep(ctx, m.deps.Limits.RetentionDays); err != nil {
		return err
	}
	if err := m.sweepEmbeddingRequests(ctx); err != nil {
		return err
	}
	if m.deps.Workspaces == nil {
		return nil
	}
	rows, err := m.store.db.QueryContext(ctx, "SELECT task_id FROM workspace_cleanup")
	if err != nil {
		return err
	}
	ids := []string{}
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
		var count int
		if err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM tasks WHERE id=?", id).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			if err = m.deps.Workspaces.RemoveTask(ctx, id); err != nil {
				return err
			}
			if _, err = m.store.db.ExecContext(ctx, "DELETE FROM workspace_cleanup WHERE task_id=?", id); err != nil {
				return err
			}
		}
	}
	return nil
}
