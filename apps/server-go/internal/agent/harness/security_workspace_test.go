package harness

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/workspace"
)

// 预检查与 prepare 之间的锁外间隙里任务被 sweep 级联删除时，已发布的不可变归档
// 必须补写 workspace_cleanup 记录，由下一轮 sweep 兜底回收，而不是成为无记录孤儿。
func TestWorkspaceWriteAfterTaskSweepRecordsCleanup(t *testing.T) {
	m, session, task := workspaceManagerFixture(t)
	ctx := context.Background()
	m.deps.Limits = DefaultLimits()
	err := m.store.write(ctx, "age-session", func(tx *sql.Tx) error {
		stored, err := readSession(ctx, tx, session.ID)
		if err != nil {
			return err
		}
		stored.LastActivityAt = stamp(runtimeStoreTestTime.Add(-31 * 24 * time.Hour))
		return saveSession(ctx, tx, stored)
	})
	if err != nil {
		t.Fatal(err)
	}
	// 在写事务开启前注入级联清理：预检查通过、归档已发布之后，任务恰好在事务提交前
	// 被会话级联删除，复现毫秒级竞态的确定性等价时序。真实竞态里 sweep 的消费循环
	// 在锁外间隙先于归档发布扫过目录、无可删文件，这里以只级联不消费等价。
	m.store.beforeWrite = func(op string) error {
		if op != "workspace-update" {
			return nil
		}
		return m.store.sweep(ctx, m.deps.Limits.RetentionDays)
	}
	_, err = m.WriteWorkspace(ctx, task.ID, 0, "file", strings.NewReader("orphan"))
	requireWorkspaceCode(t, err, "task-not-found")
	m.store.beforeWrite = nil
	var count int
	if err = m.store.db.QueryRow("SELECT COUNT(*) FROM workspace_cleanup WHERE task_id=?", task.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("未补写孤儿归档清理记录：%d %v", count, err)
	}
	if _, err = m.deps.Workspaces.Version(ctx, task.ID, 1); err != nil {
		t.Fatalf("补写记录不应在回收前删除归档：%v", err)
	}
	if err = m.sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if err = m.store.db.QueryRow("SELECT COUNT(*) FROM workspace_cleanup WHERE task_id=?", task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("补写的清理记录未被消费：%d %v", count, err)
	}
	if _, err = m.deps.Workspaces.Version(ctx, task.ID, 1); err == nil {
		t.Fatal("孤儿归档未被 sweep 回收")
	}
}

// 任务仍在时的普通事务失败不得补写清理记录，避免误删仍被引用的工作区。
func TestWorkspaceWriteFailureWithLiveTaskKeepsNoCleanupRecord(t *testing.T) {
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
	var count int
	if err = m.store.db.QueryRow("SELECT COUNT(*) FROM workspace_cleanup WHERE task_id=?", task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("任务仍在时不应该补写清理记录：%d %v", count, err)
	}
}

// GET 单文件读取必须有返回上限：超限文件直接拒绝，不再全量进内存后经 base64 放大。
func TestWorkspaceViewRejectsOversizedFile(t *testing.T) {
	m, _, task := workspaceManagerFixture(t)
	ctx := context.Background()
	big := strings.Repeat("a", int(workspaceViewMaxBytes)+1)
	if _, err := m.WriteWorkspace(ctx, task.ID, 0, "big.bin", strings.NewReader(big)); err != nil {
		t.Fatal(err)
	}
	_, err := m.Workspace(ctx, task.ID, "big.bin")
	var actual *Error
	if !errors.As(err, &actual) || actual.Status != 413 || actual.Code != "workspace_quota_exceeded" {
		t.Fatalf("期望 413 workspace_quota_exceeded，实际 %v", err)
	}
	if _, err = m.WriteWorkspace(ctx, task.ID, 1, "small.txt", strings.NewReader("ok")); err != nil {
		t.Fatal(err)
	}
	view, err := m.Workspace(ctx, task.ID, "small.txt")
	if err != nil || string(view.Content) != "ok" {
		t.Fatalf("正常大小的文件读取受影响：%+v %v", view, err)
	}
}

// 写事务必须区分「事务体失败已回滚」与「提交结果未确认」：前者数据库必然
// 不引用候选产物，后者指针可能已落盘，两者的清理语义完全不同。
func TestStoreWriteClassifiesRollbackVersusUnconfirmedCommit(t *testing.T) {
	m, _, _ := workspaceManagerFixture(t)
	ctx := context.Background()
	rollbackErr := m.store.write(ctx, "test-op", func(tx *sql.Tx) error {
		return errors.New("事务体失败")
	})
	if rollbackErr == nil || commitUnconfirmed(rollbackErr) {
		t.Fatalf("事务体失败属已回滚路径，不应判为提交未确认：%v", rollbackErr)
	}
	m.store.failNextCommit = errors.New("注入提交失败")
	unconfirmedErr := m.store.write(ctx, "test-op", func(tx *sql.Tx) error { return nil })
	if !commitUnconfirmed(unconfirmedErr) {
		t.Fatalf("提交失败必须判为提交未确认：%v", unconfirmedErr)
	}
	var target *unconfirmedCommit
	if !errors.As(unconfirmedErr, &target) {
		t.Fatalf("提交失败必须以 unconfirmedCommit 包装返回：%v", unconfirmedErr)
	}
}

// 提交结果未确认时必须保留候选工作区版本：数据库指针可能已经引用归档，
// 删掉归档会让落库指针悬空；保留的候选由会话级联清理自然回收。
func TestDiscardPreparedCandidatesKeepsVersionsOnUnconfirmedCommit(t *testing.T) {
	m, _, task := workspaceManagerFixture(t)
	ctx := context.Background()
	rolled, err := m.deps.Workspaces.PrepareWrite(ctx, task.ID, 0, "a.txt", strings.NewReader("rollback"))
	if err != nil {
		t.Fatal(err)
	}
	m.discardPreparedCandidates(errors.New("事务体失败"), []workspace.Version{rolled})
	if _, err = m.deps.Workspaces.Version(ctx, task.ID, rolled.Revision); err == nil {
		t.Fatal("已回滚路径应丢弃候选版本")
	}
	kept, err := m.deps.Workspaces.PrepareWrite(ctx, task.ID, 0, "b.txt", strings.NewReader("unknown"))
	if err != nil {
		t.Fatal(err)
	}
	m.discardPreparedCandidates(&unconfirmedCommit{op: "test-op", err: errors.New("提交失败")}, []workspace.Version{kept})
	if _, err = m.deps.Workspaces.Version(ctx, task.ID, kept.Revision); err != nil {
		t.Fatalf("提交未确认必须保留候选版本：%v", err)
	}
}
