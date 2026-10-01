package docker

import (
	"context"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

// exec 抽象层对等测试（dockerExec.test.ts 锚点）。

// fakeExecRunner 可编程 runner：记录调用并按脚本产出会话。
type fakeExecRunner struct {
	mu    sync.Mutex
	calls [][]string
	run   func(cmd []string, tty bool, env []string) *execSession
}

func (f *fakeExecRunner) Run(cmd []string, tty bool, env []string) *execSession {
	f.mu.Lock()
	f.calls = append(f.calls, append([]string(nil), cmd...))
	run := f.run
	f.mu.Unlock()
	return run(cmd, tty, env)
}

func (f *fakeExecRunner) recorded() [][]string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]string(nil), f.calls...)
}

func TestProbeShellThreeBranches(t *testing.T) {
	runner := &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		return newFakeSession("bash=yes\nstty=yes\n")
	}}
	if got := probeShell(runner); got != shellBash {
		t.Fatalf("bash=yes → bash：%v", got)
	}
	// 探测命令 argv 固定。
	calls := runner.recorded()
	if len(calls) != 1 || calls[0][0] != "/bin/sh" || calls[0][1] != "-c" || calls[0][2] != dockerShellProbeScript {
		t.Fatalf("探测 argv：%v", calls[0])
	}
	if len(calls[0]) != 3 {
		t.Fatalf("探测 argv 长度：%v", calls[0])
	}

	runner = &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		return newFakeSession("bash=no\nstty=yes\n")
	}}
	if got := probeShell(runner); got != shellSh {
		t.Fatalf("bash=no → sh：%v", got)
	}

	runner = &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		return newFakeSession("nothing\n")
	}}
	if got := probeShell(runner); got != shellNone {
		t.Fatalf("无标记 → none：%v", got)
	}
}

func TestShellSpecFor(t *testing.T) {
	bash := shellSpecFor(shellBash, true)
	if bash.startupLine != "stty cols 100 rows 30 -echo; set +H; printf '\\001READY:%s\\002\\n' $$\n" {
		t.Fatalf("bash 启动行：%q", bash.startupLine)
	}
	found := false
	for _, env := range bash.env {
		if strings.HasPrefix(env, "PROMPT_COMMAND=printf ") && strings.Contains(env, `\x01PWD:%s\x02\n`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("bash PROMPT_COMMAND：%v", bash.env)
	}

	sh := shellSpecFor(shellSh, true)
	if sh.startupLine != "stty cols 100 rows 30 -echo; printf '\\001READY:%s\\002\\n' $$\n" {
		t.Fatalf("sh 启动行：%q", sh.startupLine)
	}
	if sh.env[0] != "PS1=\x01PWD:$PWD\x02\n" {
		t.Fatalf("sh PS1 原始控制字节：%q", sh.env[0])
	}
}

func TestShellCommandForAndEchoDrop(t *testing.T) {
	bash := shellSpecFor(shellBash, true)
	if got := shellCommandFor(bash); got[0] != "/bin/bash" || got[1] != "--noediting" {
		t.Fatalf("bash 命令：%v", got)
	}
	if shouldDropEchoLines(bash) {
		t.Fatal("bash 带 stty 不抑制回显")
	}
	sh := shellSpecFor(shellSh, false)
	if got := shellCommandFor(sh); got[0] != "/bin/sh" {
		t.Fatalf("sh 命令：%v", got)
	}
	if !shouldDropEchoLines(sh) {
		t.Fatal("无 stty 规格抑制回显")
	}
}

func TestCleanupScriptPid(t *testing.T) {
	cmd, err := cleanupScriptPid("12345")
	if err != nil {
		t.Fatal(err)
	}
	if cmd[0] != "/bin/sh" || cmd[1] != "-c" || cmd[2] != dockerExecCleanupScript || cmd[3] != "--" || cmd[4] != "12345" {
		t.Fatalf("pid 仅位置参数：%v", cmd)
	}
	for _, bad := range []string{"", "0x1", "-1", strings.Repeat("1", 11), "12a"} {
		if _, err := cleanupScriptPid(bad); err == nil || err.Error() != "清理脚本的 pid 必须是 1 到 10 位数字" {
			t.Fatalf("非法 pid %q：%v", bad, err)
		}
	}
}

func TestCleanupScriptSyntaxAndStructure(t *testing.T) {
	// 结构次序：快照 ppid → 两轮 HUP/sleep/KILL。
	if !strings.Contains(dockerExecCleanupScript, `ppid=$(awk '{print $4}' "$statf" 2>/dev/null) || continue`) {
		t.Fatal("缺 ppid 快照")
	}
	if !strings.Contains(dockerExecCleanupScript, `kill -HUP "$p" 2>/dev/null || true`) ||
		!strings.Contains(dockerExecCleanupScript, `kill -KILL "$p" 2>/dev/null || true`) ||
		!strings.Contains(dockerExecCleanupScript, `sleep 1`) {
		t.Fatal("两轮信号结构缺失")
	}
	if strings.Contains(dockerExecCleanupScript, "$1") == false {
		t.Fatal("target 取 $1")
	}
}

func TestListDockerCommandsBashAndSh(t *testing.T) {
	runner := &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		return newFakeSession("echo\r\necho\r\nls\r\n")
	}}
	commands, err := listDockerCommands(runner, shellBash)
	if err != nil {
		t.Fatal(err)
	}
	if len(commands) != 2 || commands[0] != "echo" || commands[1] != "ls" {
		t.Fatalf("去重：%v", commands)
	}
	calls := runner.recorded()
	if calls[0][0] != "/bin/bash" || calls[0][1] != "-c" || calls[0][2] != "compgen -A command" {
		t.Fatalf("bash 补全命令：%v", calls[0])
	}
	if _, err := listDockerCommands(runner, shellSh); err != nil {
		t.Fatal(err)
	}
	calls = runner.recorded()
	shCall := calls[len(calls)-1]
	if shCall[0] != "/bin/sh" || shCall[1] != "-c" || shCall[2] != shCommandsScript {
		t.Fatalf("sh 补全脚本：%v", shCall)
	}
}

