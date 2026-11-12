package docker

import (
	"bytes"
	"context"
	"elysian/server/internal/seam"
	"errors"
	"io"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

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
	for _, test := range []struct {
		output string
		kind   shellKind
	}{{"bash=yes\n", shellBash}, {"bash=no\n", shellSh}, {"", shellNone}} {
		runner := &fakeExecRunner{run: func([]string, bool, []string) *execSession { return newFakeSession(test.output) }}
		if got := probeShell(runner); got != test.kind {
			t.Fatalf("shell=%s want %s", got, test.kind)
		}
	}
}
func TestNativeShellSpecification(t *testing.T) {
	for _, kind := range []shellKind{shellBash, shellSh} {
		spec := shellSpecFor(kind)
		cmd := shellCommandFor(spec, "nonce")
		if cmd[0] != "/bin/sh" || cmd[2] != dockerExecLauncher || cmd[4] != "nonce" {
			t.Fatalf("固定 launcher 参数: %v", cmd)
		}
		if !strings.Contains(strings.Join(spec.env, "\n"), "TERM=xterm-256color") {
			t.Fatal("缺终端类型")
		}
		if !strings.Contains(strings.Join(spec.env, "\n"), "HISTFILE=/dev/null") {
			t.Fatal("容器终端不能将命令持久化到历史文件")
		}
		joined := strings.Join(append(cmd, spec.env...), "\n")
		for _, forbidden := range []string{"--noediting", "-echo", "PROMPT_COMMAND", "PWD:"} {
			if strings.Contains(joined, forbidden) {
				t.Fatalf("遗留行编辑协议 %s", forbidden)
			}
		}
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

func TestExecPtyPreservesRawOutputAndInput(t *testing.T) {
	raw := []byte("\x1b[?1049h\x1b[31m中文🌍\r\n\x1b[0m\x1b[?1049l")
	var input bytes.Buffer
	runner := &fakeExecRunner{run: func(cmd []string, tty bool, env []string) *execSession {
		if !tty {
			t.Fatal("交互 shell 必须 TTY")
		}
		session := newFakeSession("\x01ELYSIAN:" + cmd[4] + ":42\x02" + string(raw))
		session.writeTarget = &input
		return session
	}}
	p, err := createExecPty(runner, shellSpecFor(shellBash))
	if err != nil {
		t.Fatal(err)
	}
	sent := []byte("a\t\x03\x1b[A\r")
	if n, err := p.Write(sent); err != nil || n != len(sent) {
		t.Fatalf("write %d %v", n, err)
	}
	output, err := io.ReadAll(p.Stdout())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(output, raw) || !bytes.Equal(input.Bytes(), sent) {
		t.Fatalf("字节被修改: output=%q input=%q", output, input.Bytes())
	}
	if code := <-p.Exited(); code != 0 {
		t.Fatalf("exit=%d", code)
	}
}
func TestExecPtyRejectsWrongNonce(t *testing.T) {
	runner := &fakeExecRunner{run: func([]string, bool, []string) *execSession { return newFakeSession("\x01ELYSIAN:wrong:42\x02") }}
	p, err := createExecPty(runner, shellSpecFor(shellSh))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(p.Stdout()); err == nil {
		t.Fatal("错误 nonce 被接受")
	}
}
func TestExecPtyKillCleansTrackedPIDOnce(t *testing.T) {
	runner := &fakeExecRunner{run: func(cmd []string, tty bool, _ []string) *execSession {
		if !tty {
			return newFakeSession("")
		}
		s := &execSession{queue: newBoundedChunkQueue(execStdoutMaxBytes)}
		_ = s.queue.push([]byte("\x01ELYSIAN:" + cmd[4] + ":123\x02waiting"))
		return s
	}}
	p, err := createExecPty(runner, shellSpecFor(shellSh))
	if err != nil {
		t.Fatal(err)
	}
	if err = p.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = p.Kill()
	calls := runner.recorded()
	if len(calls) != 2 || calls[1][2] != dockerExecCleanupScript || calls[1][4] != "123" {
		t.Fatalf("未精确清理一次: %v", calls)
	}
}
func TestLazyExecPtyCancelDuringOpen(t *testing.T) {
	started := make(chan struct{})
	p := createLazyExecPty(func(ctx context.Context) (seam.PtyProcess, error) {
		close(started)
		<-ctx.Done()
		return nil, errTerminalCancelled
	})
	done := make(chan error, 1)
	go func() { _, err := p.Write([]byte("x")); done <- err }()
	<-started
	_ = p.Kill()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("取消未传播")
		}
	case <-time.After(time.Second):
		t.Fatal("输入未取消")
	}
}
func TestLazyExecPtyKeepsLatestSizeAndKillsLateOpen(t *testing.T) {
	opened := make(chan struct{})
	release := make(chan struct{})
	inner := newFakePtyProcess()
	p := createLazyExecPty(func(context.Context) (seam.PtyProcess, error) { close(opened); <-release; return inner, nil })
	_ = p.Resize(90, 30)
	_ = p.Resize(132, 44)
	_ = p.Stdout()
	<-opened
	close(release)
	lazy := p.(*lazyExecPty)
	<-lazy.done
	inner.mu.Lock()
	cols, rows := inner.cols, inner.rows
	inner.mu.Unlock()
	if cols != 132 || rows != 44 {
		t.Fatalf("丢失最新尺寸 %dx%d", cols, rows)
	}
	_ = p.Kill()
	inner.mu.Lock()
	killed := inner.killed
	inner.mu.Unlock()
	if !killed {
		t.Fatal("未杀内部 PTY")
	}
}
func TestLazyExecPtyPreservesWriteFailure(t *testing.T) {
	inner := newFakePtyProcess()
	inner.writeErr = errors.New("write failed")
	p := createLazyExecPty(func(context.Context) (seam.PtyProcess, error) { return inner, nil })
	if _, err := p.Write([]byte("raw")); err == nil || err.Error() != "write failed" {
		t.Fatalf("丢失错误: %v", err)
	}
	_ = p.Kill()
}

