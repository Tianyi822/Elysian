package panel

import (
	"context"
	"elysian/server/internal/config"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// CLI 链接归属与维护事务补注册的回归测试：归属语义与 scripts/install.sh 的
// cli_link_owned 同源——「..」逃逸、经安装根符号链接外跳、外部文件与断链非受管
// 文本一律不判自家；新建与改指进入回滚范围；版本校验失败按任务失败处理。

// cliLinkFixture 建临时安装根：releases/old 与 releases/new 各放一个可执行的
// elysian 桩（--version 打印给定构建标识）、current 指向 old，bin 为 CLI 落点父目录。
func cliLinkFixture(t *testing.T, commit string) (string, string) {
	t.Helper()
	root := t.TempDir()
	for _, rel := range []string{"old", "new"} {
		dir := filepath.Join(root, "releases", rel)
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
		script := "#!/bin/sh\ncase \"$1\" in --version) printf 'Elysian CLI（ely）\\n版本：" + commit + "\\n' ;; esac\n"
		if err := os.WriteFile(filepath.Join(dir, "elysian"), []byte(script), 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(root, "releases", "old"), filepath.Join(root, "current")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "bin"), 0755); err != nil {
		t.Fatal(err)
	}
	return root, filepath.Join(root, "bin", "ely")
}

func cliLinkWorker(t *testing.T, root, cli string, verify func(context.Context, string, string) error) (Worker, *taskRecord) {
	t.Helper()
	s := Store{Root: filepath.Join(t.TempDir(), "store")}
	p := config.DefaultPanelNetwork()
	r := &taskRecord{Task: Task{ID: strings.Repeat("a", 32), Kind: "update", State: "running", TargetCommit: "deadbeef", OldPorts: p, NewPorts: p, CreatedAt: time.Now().UTC()}}
	if err := s.lock(func() error { return s.save(*r) }); err != nil {
		t.Fatal(err)
	}
	return Worker{Store: s, Install: root, CLIBin: cli, CLIVerify: verify}, r
}

func readLinkText(t *testing.T, p string) string {
	t.Helper()
	text, err := os.Readlink(p)
	if err != nil {
		t.Fatal(err)
	}
	return text
}

func TestEnsureCLILinkRegistersMissingWithRealVersionCheck(t *testing.T) {
	root, cli := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, cli, nil)
	if err := w.ensureCLILink(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if text := readLinkText(t, cli); text != filepath.Join(root, "current", "elysian") {
		t.Fatalf("链接指向不符：%s", text)
	}
	stored, err := w.Store.read(r.ID)
	if err != nil || !stored.CLICreated || stored.CLIRelinkedFrom != "" {
		t.Fatalf("新建事实未落账：%+v %v", stored, err)
	}
}

func TestEnsureCLILinkVersionMismatchFailsAndRollbackRemoves(t *testing.T) {
	root, cli := cliLinkFixture(t, "othercommit")
	w, r := cliLinkWorker(t, root, cli, nil)
	err := w.ensureCLILink(context.Background(), r)
	if err == nil || !strings.Contains(err.Error(), "校验失败") {
		t.Fatalf("版本不符应判任务失败：%v", err)
	}
	if err := w.rollbackCLILink(r); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(cli); !os.IsNotExist(err) {
		t.Fatalf("回滚后应移除本次注册的链接：%v", err)
	}
}

func TestEnsureCLILinkCanonicalManagedLinkIsNoop(t *testing.T) {
	root, cli := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, cli, nil)
	if err := os.Symlink(filepath.Join(root, "current", "elysian"), cli); err != nil {
		t.Fatal(err)
	}
	if err := w.ensureCLILink(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	stored, err := w.Store.read(r.ID)
	if err != nil || stored.CLICreated || stored.CLIRelinkedFrom != "" {
		t.Fatalf("受管形态不应记录变更：%+v %v", stored, err)
	}
}

func TestEnsureCLILinkOccupiedFileFailsWithoutTouching(t *testing.T) {
	root, cli := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, cli, nil)
	if err := os.WriteFile(cli, []byte("foreign"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := w.ensureCLILink(context.Background(), r); err == nil {
		t.Fatal("外部占用必须报告注册失败")
	}
	data, err := os.ReadFile(cli)
	if err != nil || string(data) != "foreign" {
		t.Fatalf("外部文件被改动：%v", err)
	}
	stored, err := w.Store.read(r.ID)
	if err != nil || stored.CLICreated || stored.CLIRelinkedFrom != "" {
		t.Fatalf("告警场景不应记录变更：%+v %v", stored, err)
	}
}

func TestEnsureCLILinkRelinksOwnedReleasesLinkAndRollbackRestores(t *testing.T) {
	root, cli := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, cli, nil)
	original := filepath.Join(root, "releases", "old", "elysian")
	if err := os.Symlink(original, cli); err != nil {
		t.Fatal(err)
	}
	if err := w.ensureCLILink(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if text := readLinkText(t, cli); text != filepath.Join(root, "current", "elysian") {
		t.Fatalf("自家 releases 链接未改指 current：%s", text)
	}
	stored, err := w.Store.read(r.ID)
	if err != nil || stored.CLIRelinkedFrom != original {
		t.Fatalf("改指事实未落账：%+v %v", stored, err)
	}
	if err := w.rollbackCLILink(r); err != nil {
		t.Fatal(err)
	}
	if text := readLinkText(t, cli); text != original {
		t.Fatalf("回滚未恢复升级前指向：%s", text)
	}
}

func TestEnsureCLILinkRejectsEscapeTargets(t *testing.T) {
	root, cli := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, cli, nil)
	foreign := filepath.Join(filepath.Dir(root), "foreign-ely")
	if err := os.WriteFile(foreign, []byte("x"), 0644); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(root, "..", "foreign-ely")
	if err := os.Symlink(escape, cli); err != nil {
		t.Fatal(err)
	}
	if err := w.ensureCLILink(context.Background(), r); err == nil {
		t.Fatal("逃逸目标必须报告注册失败")
	}
	if text := readLinkText(t, cli); text != escape {
		t.Fatalf("逃逸链接被改动：%s", text)
	}

	// 经安装根内符号链接跳向外部的目标同样不得判为自家。
	if err := os.Remove(cli); err != nil {
		t.Fatal(err)
	}
	hop := filepath.Join(root, "escape-hop")
	if err := os.Symlink(foreign, hop); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(hop, cli); err != nil {
		t.Fatal(err)
	}
	if err := w.ensureCLILink(context.Background(), r); err == nil {
		t.Fatal("外跳目标必须报告注册失败")
	}
	if text := readLinkText(t, cli); text != hop {
		t.Fatalf("外跳链接被改动：%s", text)
	}
	stored, err := w.Store.read(r.ID)
	if err != nil || stored.CLICreated || stored.CLIRelinkedFrom != "" {
		t.Fatalf("逃逸场景不应记录变更：%+v %v", stored, err)
	}
}

func TestRollbackCLILinkLeavesExternalReplacementAlone(t *testing.T) {
	root, cli := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, cli, nil)
	r.CLICreated = true
	if err := os.WriteFile(cli, []byte("taken-over"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := w.rollbackCLILink(r); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(cli)
	if err != nil || string(data) != "taken-over" {
		t.Fatalf("外部接管后回滚误删：%v", err)
	}
}

func TestRollbackCLILinkSkipsWhenNothingTracked(t *testing.T) {
	root, cli := cliLinkFixture(t, "deadbeef")
	w, r := cliLinkWorker(t, root, cli, nil)
	if err := os.Symlink(filepath.Join(root, "current", "elysian"), cli); err != nil {
		t.Fatal(err)
	}
	if err := w.rollbackCLILink(r); err != nil {
		t.Fatal(err)
	}
	if text := readLinkText(t, cli); text != filepath.Join(root, "current", "elysian") {
		t.Fatalf("无事务事实时不应动链接：%s", text)
	}
}
