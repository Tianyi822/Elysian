package worker

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type incoming struct {
	frame frame
	err   error
}

type outgoing struct {
	data []byte
	done chan error
}

type process struct {
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	stdout     io.ReadCloser
	generation string
	frames     chan incoming
	writes     chan outgoing
	exited     chan struct{}
	abort      chan struct{}
	closed     chan struct{}
	lifetime   context.Context
	cancel     context.CancelFunc
	stderr     boundedLog
	mu         sync.Mutex
	active     bool
	closing    bool
	sequence   uint64
	waitErr    error
	closeOnce  sync.Once
	killOnce   sync.Once
}

// boundedLog 持续消耗 stderr，只保留前 4 KiB，避免管道阻塞和无限内存增长。
type boundedLog struct {
	mu   sync.Mutex
	data []byte
}

func (b *boundedLog) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	n := len(data)
	if available := 4096 - len(b.data); available > 0 {
		if len(data) > available {
			data = data[:available]
		}
		b.data = append(b.data, data...)
	}
	return n, nil
}

// Spawn 启动独立工作进程，完成有版本与激活代绑定的握手后返回。
// ctx 只约束启动；已启动进程的所有权交给调用者，通过 Close 释放。
func Spawn(ctx context.Context, opts Options) (Process, error) {
	if ctx == nil {
		return nil, errors.New("启动任务工作进程必须提供上下文")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if opts.Path == "" {
		path, err := os.Executable()
		if err != nil {
			return nil, fmt.Errorf("定位工作进程二进制失败：%w", err)
		}
		opts.Path, opts.Args = path, []string{"__agent-worker"}
	}
	if opts.HandshakeTimeout <= 0 {
		opts.HandshakeTimeout = 5 * time.Second
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, fmt.Errorf("生成工作进程激活代失败：%w", err)
	}
	lifetime, cancel := context.WithCancel(context.Background())
	p := &process{
		generation: hex.EncodeToString(nonce[:]), frames: make(chan incoming, 8), writes: make(chan outgoing, 4),
		exited: make(chan struct{}), abort: make(chan struct{}), closed: make(chan struct{}), lifetime: lifetime, cancel: cancel,
	}
	p.cmd = exec.Command(opts.Path, opts.Args...)
	p.cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	p.cmd.Env = append([]string(nil), opts.Env...)
	if opts.Env == nil {
		p.cmd.Env = []string{"PATH=/usr/local/bin:/usr/bin:/bin", "LANG=C.UTF-8", "HOME=/tmp"}
	}
	p.cmd.Stderr = &p.stderr
	stdin, err := p.cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, fmt.Errorf("创建工作进程输入管道失败：%w", err)
	}
	// 自管 stdout 管道，避免 Cmd.Wait 在读取最后一条完成帧前关闭读端。
	stdout, childOut, err := os.Pipe()
	if err != nil {
		stdin.Close()
		cancel()
		return nil, fmt.Errorf("创建工作进程输出管道失败：%w", err)
	}
	p.stdin, p.stdout, p.cmd.Stdout = stdin, stdout, childOut
	if err := p.cmd.Start(); err != nil {
		stdin.Close()
		stdout.Close()
		childOut.Close()
		cancel()
		return nil, fmt.Errorf("启动任务工作进程失败：%w", err)
	}
	childOut.Close()
	go p.readLoop()
	go p.writeLoop()
	go func() {
		err := p.cmd.Wait()
		p.mu.Lock()
		p.waitErr = err
		p.mu.Unlock()
		close(p.exited)
	}()
	handshake, stop := context.WithTimeout(ctx, opts.HandshakeTimeout)
	defer stop()
	if err := p.send(handshake, p.control("hello")); err != nil {
		p.terminate()
		return nil, &InterruptedError{Err: fmt.Errorf("工作进程握手失败：%w", err)}
	}
	select {
	case got := <-p.frames:
		if got.err != nil {
			err = got.err
		} else if got.frame.Type != "ready" || !got.frame.controlOnly() {
			err = errors.New("工作进程未返回合法就绪消息")
		} else {
			err = got.frame.basic(p.generation)
		}
	case <-handshake.Done():
		err = handshake.Err()
	}
	if err != nil {
		p.terminate()
		return nil, &InterruptedError{Err: fmt.Errorf("工作进程握手失败：%w", err)}
	}
	return p, nil
}

