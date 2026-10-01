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
	"strings"
	"sync"
	"syscall"

	"github.com/creack/pty"

	"elysian/server/internal/seam"
)

// 本机宿主交互：creack/pty 直接 pty.Start 驱动真实 bash（bash 经 pty 成为会话首领，
// SIGKILL 整个进程组 + 关 master 触发内核对残余会话的 SIGHUP 级联，保「断开即杀、
// 无孤儿」）、env 白名单（spawn env 由服务层合并后经 spec.Env 传入）、readdir 文件
// 表与 compgen 命令表（进程级缓存）。可用性双闸门（ELYSIAN_DOCKER=1 且 /.dockerenv
// 实存）由 config 判定、装配层以 Deps.Available 注入，本包不读 env、不自测文件。

// newHostDeps 本机宿主依赖注入。
func newHostDeps() seam.TerminalHostDeps {
	return seam.TerminalHostDeps{
		SpawnPty:     spawnPtyShell,
		ListCommands: listCommands,
		ListDir:      listDir,
		// DisposeShell 本机终端无容器 exec 清理脚本；Prompt 缺省 root@host:~$ 形态。
	}
}

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

// spawnPtyShell 以 pty.Start 打开真实 bash：stdin/stdout 即 pty master，cwd 与 env
// 来自身份与驯化规格。--noediting（禁 readline 编辑模式）与启动行的 stty -echo
// （关回显）是行模型的前提。
func spawnPtyShell(_ context.Context, spec seam.ShellSessionSpec, identity seam.TerminalIdentity) (seam.PtyProcess, error) {
	cmd := exec.Command("/bin/bash", "--noediting")
	cmd.Dir = identity.HomeDir
	cmd.Env = envPairs(spec.Env)
	master, err := pty.Start(cmd)
	if err != nil {
		return nil, err
	}
	p := &hostPty{cmd: cmd, master: master, exited: make(chan int, 1)}
	go func() {
		p.exited <- exitCodeOf(cmd.Wait())
		close(p.exited)
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
	killOnce sync.Once
}

func (p *hostPty) Write(b []byte) (int, error) { return p.master.Write(b) }

func (p *hostPty) Stdout() io.Reader { return p.master }

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
	<-p.exited
	return nil
}

// Exited 退出码；首值送达后关闭，后续接收得零值（调用方只收一次）。
func (p *hostPty) Exited() <-chan int { return p.exited }

// compgen 命令表的进程级缓存：成功缓存；失败置空并允许下次重试。
var (
	compgenMu    sync.Mutex
	compgenValue []string
	compgenDone  bool
)

// runCompgen 执行 compgen 探测（包级变量，测试注入用）。
var runCompgen = func(ctx context.Context) ([]string, error) {
	out, err := exec.CommandContext(ctx, "bash", "-c", "compgen -A command | sort -u").Output()
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, line := range strings.Split(string(out), "\n") {
		name := strings.TrimSpace(line)
		if name != "" {
			names = append(names, name)
		}
	}
	return names, nil
}

// listCommands compgen 命令表：成功进程级缓存、失败降级并允许重试（调用方吞错为空表）。
func listCommands(ctx context.Context) ([]string, error) {
	compgenMu.Lock()
	if compgenDone {
		v := compgenValue
		compgenMu.Unlock()
		return v, nil
	}
	compgenMu.Unlock()
	names, err := runCompgen(ctx)
	if err != nil {
		return nil, err
	}
	compgenMu.Lock()
	compgenValue, compgenDone = names, true
	compgenMu.Unlock()
	return names, nil
}

// resetCompgenCache 重置进程级缓存（仅测试用）。
func resetCompgenCache() {
	compgenMu.Lock()
	compgenValue, compgenDone = nil, false
	compgenMu.Unlock()
}

// listDir readdir 文件表：os.ReadDir 天然按文件名排序。
func listDir(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names, nil
}

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
