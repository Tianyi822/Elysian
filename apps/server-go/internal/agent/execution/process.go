package execution

import (
	"bufio"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/mcp"
)

type Process struct {
	executor        *Executor
	ctx             context.Context
	cancel          context.CancelFunc
	containerID, id string
	volume          string
	serverID        string
	serverRevision  int
	conn            net.Conn
	reader          *bufio.Reader
	grant           *config.Grant
	writeMu         sync.Mutex
	mu              sync.Mutex
	stdoutR         *io.PipeReader
	stdoutW         *io.PipeWriter
	stderrR         *io.PipeReader
	stderrW         *io.PipeWriter
	output          io.Writer
	outputBytes     int64
	streamBytes     int64
	proxyBytes      int64
	proxyCount      int
	proxies         map[string]net.Conn
	finished        bool
	exitCode        int
	err             error
	done            chan struct{}
	closeOnce       sync.Once
	closeErr        error
}

func newProcess(e *Executor, ctx context.Context, cancel context.CancelFunc, containerID, id string, conn net.Conn, reader *bufio.Reader, grant *config.Grant, output io.Writer) *Process {
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	return &Process{executor: e, ctx: ctx, cancel: cancel, containerID: containerID, id: id, conn: conn, reader: reader, grant: grant, stdoutR: outR, stdoutW: outW, stderrR: errR, stderrW: errW, output: output, proxies: make(map[string]net.Conn), done: make(chan struct{})}
}
func (p *Process) Identity() string      { return p.containerID }
func (p *Process) Stdin() io.WriteCloser { return &processInput{p: p} }
func (p *Process) Stdout() io.ReadCloser { return p.stdoutR }
func (p *Process) Stderr() io.ReadCloser { return p.stderrR }

type processInput struct{ p *Process }

func (w *processInput) Write(b []byte) (int, error) {
	total := 0
	for len(b) > 0 {
		n := len(b)
		if n > 32<<10 {
			n = 32 << 10
		}
		if err := w.p.send(frame{Kind: "stdin", Data: b[:n]}); err != nil {
			return total, err
		}
		b = b[n:]
		total += n
	}
	return total, nil
}
func (w *processInput) Close() error { return w.p.send(frame{Kind: "stdin-close"}) }
func (p *Process) send(f frame) error {
	if p.ctx.Err() != nil {
		return problem(499, "execution-cancelled", "执行已取消或超过时限")
	}
	b, err := json.Marshal(f)
	if err != nil || len(b) > MaxFrameBytes {
		return protocolError()
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_ = p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_, err = p.conn.Write(append(b, '\n'))
	if err != nil {
		return protocolError()
	}
	return nil
}

func (p *Process) read() {
	defer close(p.done)
	defer func() {
		p.mu.Lock()
		err := p.err
		for _, conn := range p.proxies {
			if conn != nil {
				conn.Close()
			}
		}
		p.mu.Unlock()
		_ = p.stdoutW.CloseWithError(err)
		_ = p.stderrW.CloseWithError(err)
	}()
	pipeR, pipeW := io.Pipe()
	defer pipeR.Close()
	go func() { err := demultiplex(p.reader, pipeW); _ = pipeW.CloseWithError(err) }()
	scanner := bufio.NewScanner(pipeR)
	scanner.Buffer(make([]byte, 4096), MaxFrameBytes+1)
	for scanner.Scan() {
		var f frame
		decoder := json.NewDecoder(strings.NewReader(scanner.Text()))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&f) != nil {
			p.fail(protocolError())
			return
		}
		var trailing any
		if !errors.Is(decoder.Decode(&trailing), io.EOF) {
			p.fail(protocolError())
			return
		}
		switch f.Kind {
		case "stdout", "stderr":
			p.streamBytes += int64(len(f.Data))
			if p.streamBytes > MaxOutputBytes {
				p.fail(problem(413, "execution-output-limit", "执行输出超过累计上限"))
				return
			}
			writer := p.stdoutW
			if f.Kind == "stderr" {
				writer = p.stderrW
			}
			if _, err := writer.Write(f.Data); err != nil {
				p.fail(err)
				return
			}
		case "workspace":
			p.outputBytes += int64(len(f.Data))
			if p.output == nil || p.outputBytes > MaxWorkspaceBytes+(MaxWorkspaceFiles+2)*1024 {
				p.fail(problem(413, "execution-workspace-limit", "执行工作区归档超过上限"))
				return
			}
			if _, err := p.output.Write(f.Data); err != nil {
				p.fail(problem(503, "execution-workspace-write", "执行工作区复制失败"))
				return
			}
		case "proxy-open":
			go p.openProxy(f)
		case "proxy-data":
			if err := p.proxyData(f); err != nil {
				p.fail(err)
				return
			}
		case "proxy-close":
			p.closeProxy(f.ID)
		case "exit":
			p.mu.Lock()
			p.finished = true
			p.exitCode = f.ExitCode
			p.mu.Unlock()
			return
		case "error":
			p.fail(protocolError())
			return
		default:
			p.fail(protocolError())
			return
		}
	}
	p.fail(protocolError())
}
func (p *Process) fail(err error) {
	p.mu.Lock()
	if p.err == nil {
		p.err = err
	}
	p.mu.Unlock()
	p.cancel()
	_ = p.conn.Close()
}
func demultiplex(reader io.Reader, out io.Writer) error {
	var header [8]byte
	var diagnostics int64
	for {
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return err
		}
		size := binary.BigEndian.Uint32(header[4:])
		if header[1] != 0 || header[2] != 0 || header[3] != 0 || size > MaxFrameBytes*2 {
			return protocolError()
		}
		if header[0] == 1 {
			if _, err := io.CopyN(out, reader, int64(size)); err != nil {
				return err
			}
		} else if header[0] == 2 {
			diagnostics += int64(size)
			if diagnostics > 4096 {
				return protocolError()
			}
			if _, err := io.CopyN(io.Discard, reader, int64(size)); err != nil {
				return err
			}
		} else {
			return protocolError()
		}
	}
}

