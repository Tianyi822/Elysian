package harness

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"

	"elysian/server/internal/agent/harness/workspace"
)

// WorkspaceView 的 Content 是原始字节；JSON 使用标准 base64，下载端点可直接
// 发送 application/octet-stream。Revision 始终来自数据库当前指针。
type WorkspaceView struct {
	Version     workspace.Version `json:"version"`
	Files       []workspace.File  `json:"files,omitempty"`
	Path        string            `json:"path,omitempty"`
	Content     []byte            `json:"content,omitempty"`
	Quarantined bool              `json:"quarantined,omitempty"`
	WikiSources []WikiRef         `json:"wikiSources,omitempty"`
}

// workspaceViewMaxBytes 限制 JSON 单文件读取的返回体大小：Content 会整体进入内存
// 并经 base64 放大，超限文件直接拒绝，避免并发读取推高面板内存峰值。
const workspaceViewMaxBytes int64 = 4 << 20

func (m *Manager) workspaceStoreLocked() (*workspace.Store, error) {
	if m.closed {
		return nil, closedError()
	}
	if m.deps.Workspaces == nil {
		return nil, &Error{Status: 503, Code: "workspace-unavailable", Message: "任务工作区服务不可用"}
	}
	return m.deps.Workspaces, nil
}

func workspaceTask(ctx context.Context, q rowReader, taskID string, requireIdle bool) (Task, error) {
	task, err := readTask(ctx, q, taskID)
	if err != nil {
		return Task{}, err
	}
	if (task.Kind != "agent" && task.Kind != "workflow") || task.SessionID == "" {
		return Task{}, bad("workspace-task-required", "工作区仅适用于会话内的 Agent 或工作流任务")
	}
	if !requireIdle {
		return task, nil
	}
	session, err := readSession(ctx, q, task.SessionID)
	if err != nil {
		return Task{}, err
	}
	if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		return Task{}, &Error{Status: 409, Code: "session-busy", Message: "会话仍有任务排队、运行或等待审批，请结束后再修改工作区"}
	}
	var active int
	if err = q.QueryRowContext(ctx, `SELECT COUNT(*) FROM runs WHERE task_id=? AND state NOT IN ('succeeded','failed','cancelled','interrupted')`, taskID).Scan(&active); err != nil {
		return Task{}, err
	}
	if active > 0 {
		return Task{}, &Error{Status: 409, Code: "task-busy", Message: "任务尚未结束，不能修改工作区"}
	}
	return task, nil
}

// readWorkspaceVersion 只读取宿主数据库指针，不扫描归档目录中的候选版本。
// 返回零版本表示空工作区，绝不能用磁盘上的最大版本代替当前版本。
func readWorkspaceVersion(ctx context.Context, q rowReader, taskID string) (workspace.Version, error) {
	var revision int
	var raw string
	err := q.QueryRowContext(ctx, "SELECT revision,document FROM workspace_versions WHERE task_id=?", taskID).Scan(&revision, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return workspace.Version{TaskID: taskID}, nil
	}
	if err != nil {
		return workspace.Version{}, err
	}
	var version workspace.Version
	if err = json.Unmarshal([]byte(raw), &version); err != nil {
		return workspace.Version{}, err
	}
	if version.TaskID != taskID || version.Revision != revision || validateWorkspaceVersion(version) != nil {
		return workspace.Version{}, errors.New("工作区数据库版本指针损坏")
	}
	return version, nil
}

func validateWorkspaceVersion(version workspace.Version) error {
	digest, err := hex.DecodeString(version.Digest)
	if version.TaskID == "" || version.Revision < 1 || version.BaseRevision < 0 || version.Revision <= version.BaseRevision || version.Bytes < 0 || version.Bytes > workspace.DefaultTaskBytes || version.FileCount < 0 || version.FileCount > workspace.DefaultTaskFiles || err != nil || len(digest) != 32 {
		return bad("invalid-workspace-version", "工作区候选版本无效")
	}
	return nil
}

func workspaceConflict() error {
	return &Error{Status: 409, Code: "workspace-revision-conflict", Message: "任务工作区已变化，请重新读取后重试"}
}

// commitWorkspaceVersion 由父进程在结果事务内调用，使用 BaseRevision 做 CAS。
// 调用者须已验证归档存在，并在同一事务内验证 Task/Run 身份与操作状态。
func commitWorkspaceVersion(ctx context.Context, tx *sql.Tx, version workspace.Version) error {
	if err := validateWorkspaceVersion(version); err != nil {
		return err
	}
	current, err := readWorkspaceVersion(ctx, tx, version.TaskID)
	if err != nil {
		return err
	}
	if current.Revision != version.BaseRevision {
		return workspaceConflict()
	}
	raw, err := json.Marshal(version)
	if err != nil {
		return err
	}
	var result sql.Result
	if current.Revision == 0 {
		result, err = tx.ExecContext(ctx, `INSERT INTO workspace_versions(task_id,revision,document) VALUES(?,?,?) ON CONFLICT(task_id) DO NOTHING`, version.TaskID, version.Revision, string(raw))
	} else {
		result, err = tx.ExecContext(ctx, `UPDATE workspace_versions SET revision=?,document=? WHERE task_id=? AND revision=?`, version.Revision, string(raw), version.TaskID, version.BaseRevision)
	}
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return workspaceConflict()
	}
	return nil
}

