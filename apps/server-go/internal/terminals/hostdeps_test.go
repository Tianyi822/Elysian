package terminals

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// 宿主交互锚定：env 组装、提示符 HOME 归一、compgen 进程级缓存（成功缓存/失败重试）、
// readdir 排序，以及容器内真实 PTY 冒烟（盘点 §8.7 的可单测子集：READY 哨兵产出、
// 断开即杀无孤儿、kill 幂等）。可用性双闸门由 internal/config 判定（config_test 锚定），
// 本包以 Deps.Available 注入，不自测 /.dockerenv。

func TestEnvPairs键序稳定(t *testing.T) {
	pairs := envPairs(map[string]string{"B": "2", "A": "1", "C": "3"})
	want := []string{"A=1", "B=2", "C=3"}
	if strings.Join(pairs, "|") != strings.Join(want, "|") {
		t.Fatalf("envPairs = %v，期望 %v", pairs, want)
	}
}

func TestBuildTerminalPrompt与TildePath(t *testing.T) {
	ident := seam.TerminalIdentity{User: "root", HostLabel: "elysian-web-1", HomeDir: "/root"}
	cases := []struct{ cwd, want string }{
		{"/root", "~"},
		{"/root/apps/web", "~/apps/web"},
		{"/tmp", "/tmp"},
		{"/rootkit", "/rootkit"}, // 前缀相似但非 HOME 子路径
	}
	for _, tc := range cases {
		if got := tildePath(tc.cwd, ident.HomeDir); got != tc.want {
			t.Fatalf("tildePath(%s) = %s，期望 %s", tc.cwd, got, tc.want)
		}
	}
	if got := buildTerminalPrompt(ident, "/tmp"); got != "root@elysian-web-1:/tmp$ " {
		t.Fatalf("提示符 = %q", got)
	}
	// homeDir 为 / 时不做前缀替换。
	rootIdent := seam.TerminalIdentity{User: "root", HostLabel: "h", HomeDir: "/"}
	if got := tildePath("/etc", rootIdent.HomeDir); got != "/etc" {
		t.Fatalf("homeDir 为 / 时不应替换：%q", got)
	}
}

func TestCompgen命令表进程级缓存(t *testing.T) {
	orig := runCompgen
	t.Cleanup(func() {
		runCompgen = orig
		resetCompgenCache()
	})
	resetCompgenCache()

	var calls atomic.Int64
	runCompgen = func(context.Context) ([]string, error) {
		calls.Add(1)
		return []string{"bash", "ls"}, nil
	}
	first, err := listCommands(context.Background())
	if err != nil || strings.Join(first, ",") != "bash,ls" {
		t.Fatalf("首次调用 = %v（%v）", first, err)
	}
	second, err := listCommands(context.Background())
	if err != nil || len(second) != 2 {
		t.Fatalf("缓存调用 = %v（%v）", second, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("成功应进程级缓存，实际探测 %d 次", calls.Load())
	}
}

func TestCompgen失败不缓存允许重试(t *testing.T) {
	orig := runCompgen
	t.Cleanup(func() {
		runCompgen = orig
		resetCompgenCache()
	})
	resetCompgenCache()

	var calls atomic.Int64
	runCompgen = func(context.Context) ([]string, error) {
		if calls.Add(1) == 1 {
			return nil, errors.New("compgen 失败")
		}
		return []string{"ls"}, nil
	}
	if _, err := listCommands(context.Background()); err == nil {
		t.Fatal("首次失败应带回错误（调用方降级空表）")
	}
	second, err := listCommands(context.Background())
	if err != nil || strings.Join(second, ",") != "ls" {
		t.Fatalf("失败后应允许重试：%v（%v）", second, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("探测 %d 次，期望 2", calls.Load())
	}
}

func TestListDir按文件名排序(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"b.txt", "a.txt", "c.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	names, err := listDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(names, ",") != "a.txt,b.txt,c.txt" {
		t.Fatalf("listDir = %v，期望排序", names)
	}
}

func Test身份解析非空(t *testing.T) {
	ident := resolveHostIdentity()
	if ident.User == "" || ident.HomeDir == "" || ident.HostLabel == "" {
		t.Fatalf("身份不应有空洞字段：%+v", ident)
	}
	if os.Getuid() == 0 && ident.User != "root" {
		t.Fatalf("uid 0 应回退 root：%+v", ident)
	}
}

// requireRealPty 真实 PTY 冒烟前置：/bin/bash 与 procfs 可用（go-dev 容器内成立；
// 无 bash 或无 /proc 的环境跳过——冒烟族按盘点 §8.7 属容器内执行）。
func requireRealPty(t *testing.T) {
	t.Helper()
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("环境无 /bin/bash，跳过真实 PTY 冒烟（容器内门禁才执行）")
	}
	if _, err := os.Stat("/proc"); err != nil {
		t.Skip("环境无 procfs，跳过断开即杀断言")
	}
}

