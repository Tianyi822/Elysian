package docker

import (
	"bytes"
	"context"
	"errors"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/seam"
)

// exec 抽象层（dockerExec.ts 逐字移植）：shell 探测/补全/清理脚本、PTY 包装
//（含无 stty 时的回显抑制）、惰性打开与取消。

// dockerShellProbeScript 容器 shell 探测脚本：只打印 bash 与 stty 是否可用。
const dockerShellProbeScript = "command -v bash >/dev/null 2>&1 && echo bash=yes || echo bash=no; stty size >/dev/null 2>&1 && echo stty=yes || echo stty=no"

// dockerShellProbeCommand 探测 exec 的命令数组（固定 argv）。
func dockerShellProbeCommand() []string {
	return []string{"/bin/sh", "-c", dockerShellProbeScript}
}

// dockerExecCleanupScript 断开清理脚本（pid 经 -- 传入，不写进脚本字符串）：
// 先快照 ppid==target 的子进程，再两轮 kill（HUP → sleep 1 → KILL）。
const dockerExecCleanupScript = `set -eu
target=$1
kids=""
for statf in /proc/[0-9]*/stat; do
  [ -f "$statf" ] || continue
  p=${statf#/proc/}; p=${p%/stat}
  ppid=$(awk '{print $4}' "$statf" 2>/dev/null) || continue
  if [ "$ppid" = "$target" ]; then
    kids="$kids $p"
  fi
done
for pass in 1 2; do
  for p in $kids $target; do
    if [ "$pass" = 1 ]; then
      kill -HUP "$p" 2>/dev/null || true
    else
      kill -KILL "$p" 2>/dev/null || true
    fi
  done
  [ "$pass" = 1 ] && sleep 1
done`

// shCommandsScript sh 的命令表脚本（逐个检查 PATH 目录中的可执行普通文件）。
const shCommandsScript = `old_ifs=$IFS; IFS=:; set -- $PATH; IFS=$old_ifs
for dir do
  [ -d "$dir" ] || continue
  for file in "$dir"/*; do
    [ -f "$file" ] && [ -x "$file" ] && printf '%s\n' "${file##*/}"
  done
done`

var pidPattern = regexp.MustCompile(`^[0-9]{1,10}$`)

// shellKind 探测结果。
type shellKind string

const (
	shellBash shellKind = "bash"
	shellSh   shellKind = "sh"
	shellNone shellKind = "none"
)

// completionLimits 补全查询的时限与上限（dockerExec.ts 同值）。
const (
	completionTimeout        = 1 * time.Second
	completionOutputMaxBytes = 256 * 1024
	echoLineMaxChars         = 64 * 1024
	dockerExecCleanupTimeout = 10 * time.Second
)

// probeShell 探测容器内 bash / sh / 无 shell。
func probeShell(runner execRunner) shellKind {
	session := runner.Run(dockerShellProbeCommand(), false, nil)
	text, err := readStdoutText(session)
	session.Close()
	if err != nil {
		return shellNone
	}
	if strings.Contains(text, "bash=yes") {
		return shellBash
	}
	if strings.Contains(text, "bash=no") {
		return shellSh
	}
	return shellNone
}