func (p *Process) Wait(ctx context.Context) (int, int64, error) {
	select {
	case <-p.done:
	case <-ctx.Done():
		return 0, 0, problem(499, "execution-cancelled", "执行已取消或超过时限")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if errors.Is(p.ctx.Err(), context.DeadlineExceeded) && !p.finished {
		return 0, p.outputBytes, &Error{Status: 504, Code: "execution-timeout", Message: "执行容器超过时间限制", OutcomeUnknown: true}
	}
	if p.err != nil {
		return 0, p.outputBytes, p.err
	}
	if !p.finished {
		return 0, p.outputBytes, protocolError()
	}
	return p.exitCode, p.outputBytes, nil
}
func (p *Process) Close(ctx context.Context) error {
	p.closeOnce.Do(func() {
		p.cancel()
		_ = p.conn.Close()
		_ = p.stdoutR.Close()
		_ = p.stderrR.Close()
		_ = p.stdoutW.Close()
		_ = p.stderrW.Close()
		p.mu.Lock()
		for _, c := range p.proxies {
			if c != nil {
				c.Close()
			}
		}
		p.mu.Unlock()
		stopCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		p.closeErr = p.executor.remove(stopCtx, p.containerID, p.id)
		if p.closeErr == nil && p.volume != "" {
			p.closeErr = p.executor.removeVolume(stopCtx, p.volume, p.id)
		}
		if p.closeErr == nil {
			p.executor.mu.Lock()
			delete(p.executor.active, p.containerID)
			p.executor.mu.Unlock()
		}
	})
	return p.closeErr
}

func (e *Executor) RunScript(ctx context.Context, request ScriptRequest) (ScriptResult, error) {
	var result ScriptResult
	if !relativePath(request.ScriptPath) || !strings.HasPrefix(request.ScriptPath, "scripts/") || request.SkillArchive == nil || request.WorkspaceOutput == nil {
		return result, problem(400, "execution-script", "技能脚本必须来自 scripts 目录并提供工作区输出接收器")
	}
	var command []string
	switch request.Profile.Runtime {
	case "python":
		command = []string{"python3"}
	case "node":
		command = []string{"node"}
	case "bash":
		command = []string{"bash"}
	default:
		return result, problem(400, "execution-runtime", "技能脚本运行时仅支持 Python、Node 或 Bash")
	}
	if len(request.Profile.Command) > 0 {
		command = append([]string(nil), request.Profile.Command...)
	}
	command = append(command, "/bundle/skill/"+request.ScriptPath)
	command = append(command, request.Args...)
	p, err := e.start(ctx, request.ID, request.Profile, request.Grant, frame{Kind: "start", Mode: "script", Command: command}, request.SkillArchive, request.WorkspaceArchive, request.WorkspaceOutput)
	if err != nil {
		return result, err
	}
	result.ContainerID = p.Identity()
	outDone := make(chan error, 1)
	errDone := make(chan error, 1)
	var out, diagnostics strings.Builder
	go func() { _, err := io.Copy(&out, p.Stdout()); outDone <- err }()
	go func() { _, err := io.Copy(&diagnostics, p.Stderr()); errDone <- err }()
	result.ExitCode, result.WorkspaceBytes, err = p.Wait(ctx)
	stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	stopErr := p.Close(stopCtx)
	cancel()
	<-outDone
	<-errDone
	result.Stdout = out.String()
	result.Stderr = diagnostics.String()
	if stopErr != nil {
		return result, stopErr
	}
	if err != nil {
		var known *Error
		if errors.As(err, &known) {
			copy := *known
			copy.OutcomeUnknown = true
			return result, &copy
		}
		return result, &Error{Status: 502, Code: "execution-outcome-unknown", Message: "执行已派发但未获得完整结果", OutcomeUnknown: true}
	}
	return result, nil
}

var _ mcp.Duplex = (*Process)(nil)