type fakePtyProcess struct {
	mu         sync.Mutex
	killed     bool
	cols, rows int
	writeErr   error
	exited     chan int
	once       sync.Once
}

func newFakePtyProcess() *fakePtyProcess { return &fakePtyProcess{exited: make(chan int, 1)} }
func (p *fakePtyProcess) Write(b []byte) (int, error) {
	if p.writeErr != nil {
		return 0, p.writeErr
	}
	return len(b), nil
}
func (p *fakePtyProcess) Stdout() io.Reader { return strings.NewReader("") }
func (p *fakePtyProcess) Resize(cols, rows int) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.cols, p.rows = cols, rows
	return nil
}
func (p *fakePtyProcess) Kill() error {
	p.mu.Lock()
	p.killed = true
	p.mu.Unlock()
	p.once.Do(func() { p.exited <- 0 })
	return nil
}
func (p *fakePtyProcess) Exited() <-chan int { return p.exited }

func TestExecLauncherPrintsActualControlBytes(t *testing.T) {
	command := exec.Command("/bin/sh", "-c", dockerExecLauncher, "--", "nonce", "/bin/true")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatal(err)
	}
	prefix := []byte("\x01ELYSIAN:nonce:")
	if !bytes.HasPrefix(output, prefix) || len(output) == 0 || output[len(output)-1] != '\x02' {
		t.Fatalf("PID header must use actual control bytes: %q", output)
	}
	pid := string(output[len(prefix) : len(output)-1])
	if !pidPattern.MatchString(pid) {
		t.Fatalf("PID invalid: %q", pid)
	}
}

func TestExecPtyStreamFailureStillCleansPID(t *testing.T) {
	runner := &fakeExecRunner{run: func(cmd []string, tty bool, _ []string) *execSession {
		if !tty {
			return newFakeSession("")
		}
		s := &execSession{queue: newBoundedChunkQueue(execStdoutMaxBytes)}
		_ = s.queue.push([]byte("\x01ELYSIAN:" + cmd[4] + ":456\x02"))
		s.queue.fail(errors.New("hijack failed"))
		return s
	}}
	p, err := createExecPty(runner, shellSpecFor(shellBash))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(p.Stdout()); err == nil {
		t.Fatal("流错误未传播")
	}
	_ = p.Kill()
	calls := runner.recorded()
	if len(calls) != 2 || calls[1][4] != "456" {
		t.Fatalf("流断开被误认为进程已退出: %v", calls)
	}
}
