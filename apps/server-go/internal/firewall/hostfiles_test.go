package firewall

import (
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// hostFiles.test.ts 的对等测试：真实临时目录验证「同目录临时文件 + rename」、
// 失败清理，以及内核接口路径不走原子替换。

func TestAtomicWriteTextReplacesAtomically(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "before.rules")

	if err := atomicWriteText(path, "第一版\n"); err != nil {
		t.Fatalf("第一次写入失败：%v", err)
	}
	if err := atomicWriteText(path, "第二版\n"); err != nil {
		t.Fatalf("第二次写入失败：%v", err)
	}

	got, err := os.ReadFile(path)
	if err != nil || string(got) != "第二版\n" {
		t.Fatalf("内容应为第二版，got %q err=%v", got, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "before.rules" {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("目录里只应有目标文件（无临时残留），got %v", names)
	}
}

func TestAtomicWriteTextCleansUpTempOnFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "before.rules")
	if err := atomicWriteText(path, "原内容\n"); err != nil {
		t.Fatalf("首次写入失败：%v", err)
	}

	// 目标被目录占位：rename 到已存在目录会失败，模拟落盘中途出错。
	blocked := filepath.Join(dir, "blocked")
	if err := os.Mkdir(blocked, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := atomicWriteText(blocked, "新内容\n"); err == nil {
		t.Fatal("写目录应失败")
	}

	got, err := os.ReadFile(path)
	if err != nil || string(got) != "原内容\n" {
		t.Fatalf("目标文件应保持原内容，got %q err=%v", got, err)
	}
	entries, _ := os.ReadDir(dir)
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	if len(names) != 2 || names[0] != "before.rules" || names[1] != "blocked" {
		t.Fatalf("失败后应清理临时文件，目录内容 = %v", names)
	}
}

func TestIsKernelInterfacePath(t *testing.T) {
	for _, p := range []string{
		"/proc/sys/net/ipv4/ip_forward",
		"/proc/net/xt_recent/ELYSIAN_SCAN_BANNED",
		"/sys/kernel/mm/transparent_hugepage/enabled",
	} {
		if !isKernelInterfacePath(p) {
			t.Errorf("%s 应识别为内核接口路径", p)
		}
	}
	for _, p := range []string{
		"/etc/ufw/before.rules",
		"/etc/ufw/before.rules.elysian",
		"/etc/default/ufw",
	} {
		if isKernelInterfacePath(p) {
			t.Errorf("%s 不应识别为内核接口路径", p)
		}
	}
}

func TestWriteHostFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "before.rules")

	if err := writeHostFile(path, "第一版\n"); err != nil {
		t.Fatalf("第一次写入失败：%v", err)
	}
	if err := writeHostFile(path, "第二版\n"); err != nil {
		t.Fatalf("第二次写入失败：%v", err)
	}
	got, _ := os.ReadFile(path)
	if string(got) != "第二版\n" {
		t.Fatalf("普通文件走原子替换，got %q", got)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("目录里只应有目标文件，got %d 项", len(entries))
	}

	// 写失败原样抛出，不静默吞掉。
	missing := filepath.Join(dir, "不存在的目录", "before.rules")
	if err := writeHostFile(missing, "内容\n"); err == nil {
		t.Fatal("写不存在的目录应失败")
	}
}