func (p *process) control(kind string) frame {
	return frame{Version: protocolVersion, Generation: p.generation, Type: kind}
}

// Done 在子进程退出且 Wait 已回收后关闭，供宿主监督空闲进程；不增加 Process 假件要求。
func (p *process) Done() <-chan struct{} { return p.exited }

func (p *process) readLoop() {
	defer p.stdout.Close()
	defer close(p.frames)
	reader := bufio.NewReader(p.stdout)
	for {
		f, err := readFrame(reader)
		select {
		case p.frames <- incoming{frame: f, err: err}:
		case <-p.abort:
			return
		}
		if err != nil {
			return
		}
	}
}

func (p *process) writeLoop() {
	for {
		select {
		case request := <-p.writes:
			n, err := p.stdin.Write(request.data)
			if err == nil && n != len(request.data) {
				err = io.ErrShortWrite
			}
			request.done <- err
		case <-p.exited:
			return
		case <-p.abort:
			return
		}
	}
}

func (p *process) send(ctx context.Context, f frame) error {
	data, err := encodeFrame(f)
	if err != nil {
		return err
	}
	request := outgoing{data: data, done: make(chan error, 1)}
	select {
	case p.writes <- request:
	case <-ctx.Done():
		return ctx.Err()
	case <-p.exited:
		return errors.New("工作进程已退出")
	case <-p.abort:
		return errors.New("工作进程已终止")
	}
	select {
	case err := <-request.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-p.exited:
		return errors.New("工作进程已退出")
	case <-p.abort:
		return errors.New("工作进程已终止")
	}
}

// terminate 总是回收子进程；真正的域工具在父进程中，不能通过击杀它撤销域操作。
func (p *process) terminate() {
	p.killOnce.Do(func() {
		p.cancel()
		close(p.abort)
		p.stdin.Close()
		select {
		case <-p.exited:
		default:
			_ = syscall.Kill(-p.cmd.Process.Pid, syscall.SIGKILL)
		}
		p.stdout.Close()
	})
	<-p.exited
}

func (p *process) interrupt(err error) error {
	p.terminate()
	return &InterruptedError{Err: err}
}