// readUntilReady 阻塞读 PTY 输出直至出现 READY 哨兵（超时 8 秒）。
func readUntilReady(t *testing.T, stdout io.Reader) {
	t.Helper()
	type readResult struct {
		n   int
		err error
	}
	buf := make([]byte, 4096)
	var acc bytes.Buffer
	for {
		ch := make(chan readResult, 1)
		go func() {
			n, err := stdout.Read(buf)
			ch <- readResult{n, err}
		}()
		select {
		case r := <-ch:
			if r.n > 0 {
				acc.Write(buf[:r.n])
				if strings.Contains(acc.String(), "\x01READY\x02") {
					return
				}
			}
			if r.err != nil {
				t.Fatalf("READY 前流结束：%v（已收 %q）", r.err, acc.String())
			}
		case <-time.After(8 * time.Second):
			t.Fatalf("等待 READY 哨兵超时（已收 %q）", acc.String())
		}
	}
}

func procHasSleep300() bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return false
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		data, err := os.ReadFile("/proc/" + e.Name() + "/cmdline")
		if err != nil {
			continue
		}
		fields := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
		if len(fields) >= 2 && fields[0] == "sleep" && fields[1] == "300" {
			return true
		}
	}
	return false
}

func Test真实PTY启动行产出READY哨兵且断开即杀无孤儿(t *testing.T) {
	requireRealPty(t)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("无 home 目录，跳过真实 PTY 冒烟")
	}
	proc, err := spawnPtyShell(context.Background(), seam.ShellSessionSpec{
		Env:         buildPtyEnv(home, HostShellSessionSpec.Env),
		StartupLine: HostShellSessionSpec.StartupLine,
	}, seam.TerminalIdentity{User: "root", HostLabel: "test", HomeDir: home})
	if err != nil {
		t.Fatalf("pty 启动失败：%v", err)
	}
	// 写启动行 → bash 产出真实 READY 哨兵控制字节。
	if _, err := proc.Write([]byte(HostShellSessionSpec.StartupLine)); err != nil {
		t.Fatalf("启动行写入失败：%v", err)
	}
	readUntilReady(t, proc.Stdout())

	// 起一个长驻子进程（独立进程组，验证 SIGHUP 级联而非仅组内击杀）。
	if _, err := proc.Write([]byte("sleep 300\n")); err != nil {
		t.Fatalf("sleep 写入失败：%v", err)
	}
	waitFor(t, procHasSleep300, "sleep 300 未启动")

	// 断开即杀：kill 后整棵进程树清理，无孤儿残留。
	if err := proc.Kill(); err != nil {
		t.Fatalf("kill 失败：%v", err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for procHasSleep300() {
		if time.Now().After(deadline) {
			t.Fatal("断开后 sleep 300 残留（孤儿）")
		}
		time.Sleep(20 * time.Millisecond)
	}
	// kill 幂等：重复 kill 不报错。
	if err := proc.Kill(); err != nil {
		t.Fatalf("重复 kill 失败：%v", err)
	}
	<-proc.Exited()
}

func Test真实PTY自然退出码(t *testing.T) {
	requireRealPty(t)
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("无 home 目录，跳过真实 PTY 冒烟")
	}
	proc, err := spawnPtyShell(context.Background(), seam.ShellSessionSpec{
		Env:         buildPtyEnv(home, HostShellSessionSpec.Env),
		StartupLine: HostShellSessionSpec.StartupLine,
	}, seam.TerminalIdentity{User: "root", HostLabel: "test", HomeDir: home})
	if err != nil {
		t.Fatalf("pty 启动失败：%v", err)
	}
	if _, err := proc.Write([]byte(HostShellSessionSpec.StartupLine)); err != nil {
		t.Fatalf("启动行写入失败：%v", err)
	}
	readUntilReady(t, proc.Stdout())
	if _, err := proc.Write([]byte("exit 7\n")); err != nil {
		t.Fatalf("exit 写入失败：%v", err)
	}
	var code int
	select {
	case code = <-proc.Exited():
	case <-time.After(5 * time.Second):
		t.Fatal("等待退出码超时")
	}
	if code != 7 {
		t.Fatalf("退出码 = %d，期望 7", code)
	}
}

func TestNewRouter不可用分支构造(t *testing.T) {
	// NewRouter 的不可用分支不触宿主依赖（不 spawn PTY、不探测文件系统）。
	r := NewRouter(Deps{Available: false})
	code, body := doRequest(t, r, "GET", "/status", nil)
	if code != 503 || body != `{"error":"真实终端仅在 Docker 容器内可用"}` {
		t.Fatalf("503 分支 = %d %s", code, body)
	}
}

// 并发上限与 kit 的编译期 seam 形状锚定。
var (
	_ seam.TerminalsService   = (*service)(nil)
	_ seam.TerminalSession    = (*session)(nil)
	_ seam.TerminalConnEvents = (*connEvents)(nil)
	_ seam.TerminalKit        = kit{}
	_ sessionEvents           = (*frameRecorder)(nil)
	_ seam.SessionConnections = (*testSessionConnections)(nil)
	_ seam.Logs               = (*fakeLogs)(nil)
)