// completionLines 补全查询：TTY exec 读全部输出，超时或超量降级报错；
// 过滤空行与含控制字符的行，去重后截 maxItems。
func completionLines(runner execRunner, command []string, maxItems int) ([]string, error) {
	session := runner.Run(command, true, nil)
	timedOut := false
	timer := time.AfterFunc(completionTimeout, func() {
		timedOut = true
		session.Close()
	})
	defer timer.Stop()
	defer session.Close()

	var output []byte
	buf := make([]byte, 16*1024)
	var readErr error
	for {
		n, err := session.Read(buf)
		if n > 0 {
			output = append(output, buf[:n]...)
			if len(output) > completionOutputMaxBytes {
				return nil, errors.New("容器终端补全输出过大")
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			readErr = err
			break
		}
	}
	if timedOut {
		return nil, errors.New("容器终端补全超时")
	}
	if readErr != nil {
		return nil, readErr
	}

	seen := make(map[string]bool)
	lines := make([]string, 0, 16)
	for _, line := range regexpCRLF.Split(string(output), -1) {
		if line == "" || hasControlChars(line) {
			continue
		}
		if seen[line] {
			continue
		}
		seen[line] = true
		lines = append(lines, line)
		if len(lines) >= maxItems {
			break
		}
	}
	return lines, nil
}

var regexpCRLF = regexp.MustCompile(`\r?\n`)

// listDockerCommands 命令补全：bash 用 compgen，sh 逐目录遍历。
func listDockerCommands(runner execRunner, kind shellKind) ([]string, error) {
	var command []string
	if kind == shellBash {
		command = []string{"/bin/bash", "-c", "compgen -A command"}
	} else {
		command = []string{"/bin/sh", "-c", shCommandsScript}
	}
	return completionLines(runner, command, seam.TerminalCompletionCommandsMax)
}

// listDockerFiles 文件补全：/bin/ls -1A --color=never -- <cwd>；保留第 513 项
// 让会话层按既有口径判超限（files:null）。
func listDockerFiles(runner execRunner, cwd string) ([]string, error) {
	if !strings.HasPrefix(cwd, "/") || strings.ContainsAny(cwd, "\x00\r\n") {
		return nil, errors.New("容器终端工作目录无效")
	}
	return completionLines(runner, []string{"/bin/ls", "-1A", "--color=never", "--", cwd}, seam.TerminalCompletionFilesMax+1)
}

// shellSpec 容器终端的 shell 规格（env 为有序 K=V 列表）。
type shellSpec struct {
	env         []string
	startupLine string
}

// shellSpecFor 按探测结果构造规格：printf 用 POSIX 八进制转义产出 READY 哨兵的
// 真实控制字节；sh 的 PS1 直接携带原始控制字节经 exec env 传入。
func shellSpecFor(kind shellKind, stty bool) shellSpec {
	sttyPrefix := ""
	if stty {
		sttyPrefix = "stty cols " + itoa(terminalCols) + " rows " + itoa(terminalRows) + " -echo; "
	}
	if kind == shellBash {
		return shellSpec{
			env: []string{
				"PS1=",
				`PROMPT_COMMAND=printf "\x01PWD:%s\x02\n" "$PWD"`,
			},
			startupLine: sttyPrefix + `set +H; printf '\001READY:%s\002\n' $$` + "\n",
		}
	}
	return shellSpec{
		env: []string{
			"PS1=\x01PWD:$PWD\x02\n",
		},
		startupLine: sttyPrefix + `printf '\001READY:%s\002\n' $$` + "\n",
	}
}

// cleanupScriptPid 构造清理 exec 命令数组；pid 仅作位置参数。
func cleanupScriptPid(pid string) ([]string, error) {
	if !pidPattern.MatchString(pid) {
		return nil, errors.New("清理脚本的 pid 必须是 1 到 10 位数字")
	}
	return []string{"/bin/sh", "-c", dockerExecCleanupScript, "--", pid}, nil
}

// shellCommandFor 交互 exec 的启动命令。
func shellCommandFor(spec shellSpec) []string {
	if strings.Contains(spec.startupLine, "set +H") {
		return []string{"/bin/bash", "--noediting"}
	}
	return []string{"/bin/sh"}
}

// shouldDropEchoLines 无 stty 规格（sh 分支）时启用回显抑制。
func shouldDropEchoLines(spec shellSpec) bool {
	return !strings.Contains(spec.startupLine, "stty")
}

// execPty 把 exec 劫持连接包装成与会话层一致的 seam.PtyProcess。
type execPty struct {
	session  *execSession
	spec     shellSpec
	dropEcho bool

	mu              sync.Mutex
	pendingEchoLine string
	hasPendingEcho  bool

	stdoutOnce  sync.Once
	stdoutRead  io.Reader
	stdoutWrite *io.PipeWriter

	exitOnce sync.Once
	exited   chan int
}

// createExecPty 建交互 exec 并发送启动行。
func createExecPty(runner execRunner, spec shellSpec) seam.PtyProcess {
	session := runner.Run(shellCommandFor(spec), true, spec.env)
	pty := &execPty{
		session:  session,
		spec:     spec,
		dropEcho: shouldDropEchoLines(spec),
		exited:   make(chan int, 1),
	}
	session.Write(spec.startupLine)
	return pty
}

// Write 写 stdin；dropEcho 时武装「与输入全等的第一行回显」待删标记。
func (p *execPty) Write(text []byte) (int, error) {
	if p.dropEcho && len(text) > 0 && text[len(text)-1] == '\n' && string(text) != p.spec.startupLine {
		p.mu.Lock()
		p.pendingEchoLine = string(text[:len(text)-1])
		p.hasPendingEcho = true
		p.mu.Unlock()
	}
	p.session.Write(string(text))
	return len(text), nil
}

// Stdout 输出读端：dropEcho 时经回显过滤器，流结束结算退出码。
func (p *execPty) Stdout() io.Reader {
	p.stdoutOnce.Do(func() {
		reader, writer := io.Pipe()
		p.stdoutRead = reader
		p.stdoutWrite = writer
		go func() {
			var err error
			if p.dropEcho {
				err = p.pumpEchoFiltered(writer)
			} else {
				_, err = io.Copy(writer, echoDiscardReader{session: p.session})
			}
			code := 0
			if err == nil {
				code = p.session.ExitCode()
			} else {
				code = 1
			}
			p.setExit(code)
			_ = writer.CloseWithError(err)
		}()
	})
	return p.stdoutRead
}

// echoDiscardReader 把 session 适配成纯 io.Reader（无过滤路径）。
type echoDiscardReader struct{ session *execSession }

func (e echoDiscardReader) Read(buf []byte) (int, error) { return e.session.Read(buf) }

// pumpEchoFiltered 回显过滤输出泵：与用户输入全等的第一行回显被丢弃；
// 无换行输出超过 64 KiB 时整块透传不再等换行。
func (p *execPty) pumpEchoFiltered(dst io.Writer) error {
	var pending []byte
	buf := make([]byte, 32*1024)
	for {
		n, err := p.session.Read(buf)
		if n > 0 {
			pending = append(pending, buf[:n]...)
			for {
				newline := bytes.IndexByte(pending, '\n')
				if newline == -1 {
					break
				}
				line := pending[:newline]
				pending = pending[newline+1:]
				if p.consumeEchoLine(string(line)) {
					continue
				}
				if _, werr := dst.Write(append(line, '\n')); werr != nil {
					return werr
				}
			}
			if len(pending) > echoLineMaxChars {
				if _, werr := dst.Write(pending); werr != nil {
					return werr
				}
				pending = nil
			}
		}
		if err == io.EOF {
			if len(pending) > 0 {
				if !p.consumeEchoLine(string(pending)) {
					if _, werr := dst.Write(pending); werr != nil {
						return werr
					}
				}
			}
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// consumeEchoLine 行与待删回显全等时清标记并返回 true（该行被丢弃）。
func (p *execPty) consumeEchoLine(line string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.hasPendingEcho && p.pendingEchoLine == line {
		p.hasPendingEcho = false
		p.pendingEchoLine = ""
		return true
	}
	return false
}

// Kill 断开劫持连接（退出码按 0 结算）。
func (p *execPty) Kill() error {
	p.session.Close()
	p.setExit(0)
	return nil
}

// Exited 退出码；流结束后经 inspect 补查再发。
func (p *execPty) Exited() <-chan int {
	return p.exited
}

func (p *execPty) setExit(code int) {
	p.exitOnce.Do(func() {
		p.exited <- code
	})
}

// seamPtyProcess 域内对 seam.PtyProcess 的引用别名。
type seamPtyProcess = seam.PtyProcess

// lazyExecPty 异步打开 PTY 后再暴露 write/stdout（打开途中取消时迟到 PTY 由
// open 侧的取消检查杀掉）。
type lazyExecPty struct {
	open func(ctx context.Context) (seamPtyProcess, error)

	mu          sync.Mutex
	inner       seamPtyProcess
	openErr     error
	openDone    bool
	pending     [][]byte
	stdoutWrite *io.PipeWriter
	copyStarted bool
	stdoutOnce  sync.Once
	stdoutRead  io.Reader

	ctx     context.Context
	cancel  context.CancelFunc
	exited  chan int
	exitOne sync.Once
}

// createLazyExecPty 包装 open 为可惰性打开的 PtyProcess。
func createLazyExecPty(open func(ctx context.Context) (seamPtyProcess, error)) seamPtyProcess {
	ctx, cancel := context.WithCancel(context.Background())
	return &lazyExecPty{open: open, ctx: ctx, cancel: cancel, exited: make(chan int, 1)}
}

// ensure 启动（一次）打开流程：成功后补写缓冲并接续输出。
func (l *lazyExecPty) ensure() {
	l.mu.Lock()
	if l.openDone {
		l.mu.Unlock()
		return
	}
	l.openDone = true
	l.mu.Unlock()

	go func() {
		inner, err := l.open(l.ctx)
		l.mu.Lock()
		if err != nil {
			l.openErr = err
			writer := l.stdoutWrite
			l.mu.Unlock()
			// 打开失败按 1 结算；用户取消（Kill）按 0——谁先到谁生效。
			code := 1
			if l.ctx.Err() != nil {
				code = 0
			}
			l.exitOne.Do(func() { l.exited <- code })
			if writer != nil {
				_ = writer.CloseWithError(err)
			}
			return
		}
		l.inner = inner
		pending := l.pending
		l.pending = nil
		l.startCopyLocked()
		l.mu.Unlock()
		for _, text := range pending {
			_, _ = inner.Write(text)
		}
	}()
}

// startCopyLocked 输出接续（writer 与 inner 都就绪后启动一次；调用方持锁）。
func (l *lazyExecPty) startCopyLocked() {
	if l.copyStarted || l.stdoutWrite == nil || l.inner == nil {
		return
	}
	l.copyStarted = true
	writer := l.stdoutWrite
	inner := l.inner
	go func() {
		_, err := io.Copy(writer, inner.Stdout())
		code := 0
		if err != nil {
			code = 1
		} else {
			if exited, ok := <-inner.Exited(); ok {
				code = exited
			}
		}
		l.exitOne.Do(func() { l.exited <- code })
		_ = writer.CloseWithError(err)
	}()
}

// Write 写 stdin；未打开完成前缓冲，打开失败丢弃。
func (l *lazyExecPty) Write(text []byte) (int, error) {
	l.ensure()
	l.mu.Lock()
	inner := l.inner
	if inner == nil {
		if l.openErr == nil {
			chunk := make([]byte, len(text))
			copy(chunk, text)
			l.pending = append(l.pending, chunk)
		}
		l.mu.Unlock()
		return len(text), nil
	}
	l.mu.Unlock()
	_, _ = inner.Write(text)
	return len(text), nil
}

// Stdout 对外输出读端；首次调用触发打开与接续。
func (l *lazyExecPty) Stdout() io.Reader {
	l.stdoutOnce.Do(func() {
		reader, writer := io.Pipe()
		l.stdoutRead = reader
		l.mu.Lock()
		l.stdoutWrite = writer
		l.startCopyLocked()
		l.mu.Unlock()
		l.ensure()
	})
	return l.stdoutRead
}

// Kill 取消打开；已打开则杀内部 PTY 并继承其退出码，未开始打开按 0 结算。
func (l *lazyExecPty) Kill() error {
	l.cancel()
	l.mu.Lock()
	inner := l.inner
	openDone := l.openDone
	l.mu.Unlock()
	if inner == nil {
		if !openDone {
			l.exitOne.Do(func() { l.exited <- 0 })
		}
		return nil
	}
	err := inner.Kill()
	if code, ok := <-inner.Exited(); ok {
		l.exitOne.Do(func() { l.exited <- code })
	}
	return err
}

// Exited 退出码通道。
func (l *lazyExecPty) Exited() <-chan int {
	return l.exited
}
