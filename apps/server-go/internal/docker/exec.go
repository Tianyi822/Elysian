package docker

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/seam"
)

// Docker 提供 PTY，交互编辑、回显、历史与提示符均由容器内原生 shell 处理。
const dockerShellProbeScript = "if [ -x /bin/bash ]; then echo bash=yes; elif [ -x /bin/sh ]; then echo bash=no; fi"

func dockerShellProbeCommand() []string { return []string{"/bin/sh", "-c", dockerShellProbeScript} }

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

var pidPattern = regexp.MustCompile(`^[0-9]{1,10}$`)

type shellKind string

const (
	shellBash                shellKind = "bash"
	shellSh                  shellKind = "sh"
	shellNone                shellKind = "none"
	dockerExecCleanupTimeout           = 10 * time.Second
)

func probeShell(runner execRunner) shellKind {
	session := runner.Run(dockerShellProbeCommand(), false, nil)
	timer := time.AfterFunc(dockerExecCleanupTimeout, session.Close)
	defer timer.Stop()
	defer session.Close()
	text, err := readStdoutText(io.LimitReader(session, 4096))
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

type shellSpec struct {
	kind shellKind
	env  []string
}

func shellSpecFor(kind shellKind) shellSpec {
	return shellSpec{kind: kind, env: []string{"TERM=xterm-256color", "LANG=C.UTF-8", "COLORTERM=truecolor", "HISTFILE=/dev/null"}}
}

// 固定 launcher 只输出一次带 nonce 的 PID 元数据，随后 exec 原生 shell，PID 不变。
// nonce 与 shell 路径均通过位置参数传递，不拼接到脚本中。
const dockerExecLauncher = `printf '\001ELYSIAN:%s:%s\002' "$1" "$$"; exec "$2" -i`

func shellCommandFor(spec shellSpec, nonce string) []string {
	shell := "/bin/sh"
	if spec.kind == shellBash {
		shell = "/bin/bash"
	}
	return []string{"/bin/sh", "-c", dockerExecLauncher, "--", nonce, shell}
}

func cleanupScriptPid(pid string) ([]string, error) {
	if !pidPattern.MatchString(pid) {
		return nil, errors.New("清理脚本的 pid 必须是 1 到 10 位数字")
	}
	return []string{"/bin/sh", "-c", dockerExecCleanupScript, "--", pid}, nil
}

type execPty struct {
	session     *execSession
	runner      execRunner
	stdout      *io.PipeReader
	writer      *io.PipeWriter
	startupDone chan struct{}
	mu          sync.Mutex
	pid         string
	startupErr  error
	finished    bool
	killed      bool
	killOnce    sync.Once
	exitOnce    sync.Once
	exited      chan int
}

func createExecPty(runner execRunner, spec shellSpec) (seam.PtyProcess, error) {
	var token [16]byte
	if _, err := rand.Read(token[:]); err != nil {
		return nil, err
	}
	nonce := hex.EncodeToString(token[:])
	session := runner.Run(shellCommandFor(spec, nonce), true, spec.env)
	reader, writer := io.Pipe()
	p := &execPty{session: session, runner: runner, stdout: reader, writer: writer, startupDone: make(chan struct{}), exited: make(chan int, 1)}
	go p.pump(nonce)
	return p, nil
}

func (p *execPty) pump(nonce string) {
	source := bufio.NewReaderSize(p.session, 128)
	timer := time.AfterFunc(dockerExecCleanupTimeout, p.session.Close)
	header, err := source.ReadSlice('\x02')
	timer.Stop()
	prefix := "\x01ELYSIAN:" + nonce + ":"
	pid := ""
	if err == nil {
		text := string(header)
		if strings.HasPrefix(text, prefix) && strings.HasSuffix(text, "\x02") {
			pid = strings.TrimSuffix(strings.TrimPrefix(text, prefix), "\x02")
		}
		if !pidPattern.MatchString(pid) || pid == "0" {
			err = errors.New("容器终端启动握手无效")
		}
	}
	p.mu.Lock()
	p.pid, p.startupErr = pid, err
	p.mu.Unlock()
	close(p.startupDone)
	if err == nil {
		_, err = io.Copy(p.writer, source)
	}
	code, finished := 1, false
	if err == nil {
		code, finished = p.session.exitStatus()
	}
	p.mu.Lock()
	p.finished = finished
	p.mu.Unlock()
	p.setExit(code)
	_ = p.writer.CloseWithError(err)
	p.session.Close()
}

// WaitReady 只有 nonce/PID 元数据已确认时才允许向浏览器报告连接成功。
func (p *execPty) WaitReady(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-p.startupDone:
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.killed {
		return io.ErrClosedPipe
	}
	return p.startupErr
}

func (p *execPty) Write(data []byte) (int, error) {
	<-p.startupDone
	p.mu.Lock()
	err, killed := p.startupErr, p.killed
	p.mu.Unlock()
	if err != nil {
		return 0, err
	}
	if killed {
		return 0, io.ErrClosedPipe
	}
	return p.session.Write(string(data))
}
func (p *execPty) Resize(cols, rows int) error { return p.session.Resize(cols, rows) }
func (p *execPty) Stdout() io.Reader           { return p.stdout }

// 关闭 hijack 不等于杀 exec。先消费内部 PID 握手，再完成有界清理，避免遗留 shell。
func (p *execPty) Kill() error {
	p.killOnce.Do(func() {
		p.mu.Lock()
		p.killed = true
		p.mu.Unlock()
		<-p.startupDone
		p.mu.Lock()
		pid, finished := p.pid, p.finished
		p.mu.Unlock()
		p.session.Close()
		_ = p.writer.CloseWithError(io.ErrClosedPipe)
		if pid != "" && !finished {
			command, err := cleanupScriptPid(pid)
			if err == nil {
				cleanup := p.runner.Run(command, false, nil)
				timer := time.AfterFunc(dockerExecCleanupTimeout, cleanup.Close)
				_, _ = io.Copy(io.Discard, cleanup)
				timer.Stop()
				cleanup.Close()
			}
		}
		p.setExit(0)
	})
	return nil
}
func (p *execPty) Exited() <-chan int { return p.exited }
func (p *execPty) setExit(code int)   { p.exitOnce.Do(func() { p.exited <- code }) }

type seamPtyProcess = seam.PtyProcess

// 惰性打开期间只保留最后尺寸；输入等待打开完成，绝不积累无界按键队列。
type lazyExecPty struct {
	open       func(context.Context) (seamPtyProcess, error)
	openOnce   sync.Once
	done       chan struct{}
	mu         sync.Mutex
	inner      seamPtyProcess
	openErr    error
	cols, rows int
	ctx        context.Context
	cancel     context.CancelFunc
	exitOnce   sync.Once
	exited     chan int
}

func createLazyExecPty(open func(context.Context) (seamPtyProcess, error)) seamPtyProcess {
	ctx, cancel := context.WithCancel(context.Background())
	return &lazyExecPty{open: open, done: make(chan struct{}), ctx: ctx, cancel: cancel, exited: make(chan int, 1)}
}
func (l *lazyExecPty) ensure() {
	l.openOnce.Do(func() {
		go func() {
			if l.ctx.Err() != nil {
				l.mu.Lock()
				l.openErr = errTerminalCancelled
				l.mu.Unlock()
				close(l.done)
				l.exitOnce.Do(func() { l.exited <- 0 })
				return
			}
			inner, err := l.open(l.ctx)
			l.mu.Lock()
			if err == nil && l.ctx.Err() != nil {
				err = errTerminalCancelled
			}
			if err == nil && l.cols > 0 && l.rows > 0 {
				err = inner.Resize(l.cols, l.rows)
			}
			if err == nil {
				l.inner = inner
			}
			l.openErr = err
			l.mu.Unlock()
			close(l.done)
			if err != nil {
				if inner != nil {
					_ = inner.Kill()
				}
				code := 1
				if l.ctx.Err() != nil {
					code = 0
				}
				l.exitOnce.Do(func() { l.exited <- code })
				return
			}
			go func() {
				if code, ok := <-inner.Exited(); ok {
					l.exitOnce.Do(func() { l.exited <- code })
				}
			}()
		}()
	})
}
func (l *lazyExecPty) opened() (seamPtyProcess, error) {
	l.ensure()
	select {
	case <-l.ctx.Done():
		return nil, io.ErrClosedPipe
	case <-l.done:
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.inner, l.openErr
}
func (l *lazyExecPty) WaitReady(ctx context.Context) error {
	l.ensure()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-l.ctx.Done():
		return io.ErrClosedPipe
	case <-l.done:
	}
	l.mu.Lock()
	inner, err := l.inner, l.openErr
	l.mu.Unlock()
	if err != nil {
		return err
	}
	if ready, ok := inner.(interface{ WaitReady(context.Context) error }); ok {
		return ready.WaitReady(ctx)
	}
	return nil
}

func (l *lazyExecPty) Write(data []byte) (int, error) {
	inner, err := l.opened()
	if err != nil {
		return 0, err
	}
	return inner.Write(data)
}
func (l *lazyExecPty) Resize(cols, rows int) error {
	if cols < 1 || cols > 1000 || rows < 1 || rows > 1000 {
		return errors.New("终端窗口尺寸无效")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.cols, l.rows = cols, rows
	if l.inner != nil {
		return l.inner.Resize(cols, rows)
	}
	return nil
}

type lazyExecReader struct{ p *lazyExecPty }

func (r lazyExecReader) Read(b []byte) (int, error) {
	inner, err := r.p.opened()
	if err != nil {
		return 0, err
	}
	return inner.Stdout().Read(b)
}
func (l *lazyExecPty) Stdout() io.Reader { l.ensure(); return lazyExecReader{l} }
func (l *lazyExecPty) Kill() error {
	l.cancel()
	l.mu.Lock()
	inner := l.inner
	l.mu.Unlock()
	var err error
	if inner != nil {
		err = inner.Kill()
	}
	l.exitOnce.Do(func() { l.exited <- 0 })
	return err
}
func (l *lazyExecPty) Exited() <-chan int { return l.exited }