func (m *Manager) Workspace(ctx context.Context, taskID, path string) (WorkspaceView, error) {
	m.mu.Lock()
	backend, err := m.workspaceStoreLocked()
	if err == nil {
		_, err = workspaceTask(ctx, m.store.db, taskID, false)
	}
	var current workspace.Version
	if err == nil {
		current, err = readWorkspaceVersion(ctx, m.store.db, taskID)
	}
	var quarantined bool
	var sources []WikiRef
	if err == nil {
		quarantined, err = wikiArtifactInvalid(ctx, m.store.db, "workspace", workspaceWikiKey(current))
	}
	if err == nil {
		sources, err = wikiArtifactRefs(ctx, m.store.db, "workspace", workspaceWikiKey(current))
	}
	m.mu.Unlock()
	if err != nil {
		return WorkspaceView{}, workspaceFailure(err)
	}
	if path != "" {
		content, version, err := backend.ReadLimited(ctx, taskID, current.Revision, path, workspaceViewMaxBytes)
		if err != nil {
			return WorkspaceView{}, workspaceFailure(err)
		}
		if current.Revision > 0 && current != version {
			return WorkspaceView{}, storageFailure(errors.New("工作区归档与数据库指针不一致"))
		}
		return WorkspaceView{Version: version, Path: path, Content: content, Quarantined: quarantined, WikiSources: sources}, nil
	}
	snapshot, err := backend.List(ctx, taskID, current.Revision)
	if err != nil {
		return WorkspaceView{}, workspaceFailure(err)
	}
	if current.Revision > 0 && snapshot.Version != current {
		return WorkspaceView{}, storageFailure(errors.New("工作区归档与数据库指针不一致"))
	}
	return WorkspaceView{Version: snapshot.Version, Files: snapshot.Files, Quarantined: quarantined, WikiSources: sources}, nil
}

func (m *Manager) WriteWorkspace(ctx context.Context, taskID string, expectedRevision int, path string, reader io.Reader) (workspace.Version, error) {
	return m.mutateWorkspace(ctx, taskID, expectedRevision, func(backend *workspace.Store) (workspace.Version, error) {
		return backend.PrepareWrite(ctx, taskID, expectedRevision, path, reader)
	})
}

func (m *Manager) DeleteWorkspace(ctx context.Context, taskID string, expectedRevision int, path string) (workspace.Version, error) {
	return m.mutateWorkspace(ctx, taskID, expectedRevision, func(backend *workspace.Store) (workspace.Version, error) {
		return backend.PrepareDelete(ctx, taskID, expectedRevision, path)
	})
}

func (m *Manager) mutateWorkspace(ctx context.Context, taskID string, expectedRevision int, prepare func(*workspace.Store) (workspace.Version, error)) (workspace.Version, error) {
	if expectedRevision < 0 {
		return workspace.Version{}, bad("invalid-workspace-revision", "工作区预期版本不能为负数")
	}
	m.mu.Lock()
	backend, err := m.workspaceStoreLocked()
	if err == nil && m.deps.DispatchGuard != nil {
		err = m.deps.DispatchGuard()
	}
	if err == nil {
		_, err = workspaceTask(ctx, m.store.db, taskID, true)
	}
	if err == nil {
		var current workspace.Version
		current, err = readWorkspaceVersion(ctx, m.store.db, taskID)
		if err == nil && current.Revision != expectedRevision {
			err = workspaceConflict()
		}
	}
	m.mu.Unlock()
	if err != nil {
		return workspace.Version{}, workspaceFailure(err)
	}
	// 上传和复制不持有 Manager 锁，避免暂停 Worker 事件与取消处理。
	version, err := prepare(backend)
	if err != nil {
		return workspace.Version{}, workspaceFailure(err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, err = m.workspaceStoreLocked(); err != nil {
		return workspace.Version{}, err
	}
	if m.deps.DispatchGuard != nil {
		if err = m.deps.DispatchGuard(); err != nil {
			return workspace.Version{}, err
		}
	}
	err = m.store.write(ctx, "workspace-update", func(tx *sql.Tx) error {
		_, err := workspaceTask(ctx, tx, taskID, true)
		if err != nil {
			return err
		}
		if err := commitWorkspaceVersion(ctx, tx, version); err != nil {
			return err
		}
		return carryWorkspaceWiki(ctx, tx, version)
	})
	// 事务错误可能是提交结果未确认，保留不可变候选，不擅自删除潜在已引用版本。
	if err != nil {
		// 任务在预检查与写事务之间被并发清理时，prepare 已发布的归档没有任何
		// 记录指向且全部 API 均不可达，补写清理记录交由下一轮 sweep 兜底回收。
		if recordErr := m.recordOrphanWorkspace(ctx, taskID); recordErr != nil {
			return workspace.Version{}, errors.Join(workspaceFailure(err), recordErr)
		}
		return workspace.Version{}, workspaceFailure(err)
	}
	return version, nil
}

// recordOrphanWorkspace 在写事务失败后复核任务是否仍存在；任务已被清理时补写
// workspace_cleanup 记录。该表以 task_id 为主键，重复补写幂等；任务标识不复用。
func (m *Manager) recordOrphanWorkspace(ctx context.Context, taskID string) error {
	var count int
	if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM tasks WHERE id=?", taskID).Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return nil
	}
	_, err := m.store.db.ExecContext(ctx, "INSERT OR IGNORE INTO workspace_cleanup(task_id) VALUES(?)", taskID)
	return err
}

func workspaceFailure(err error) error {
	var target *workspace.Error
	if errors.As(err, &target) {
		return &Error{Status: target.Status, Code: target.Code, Message: target.Message}
	}
	return storageFailure(err)
}