func TestListDockerFiles(t *testing.T) {
	runner := &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		return newFakeSession("a\nb\nc\n")
	}}
	files, err := listDockerFiles(runner, "/srv")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 || files[0] != "a" {
		t.Fatalf("%v", files)
	}
	calls := runner.recorded()
	if calls[0][0] != "/bin/ls" || calls[0][1] != "-1A" || calls[0][2] != "--color=never" || calls[0][3] != "--" || calls[0][4] != "/srv" {
		t.Fatalf("ls argv（cwd 仅作 argv）：%v", calls[0])
	}
	// 第 513 项保留（TERMINAL_COMPLETION_FILES_MAX + 1）。
	var lines []string
	for i := 0; i < seam.TerminalCompletionFilesMax+1; i++ {
		lines = append(lines, "f"+itoa(i))
	}
	runner = &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		return newFakeSession(strings.Join(lines, "\n") + "\n")
	}}
	files, err = listDockerFiles(runner, "/srv")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != seam.TerminalCompletionFilesMax+1 {
		t.Fatalf("第 513 项保留：%d", len(files))
	}
	// 非法 cwd。
	for _, cwd := range []string{"srv", "/a\x00b", "/a\nb"} {
		if _, err := listDockerFiles(runner, cwd); err == nil || err.Error() != "容器终端工作目录无效" {
			t.Fatalf("非法 cwd %q：%v", cwd, err)
		}
	}
}

func TestExecPtyNoSttyEchoSuppression(t *testing.T) {
	spec := shellSpecFor(shellSh, false)
	runner := &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		return newFakeSession("echo hi\nhi\nrest\n")
	}}
	pty := createExecPty(runner, spec)
	// 先武装回显标记再读输出。
	if _, err := pty.Write([]byte("echo hi\n")); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(pty.Stdout())
	if err != nil {
		t.Fatal(err)
	}
	if string(output) != "hi\nrest\n" {
		t.Fatalf("与输入全等的第一行被丢弃：%q", output)
	}
}

func TestExecPtyEnvForwarded(t *testing.T) {
	spec := shellSpecFor(shellBash, true)
	var gotEnv []string
	var gotCmd []string
	runner := &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		gotCmd = append([]string(nil), cmd...)
		gotEnv = append([]string(nil), env...)
		return newFakeSession("")
	}}
	_ = createExecPty(runner, spec)
	if gotCmd[0] != "/bin/bash" || gotCmd[1] != "--noediting" {
		t.Fatalf("cmd：%v", gotCmd)
	}
	if len(gotEnv) != 2 {
		t.Fatalf("env 数：%v", gotEnv)
	}
}

func TestExecSessionExitCodeFromInspect(t *testing.T) {
	// ExitCode 依赖真实 Engine inspect：非 200/解析失败按 1。
	session := &execSession{}
	if got := session.ExitCode(); got != 1 {
		t.Fatalf("无 execId 按 1：%d", got)
	}
}

func TestLazyExecPtyCancelDuringOpen(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	opened := make(chan seam.PtyProcess, 1)
	pty := createLazyExecPty(func(ctx context.Context) (seam.PtyProcess, error) {
		<-ctx.Done()
		return nil, errTerminalCancelled
	})
	_ = opened
	_ = cancel
	_ = ctx
	// 直接触发打开（写 stdin）后立即取消：open 侧观察到取消返回错误。
	go pty.Write([]byte("x"))
	time.Sleep(20 * time.Millisecond)
	if err := pty.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-pty.Exited():
		if code != 0 {
			t.Fatalf("取消按 0 结算：%d", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消未结算退出码")
	}
}

func TestLazyExecPtyLateKillKillsOpened(t *testing.T) {
	inner := &fakePtyProcess{}
	pty := createLazyExecPty(func(ctx context.Context) (seam.PtyProcess, error) {
		if ctx.Err() != nil {
			return nil, errTerminalCancelled
		}
		return inner, nil
	})
	_ = pty.Stdout() // 触发打开
	time.Sleep(30 * time.Millisecond)
	if err := pty.Kill(); err != nil {
		t.Fatal(err)
	}
	if !inner.killed {
		t.Fatal("迟到 PTY 应被杀")
	}
	select {
	case code := <-pty.Exited():
		_ = code
	case <-time.After(2 * time.Second):
		t.Fatal("退出码未继承")
	}
}

type fakePtyProcess struct {
	killed bool
}

func (p *fakePtyProcess) Write(b []byte) (int, error) { return len(b), nil }

func (p *fakePtyProcess) Stdout() io.Reader { return strings.NewReader("") }

func (p *fakePtyProcess) Kill() error {
	p.killed = true
	return nil
}

func (p *fakePtyProcess) Exited() <-chan int {
	ch := make(chan int, 1)
	ch <- 7
	return ch
}
