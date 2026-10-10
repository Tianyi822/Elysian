package harness

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/workspace"
)

func workspaceManagerFixture(t *testing.T) (*Manager, Session, Task) {
	t.Helper()
	s, _ := openRuntimeTestStore(t)
	backend, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { backend.Close() })
	session, task, run := sessionStoreFixture(t, s, "workspace", runtimeStoreTestTime)
	run = acceptSessionTestRun(t, s, task, run, true)
	finishSessionTestRun(t, s, run.ID, "准备完成", nil)
	m := &Manager{store: s, deps: Deps{Workspaces: backend, Now: func() time.Time { return runtimeStoreTestTime.Add(time.Hour) }}}
	return m, session, task
}

func requireWorkspaceCode(t *testing.T, err error, code string) {
	t.Helper()
	var actual *Error
	if !errors.As(err, &actual) || actual.Code != code {
		t.Fatalf("期望 %s，实际 %v", code, err)
	}
}

func TestWorkspaceAPIUsesDatabasePointerAndCAS(t *testing.T) {
	m, session, task := workspaceManagerFixture(t)
	ctx := context.Background()
	initialSession, err := readSession(ctx, m.store.db, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	empty, err := m.Workspace(ctx, task.ID, "")
	if err != nil || empty.Version.Revision != 0 || len(empty.Files) != 0 {
		t.Fatalf("初始工作区：%+v %v", empty, err)
	}
	first, err := m.WriteWorkspace(ctx, task.ID, 0, "source/main.py", strings.NewReader("print('first')"))
	if err != nil || first.BaseRevision != 0 {
		t.Fatalf("首次上传：%+v %v", first, err)
	}
	// 只有磁盘候选、没有数据库提交的版本不得对用户可见。
	candidate, err := m.deps.Workspaces.PrepareWrite(ctx, task.ID, first.Revision, "source/main.py", strings.NewReader("uncommitted"))
	if err != nil || candidate.Revision <= first.Revision {
		t.Fatal(err)
	}
	actual, err := m.Workspace(ctx, task.ID, "source/main.py")
	if err != nil || actual.Version != first || string(actual.Content) != "print('first')" {
		t.Fatalf("未提交候选泄露：%+v %v", actual, err)
	}
	_, err = m.WriteWorkspace(ctx, task.ID, 0, "other", strings.NewReader("stale"))
	requireWorkspaceCode(t, err, "workspace-revision-conflict")
	second, err := m.WriteWorkspace(ctx, task.ID, first.Revision, "source/main.py", strings.NewReader("print('second')"))
	if err != nil || second.Revision <= candidate.Revision {
		t.Fatalf("提交跳号版本：%+v %v", second, err)
	}
	_, err = m.DeleteWorkspace(ctx, task.ID, first.Revision, "source/main.py")
	requireWorkspaceCode(t, err, "workspace-revision-conflict")
	third, err := m.DeleteWorkspace(ctx, task.ID, second.Revision, "source/main.py")
	if err != nil || third.FileCount != 0 {
		t.Fatalf("删除文件：%+v %v", third, err)
	}
	_, err = m.Workspace(ctx, task.ID, "source/main.py")
	requireWorkspaceCode(t, err, "workspace_file_not_found")
	storedSession, err := readSession(ctx, m.store.db, session.ID)
	if err != nil || storedSession.LastActivityAt != initialSession.LastActivityAt {
		t.Fatalf("工作区修改不应延长对话保留期限：%+v %v", storedSession, err)
	}
}

func TestWorkspaceAPIBusySessionIncludesWaitingApproval(t *testing.T) {
	m, session, task := workspaceManagerFixture(t)
	ctx := context.Background()
	if _, err := m.WriteWorkspace(ctx, task.ID, 0, "file", strings.NewReader("old")); err != nil {
		t.Fatal(err)
	}
	for _, state := range []string{StateQueued, StateRunning, StateWaitingApproval} {
		t.Run(state, func(t *testing.T) {
			other := Task{ID: "other-" + state, SessionID: session.ID, RequestID: "request-" + state, Kind: "agent", DriverVersion: "v1", CreatedAt: stamp(m.deps.Now()), Goal: "其他任务"}
			run := Run{ID: "run-" + state, SessionID: session.ID, TaskID: other.ID, RequestID: other.RequestID, Input: other.Goal, Status: StateQueued, CreatedAt: other.CreatedAt, LastSeq: "0", Limits: DefaultAgentLimits()}
			run.Model = &model.Profile{ID: session.ModelProfileID, Revision: session.ModelRevision}
			accepted := acceptSessionTestRun(t, m.store, other, run, true)
			_, err := m.store.change(ctx, accepted.ID, "busy-test", func(tx *sql.Tx, r *Run) error { r.Status = state; return nil })
			if err != nil {
				t.Fatal(err)
			}
			_, err = m.WriteWorkspace(ctx, task.ID, 1, "file", strings.NewReader("new"))
			requireWorkspaceCode(t, err, "session-busy")
			if view, err := m.Workspace(ctx, task.ID, "file"); err != nil || string(view.Content) != "old" {
				t.Fatalf("忙碌读取：%+v %v", view, err)
			}
			finishSessionTestRun(t, m.store, accepted.ID, "完成", nil)
		})
	}
}

func TestWorkspaceMaintenanceFreezesWritesAndCleanupSurvivesMissingBackend(t *testing.T) {
	m, session, task := workspaceManagerFixture(t)
	ctx := context.Background()
	m.deps.Limits = DefaultLimits()
	if _, err := m.WriteWorkspace(ctx, task.ID, 0, "file", strings.NewReader("保留文件")); err != nil {
		t.Fatal(err)
	}
	m.deps.DispatchGuard = func() error { return &Error{409, "maintenance-active", "维护中"} }
	_, err := m.WriteWorkspace(ctx, task.ID, 1, "file", strings.NewReader("不应写入"))
	requireWorkspaceCode(t, err, "maintenance-active")
	if _, err = m.Workspace(ctx, task.ID, "file"); err != nil {
		t.Fatal("维护期间应可读取已提交文件", err)
	}
	m.deps.DispatchGuard = nil
	err = m.store.write(ctx, "expire-workspace", func(tx *sql.Tx) error {
		s, e := readSession(ctx, tx, session.ID)
		if e != nil {
			return e
		}
		s.LastActivityAt = stamp(runtimeStoreTestTime.Add(-31 * 24 * time.Hour))
		return saveSession(ctx, tx, s)
	})
	if err != nil {
		t.Fatal(err)
	}
	backend := m.deps.Workspaces
	m.deps.Workspaces = nil
	if err = m.sweep(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = m.store.db.QueryRow("SELECT count(*) FROM workspace_cleanup WHERE task_id=?", task.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("未持久保留清理任务：%d %v", count, err)
	}
	m.deps.Workspaces = backend
	if err = m.sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if err = m.store.db.QueryRow("SELECT count(*) FROM workspace_cleanup WHERE task_id=?", task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("未完成清理：%d %v", count, err)
	}
	if _, err = backend.Version(ctx, task.ID, 1); err == nil {
		t.Fatal("已过期工作区实体仍存在")
	}
}

func TestWorkspaceAPIConcurrentWritersAndLateBusyRecheck(t *testing.T) {
	m, session, task := workspaceManagerFixture(t)
	ctx := context.Background()
	const count = 6
	var wg sync.WaitGroup
	results := make(chan error, count)
	for i := 0; i < count; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.WriteWorkspace(ctx, task.ID, 0, "file", strings.NewReader("candidate"))
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else {
			requireWorkspaceCode(t, err, "workspace-revision-conflict")
		}
	}
	if success != 1 {
		t.Fatalf("并发 CAS 成功 %d 次", success)
	}
	current, err := m.Workspace(ctx, task.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	blocked := &workspaceBlockingReader{started: make(chan struct{}), resume: make(chan struct{}), body: strings.NewReader("after upload")}
	finished := make(chan error, 1)
	go func() {
		_, err := m.WriteWorkspace(ctx, task.ID, current.Version.Revision, "file", blocked)
		finished <- err
	}()
	<-blocked.started
	m.mu.Lock()
	err = m.store.write(ctx, "new-busy", func(tx *sql.Tx) error {
		stored, err := readSession(ctx, tx, session.ID)
		if err != nil {
			return err
		}
		stored.ActiveRunID = "newly-accepted-run"
		return saveSession(ctx, tx, stored)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	close(blocked.resume)
	requireWorkspaceCode(t, <-finished, "session-busy")
	view, err := m.Workspace(ctx, task.ID, "file")
	if err != nil || string(view.Content) != "candidate" {
		t.Fatalf("上传期间忙碌仍覆盖：%+v %v", view, err)
	}
}

type workspaceBlockingReader struct {
	started, resume chan struct{}
	once            sync.Once
	body            *strings.Reader
}

func (r *workspaceBlockingReader) Read(b []byte) (int, error) {
	r.once.Do(func() { close(r.started); <-r.resume })
	return r.body.Read(b)
}

func TestWorkspaceAPIPointerRollbackAndRestart(t *testing.T) {
	m, _, task := workspaceManagerFixture(t)
	ctx := context.Background()
	first, err := m.WriteWorkspace(ctx, task.ID, 0, "file", strings.NewReader("committed"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.store.db.Exec(`CREATE TRIGGER reject_workspace_update BEFORE UPDATE ON workspace_versions BEGIN SELECT RAISE(ABORT,'注入事务失败'); END`); err != nil {
		t.Fatal(err)
	}
	_, err = m.WriteWorkspace(ctx, task.ID, first.Revision, "file", strings.NewReader("not committed"))
	if err == nil {
		t.Fatal("数据库失败仍返回成功")
	}
	current, err := m.Workspace(ctx, task.ID, "file")
	if err != nil || current.Version != first || string(current.Content) != "committed" {
		t.Fatalf("失败改变指针：%+v %v", current, err)
	}
	var dbPath string
	var seq int
	var name string
	if err = m.store.db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &dbPath); err != nil {
		t.Fatal(err)
	}
	if err = m.store.close(); err != nil {
		t.Fatal(err)
	}
	m.store, err = openStore(dbPath, m.deps.Now)
	if err != nil {
		t.Fatal(err)
	}
	defer m.store.close()
	current, err = m.Workspace(ctx, task.ID, "file")
	if err != nil || current.Version != first || string(current.Content) != "committed" {
		t.Fatalf("重启选择了未提交候选：%+v %v", current, err)
	}
}

func TestWorkspaceCommitParticipatesInOperationTransaction(t *testing.T) {
	m, _, task := workspaceManagerFixture(t)
	ctx := context.Background()
	candidate, err := m.deps.Workspaces.PrepareWrite(ctx, task.ID, 0, "result", strings.NewReader("value"))
	if err != nil {
		t.Fatal(err)
	}
	err = m.store.write(ctx, "fake-operation-result", func(tx *sql.Tx) error {
		if err := commitWorkspaceVersion(ctx, tx, candidate); err != nil {
			return err
		}
		return errors.New("注入动作结果落盘失败")
	})
	if err == nil {
		t.Fatal("预期事务失败")
	}
	current, err := readWorkspaceVersion(ctx, m.store.db, task.ID)
	if err != nil || current.Revision != 0 {
		t.Fatalf("动作失败仍推进指针：%+v %v", current, err)
	}
	if err = m.store.write(ctx, "operation-result", func(tx *sql.Tx) error { return commitWorkspaceVersion(ctx, tx, candidate) }); err != nil {
		t.Fatal(err)
	}
	err = m.store.write(ctx, "duplicate-result", func(tx *sql.Tx) error { return commitWorkspaceVersion(ctx, tx, candidate) })
	requireWorkspaceCode(t, err, "workspace-revision-conflict")
}

func TestWorkspaceSweepRemovesOnlyExpiredTaskArchives(t *testing.T) {
	m, _, task := workspaceManagerFixture(t)
	ctx := context.Background()
	version, err := m.WriteWorkspace(ctx, task.ID, 0, "file", strings.NewReader("expired"))
	if err != nil {
		t.Fatal(err)
	}
	m.store.now = func() time.Time { return runtimeStoreTestTime.Add(40 * 24 * time.Hour) }
	m.deps.Limits = DefaultLimits()
	_, recentTask, recentRun := sessionStoreFixture(t, m.store, "recent-workspace", m.store.now())
	recentRun = acceptSessionTestRun(t, m.store, recentTask, recentRun, true)
	finishSessionTestRun(t, m.store, recentRun.ID, "完成", nil)
	recentVersion, err := m.deps.Workspaces.PrepareWrite(ctx, recentTask.ID, 0, "file", strings.NewReader("recent"))
	if err != nil {
		t.Fatal(err)
	}
	if err = m.store.write(ctx, "recent-workspace", func(tx *sql.Tx) error { return commitWorkspaceVersion(ctx, tx, recentVersion) }); err != nil {
		t.Fatal(err)
	}
	if err = m.sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = m.deps.Workspaces.Version(ctx, task.ID, version.Revision); err == nil {
		t.Fatal("到期任务仍保留工作区")
	}
	if v, err := m.deps.Workspaces.Version(ctx, recentTask.ID, recentVersion.Revision); err != nil || v != recentVersion {
		t.Fatalf("未到期工作区被清理：%+v %v", v, err)
	}
}
