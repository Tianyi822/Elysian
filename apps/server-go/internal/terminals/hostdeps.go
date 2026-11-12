package terminals

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"os/user"
	"sort"
	"strconv"
	"sync"
	"syscall"

	"github.com/creack/pty"

	"elysian/server/internal/seam"
)

// newHostDeps connects native PTYs; all line editing belongs to the shell.
func newHostDeps() seam.TerminalHostDeps { return seam.TerminalHostDeps{SpawnPty: spawnPtyShell} }

// envPairs 组装命令环境；env 是无序集合，键序排序只为确定性。
func envPairs(env map[string]string) []string {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	pairs := make([]string, 0, len(env))
	for _, k := range keys {
		pairs = append(pairs, k+"="+env[k])
	}
	return pairs
}

// spawnPtyShell starts an interactive shell with native readline and echo.
func spawnPtyShell(ctx context.Context, spec seam.ShellSessionSpec, identity seam.TerminalIdentity) (seam.PtyProcess, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cmd := exec.Command("/bin/bash", "-i")
	cmd.Dir = identity.HomeDir
	cmd.Env = envPairs(spec.Env)
	master, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: TERMINAL_COLS, Rows: TERMINAL_ROWS})
	if err != nil {
		return nil, err
	}
	p := &hostPty{cmd: cmd, master: master, exited: make(chan int, 1), done: make(chan struct{})}
	go func() {
		p.exited <- exitCodeOf(cmd.Wait())
		close(p.exited)
		close(p.done)
	}()
	return p, nil
}

// exitCodeOf 退出码归一：信号终止按 128+信号号（对齐 TS Bun 的 exited 语义，如
// SIGKILL → 137），无法解析按 1。
func exitCodeOf(err error) int {
	if err == nil {
		return 0
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok {
			if ws.Signaled() {
				return 128 + int(ws.Signal())
			}
			return ws.ExitStatus()
		}
	}
	return 1
}

// hostPty 真实 PTY 进程：master 即读写两端；Kill 幂等（对已退出进程重复 kill 忽略）。
type hostPty struct {
	cmd      *exec.Cmd
	master   *os.File
	exited   chan int
	done     chan struct{}
	killOnce sync.Once
}

func (p *hostPty) Write(b []byte) (int, error) { return p.master.Write(b) }

func (p *hostPty) Stdout() io.Reader { return p.master }

func (p *hostPty) Resize(cols, rows int) error {
	return pty.Setsize(p.master, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// Kill SIGKILL 整个进程组并关闭 master：bash 是会话首领（pid == pgid == sid），
// 组内进程直接击杀；其余进程组由会话首领死亡与 master 关闭触发内核 SIGHUP 级联
// 清理（断开即杀、无孤儿）。幂等：信号只发一次，重复调用只等退出码。
func (p *hostPty) Kill() error {
	p.killOnce.Do(func() {
		if proc := p.cmd.Process; proc != nil {
			if err := syscall.Kill(-proc.Pid, syscall.SIGKILL); err != nil {
				_ = syscall.Kill(proc.Pid, syscall.SIGKILL)
			}
		}
		_ = p.master.Close()
	})
	<-p.done
	return nil
}

// Exited 退出码；首值送达后关闭，后续接收得零值（调用方只收一次）。
func (p *hostPty) Exited() <-chan int { return p.exited }

// resolveHostIdentity 身份解析：os/user 为主；无 passwd 查询结果（占位 unknown 或空）
// 时按 uid 推导（0 → root，否则 uid 字符串）。
func resolveHostIdentity() seam.TerminalIdentity {
	var name, home string
	if u, err := user.Current(); err == nil {
		name, home = u.Username, u.HomeDir
	}
	if name == "" || name == "unknown" {
		if os.Getuid() == 0 {
			name = "root"
		} else {
			name = strconv.Itoa(os.Getuid())
		}
	}
	if home == "" {
		if h, err := os.UserHomeDir(); err == nil {
			home = h
		}
	}
	label, err := os.Hostname()
	if err != nil {
		label = ""
	}
	return seam.TerminalIdentity{User: name, HostLabel: label, HomeDir: home}
}