// Close 停止接收新运行并关闭进程。ctx 只取消本次等待，后台收尾继续进行。
func (p *process) Close(ctx context.Context) error {
	if ctx == nil {
		return errors.New("关闭任务工作进程必须提供上下文")
	}
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.closing = true
		p.mu.Unlock()
		p.cancel()
		go func() {
			defer close(p.closed)
			deadline, cancel := context.WithTimeout(context.Background(), cancelGrace)
			defer cancel()
			_ = p.send(deadline, p.control("shutdown"))
			p.stdin.Close()
			select {
			case <-p.exited:
			case <-deadline.Done():
			}
			p.terminate()
		}()
	})
	select {
	case <-p.closed:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

type invocation struct {
	value json.RawMessage
	err   error
}

func invokeTool(ctx context.Context, invoke Invoker, index int, step Step, done chan<- invocation) {
	result := invocation{}
	defer func() {
		if recovered := recover(); recovered != nil {
			result.err = errors.New("父进程工具调用发生异常")
		}
		done <- result
	}()
	result.value, result.err = invoke(ctx, index, step.Tool, append(json.RawMessage(nil), step.Args...))
}

// Run 串行驱动已确定的步骤，只有严格匹配父进程计划的调用才能触达 Invoker。
func (p *process) Run(ctx context.Context, runID string, steps []Step, invoke Invoker) error {
	if ctx == nil || invoke == nil || !identifier.MatchString(runID) {
		return errors.New("运行任务必须提供有效上下文、任务编号和工具调用器")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	plan, err := copySteps(steps)
	if err != nil {
		return err
	}
	p.mu.Lock()
	if p.closing || p.lifetime.Err() != nil {
		p.mu.Unlock()
		return &InterruptedError{Err: errors.New("工作进程已关闭")}
	}
	if p.active {
		p.mu.Unlock()
		return ErrBusy
	}
	p.sequence++
	requestID := "request-" + strconv.FormatUint(p.sequence, 10)
	p.active = true
	p.mu.Unlock()
	defer func() { p.mu.Lock(); p.active = false; p.mu.Unlock() }()
	runCtx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(p.lifetime, cancel)
	defer stop()
	defer cancel()
	start := p.control("run/start")
	start.RunID, start.RequestID, start.Steps = runID, requestID, plan
	start.Driver, start.DriverVersion = batchDriverName, batchDriverVersion
	if _, err := encodeFrame(start); err != nil {
		return err
	}
	if err := p.send(runCtx, start); err != nil {
		return p.interrupt(fmt.Errorf("提交任务失败：%w", err))
	}
	index, requested, pending, finished := 0, false, false, false
	var failure *ToolError
	var cancelErr error
	var grace <-chan time.Time
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	done := make(chan invocation, 1)
	cancelled := runCtx.Done()
	for {
		if finished && !pending {
			if cancelErr != nil {
				return cancelErr
			}
			if err := runCtx.Err(); err != nil {
				return err
			}
			if failure != nil {
				return failure
			}
			return nil
		}
		select {
		case <-cancelled:
			cancelErr = runCtx.Err()
			cancelled = nil
			timer = time.NewTimer(cancelGrace)
			grace = timer.C
			if !finished {
				f := p.control("run/cancel")
				f.RunID, f.RequestID = runID, requestID
				deadline, end := context.WithTimeout(context.Background(), cancelGrace)
				err := p.send(deadline, f)
				end()
				if err != nil {
					return p.interrupt(errors.Join(cancelErr, err))
				}
			}
		case <-grace:
			return p.interrupt(errors.Join(cancelErr, errors.New("取消后工作进程或工具未在 5 秒内收尾")))
		case result := <-done:
			pending = false
			if cancelErr != nil || runCtx.Err() != nil {
				continue
			}
			f := p.control("tool/result")
			stepIndex := index
			f.RunID, f.RequestID, f.Index, f.Tool = runID, requestID, &stepIndex, plan[index].Tool
			if result.err == nil {
				if len(result.value) == 0 {
					result.value = json.RawMessage(`null`)
				}
				if !json.Valid(result.value) {
					result.err = errors.New("工具结果不是有效 JSON")
				} else {
					f.Value = result.value
					if _, err := encodeFrame(f); err != nil {
						result.err = err
					}
				}
			}
			if result.err != nil {
				failure = &ToolError{Index: index, Tool: plan[index].Tool, Err: result.err}
				f.Value, f.Error = nil, "父进程工具调用失败"
			}
			if err := p.send(runCtx, f); err != nil {
				return p.interrupt(fmt.Errorf("提交工具结果失败：%w", err))
			}
			if failure == nil {
				index++
				requested = false
			}
		case got, ok := <-p.frames:
			if !ok || got.err != nil {
				if got.err == nil {
					got.err = io.EOF
				}
				return p.interrupt(errors.Join(cancelErr, fmt.Errorf("读取工作进程消息失败：%w", got.err)))
			}
			f := got.frame
			if err := f.basic(p.generation); err != nil {
				return p.interrupt(err)
			}
			if f.RunID != runID || f.RequestID != requestID || finished {
				return p.interrupt(errors.New("工作进程消息不属于当前运行"))
			}
			switch f.Type {
			case "tool/call":
				if requested || failure != nil || index >= len(plan) || f.Index == nil || *f.Index != index || f.Tool != plan[index].Tool || !bytes.Equal(f.Args, plan[index].Args) || len(f.Steps) != 0 || len(f.Value) != 0 || f.Error != "" || f.Status != "" || f.Driver != "" || f.DriverVersion != 0 || !f.noAgentFields() {
					return p.interrupt(errors.New("工作进程工具调用与已提交步骤不符"))
				}
				requested = true
				if cancelErr == nil && runCtx.Err() == nil {
					pending = true
					go invokeTool(runCtx, invoke, index, plan[index], done)
				}
			case "run/finished":
				valid := f.runOnly() && ((f.Status == "succeeded" && index == len(plan) && failure == nil && !pending) || (f.Status == "failed" && failure != nil && !pending) || (f.Status == "cancelled" && cancelErr != nil))
				if !valid {
					return p.interrupt(errors.New("工作进程结束状态与执行事实不符"))
				}
				finished = true
			default:
				return p.interrupt(errors.New("工作进程返回未知消息类型"))
			}
		}
	}
}
