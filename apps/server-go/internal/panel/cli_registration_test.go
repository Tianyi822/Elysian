package panel

import (
	"context"
	"elysian/server/internal/config"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func TestLegacyRegistrationWaitsForCommitAndWorkerReleaseThenRetries(t *testing.T) {
	root, path := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, path, nil)
	manager := Manager{Store: w.Store, Enabled: true, Install: root, CLIBin: path, Executable: filepath.Join(root, "current", "elysian")}
	done, err := manager.registerCommittedCLI(context.Background(), "")
	if err != nil || done {
		t.Fatalf("未提交应继续等待：%v %v", done, err)
	}
	r.Committed = true
	r.State = "succeeded"
	_ = w.Store.save(*r)
	lock, err := w.Store.tryWorkerLock()
	if err != nil {
		t.Fatal(err)
	}
	done, err = manager.registerCommittedCLI(context.Background(), "")
	if done || err != nil {
		t.Fatal("旧 worker 未释放锁即注册")
	}
	_ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN)
	_ = lock.Close()
	manager.CLIVerify = func(context.Context, string, string) error { return errors.New("注入校验失败") }
	done, err = manager.registerCommittedCLI(context.Background(), "")
	if !done || err != nil {
		t.Fatalf("注册失败未收敛：%v", err)
	}
	record, _ := w.Store.read(r.ID)
	if record.State != "succeeded" || !record.Committed || record.CLIRegistration.Status != "failed" {
		t.Fatalf("回滚了已提交升级：%+v", record)
	}
	if _, err = os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("注册失败未恢复原命令")
	}
	manager.CLIVerify = nil
	task, err := manager.retryCLIRegistration(context.Background(), r.ID)
	if err != nil || task.CLIRegistration.Status != "succeeded" {
		t.Fatalf("重试失败：%+v %v", task, err)
	}
	if rows, err := w.Store.records(); err != nil || len(rows) != 1 {
		t.Fatal("独立子目录污染旧任务扫描器")
	}
}
func TestRegistrationRecoversEveryDurableLinkStage(t *testing.T) {
	for _, stage := range []string{"intent", "linked", "verified"} {
		t.Run(stage, func(t *testing.T) {
			root, path := cliLinkFixture(t, "deadbeef")
			w, r := cliLinkWorker(t, root, path, nil)
			r.State = "succeeded"
			r.Committed = true
			_ = w.Store.save(*r)
			journal := cliJournal{TaskID: r.ID, Path: path, Target: filepath.Join(root, "current", "elysian"), Commit: r.TargetCommit, Missing: true, State: "pending"}
			if stage == "verified" {
				journal.State = "succeeded"
			}
			if err := config.AtomicJSON(w.Store.cliJournalPath(r.ID), journal); err != nil {
				t.Fatal(err)
			}
			if stage != "intent" {
				_ = os.Symlink(journal.Target, path)
			}
			manager := Manager{Store: w.Store, Enabled: true, Install: root, CLIBin: path, Executable: journal.Target}
			// 即使日志已校验，任务回执尚未提交也必须恢复并核验。
			if err := w.ensureCLILink(context.Background(), r); err != nil {
				t.Fatal(err)
			}
			task, err := manager.retryCLIRegistration(context.Background(), r.ID)
			if err != nil || task.CLIRegistration.Status != "succeeded" {
				t.Fatalf("恢复失败：%v", err)
			}
			raw, _ := os.ReadFile(w.Store.cliJournalPath(r.ID))
			var saved cliJournal
			_ = json.Unmarshal(raw, &saved)
			if !saved.Missing {
				t.Fatal("重入丢失原始不存在事实")
			}
		})
	}
}
func TestRegistrationPreservesExternalReplacementOnRecovery(t *testing.T) {
	root, path := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, path, nil)
	journal := cliJournal{TaskID: r.ID, Path: path, Target: filepath.Join(root, "current", "elysian"), Commit: r.TargetCommit, Missing: true, State: "pending"}
	_ = config.AtomicJSON(w.Store.cliJournalPath(r.ID), journal)
	_ = os.WriteFile(path, []byte("external"), 0600)
	if err := w.ensureCLILink(context.Background(), r); err == nil {
		t.Fatal("覆盖外部命令")
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != "external" {
		t.Fatal("外部命令损坏")
	}
}

func TestLegacyRegistrationPreflightFailureIsVisibleAndRetryable(t *testing.T) {
	root, path := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, path, nil)
	r.State = "succeeded"
	r.Committed = true
	if err := w.Store.save(*r); err != nil {
		t.Fatal(err)
	}
	m := Manager{Store: w.Store, Enabled: true, Install: root, CLIBin: path, Executable: filepath.Join(root, "missing")}
	done, err := m.registerCommittedCLI(context.Background(), "")
	row, _ := w.Store.read(r.ID)
	if err != nil || !done || row.State != "succeeded" || row.CLIRegistration == nil || row.CLIRegistration.Status != "failed" {
		t.Fatalf("预检未收敛：%+v %v", row, err)
	}
	m.Executable = filepath.Join(root, "current", "elysian")
	task, err := m.retryCLIRegistration(context.Background(), r.ID)
	if err != nil || task.CLIRegistration.Status != "succeeded" {
		t.Fatalf("预检失败无法重试：%+v %v", task, err)
	}
}

func TestLegacyRegistrationSkipsOtherBuilds(t *testing.T) {
	old := Commit
	Commit = "different-build"
	t.Cleanup(func() { Commit = old })
	root, path := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, path, nil)
	r.State = "succeeded"
	r.Committed = true
	if err := w.Store.save(*r); err != nil {
		t.Fatal(err)
	}
	m := Manager{Store: w.Store, Enabled: true, Install: root, CLIBin: path, Executable: filepath.Join(root, "current", "elysian")}
	done, err := m.registerCommittedCLI(context.Background(), "")
	if err != nil || !done {
		t.Fatalf("旧任务未跳过：%v", err)
	}
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatal("为旧任务创建了命令")
	}
	if _, err := m.retryCLIRegistration(context.Background(), r.ID); err == nil {
		t.Fatal("重试接受了其他构建的旧任务")
	}
}
