package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"sync"
	"time"
)

type delivery struct {
	message incoming
	err     error
}
type stdioTransport struct {
	duplex    Duplex
	stdin     io.WriteCloser
	stdout    io.ReadCloser
	stderr    io.ReadCloser
	writeMu   sync.Mutex
	mu        sync.Mutex
	pending   map[string]chan delivery
	abandoned map[string]bool
	closed    bool
	done      chan struct{}
	errDone   chan struct{}
	changed   func()
	late      func(string, json.RawMessage)
	failed    func()
}

func newStdioTransport(d Duplex, changed func(), late func(string, json.RawMessage), failed func()) *stdioTransport {
	t := &stdioTransport{duplex: d, stdin: d.Stdin(), stdout: d.Stdout(), stderr: d.Stderr(), pending: make(map[string]chan delivery), abandoned: make(map[string]bool), done: make(chan struct{}), errDone: make(chan struct{}), changed: changed, late: late, failed: failed}
	go t.read()
	go func() { defer close(t.errDone); _, _ = io.Copy(io.Discard, t.stderr) }()
	return t
}
func (t *stdioTransport) read() {
	defer close(t.done)
	defer t.fail()
	scanner := bufio.NewScanner(t.stdout)
	scanner.Buffer(make([]byte, 4096), MaxMessageBytes+1)
	for scanner.Scan() {
		raw := scanner.Bytes()
		if len(raw) == 0 {
			continue
		}
		msg, err := parseIncoming(raw)
		if err != nil {
			return
		}
		if msg.Method != "" {
			if len(msg.ID) > 0 {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				err := t.write(ctx, reverseReply(msg))
				cancel()
				if err != nil {
					return
				}
			} else if changedMethod(msg.Method) && t.changed != nil {
				t.changed()
			}
			continue
		}
		var id string
		if json.Unmarshal(msg.ID, &id) != nil {
			return
		}
		t.mu.Lock()
		ch := t.pending[id]
		abandoned := t.abandoned[id]
		if ch != nil {
			delete(t.pending, id)
			ch <- delivery{message: msg}
		}
		if abandoned {
			delete(t.abandoned, id)
		}
		t.mu.Unlock()
		if ch == nil && abandoned && len(msg.Result) > 0 && t.late != nil {
			t.late(id, msg.Result)
		} else if ch == nil && !abandoned {
			return
		}
	}
}
func (t *stdioTransport) fail() {
	t.mu.Lock()
	pending := t.pending
	t.pending = make(map[string]chan delivery)
	t.closed = true
	t.mu.Unlock()
	if t.failed != nil {
		t.failed()
	}
	for _, ch := range pending {
		ch <- delivery{err: problem(502, "mcp-stdio-lost", "MCP 容器通道已中断")}
	}
}
func (t *stdioTransport) write(ctx context.Context, b []byte) error {
	if ctx.Err() != nil {
		return problem(499, "mcp-cancelled", "MCP 请求已取消")
	}
	// 请求取消只结束等待，保留通道以发送取消通知并接收迟到结果。
	// 已损坏连接不再接受业务请求；显式 Close 必须令阻塞读写退出。
	finished := make(chan error, 1)
	go func() {
		t.writeMu.Lock()
		defer t.writeMu.Unlock()
		t.mu.Lock()
		closed := t.closed
		t.mu.Unlock()
		if closed {
			finished <- problem(503, "mcp-closed", "MCP 通道已关闭")
			return
		}
		_, err := t.stdin.Write(append(append([]byte(nil), b...), '\n'))
		finished <- err
	}()
	select {
	case err := <-finished:
		if err != nil {
			return problem(502, "mcp-stdio-lost", "MCP 容器通道写入失败")
		}
		return nil
	case <-ctx.Done():
		return problem(499, "mcp-cancelled", "MCP 请求已取消")
	}
}
func (t *stdioTransport) exchange(ctx context.Context, req wireRequest) (json.RawMessage, bool, error) {
	b, err := marshalRequest(req)
	if err != nil {
		return nil, false, err
	}
	ch := make(chan delivery, 1)
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil, false, problem(503, "mcp-closed", "MCP 通道已关闭")
	}
	if t.pending[req.ID] != nil || t.abandoned[req.ID] {
		t.mu.Unlock()
		return nil, false, problem(409, "mcp-request-conflict", "MCP 请求编号已被使用")
	}
	t.pending[req.ID] = ch
	t.mu.Unlock()
	if err := t.write(ctx, b); err != nil {
		t.mu.Lock()
		delete(t.pending, req.ID)
		t.abandoned[req.ID] = true
		t.mu.Unlock()
		return nil, true, err
	}
	select {
	case got := <-ch:
		if got.err != nil {
			return nil, true, got.err
		}
		result, err := responseFor(got.message, req.ID)
		return result, true, err
	case <-ctx.Done():
		t.mu.Lock()
		select {
		case got := <-ch:
			t.mu.Unlock()
			if got.err != nil {
				return nil, true, got.err
			}
			result, err := responseFor(got.message, req.ID)
			return result, true, err
		default:
		}
		delete(t.pending, req.ID)
		t.abandoned[req.ID] = true
		t.mu.Unlock()
		return nil, true, problem(499, "mcp-cancelled", "MCP 请求已取消，结果未确认")
	}
}
func (t *stdioTransport) notify(ctx context.Context, req wireRequest) error {
	b, err := marshalRequest(req)
	if err != nil {
		return err
	}
	return t.write(ctx, b)
}
func (t *stdioTransport) close(ctx context.Context) error {
	t.fail()
	_ = t.stdin.Close()
	_ = t.stdout.Close()
	_ = t.stderr.Close()
	err := t.duplex.Close(ctx)
	select {
	case <-t.done:
	case <-ctx.Done():
		return problem(503, "mcp-close-unconfirmed", "MCP 容器通道停止结果未确认")
	}
	select {
	case <-t.errDone:
	case <-ctx.Done():
		return problem(503, "mcp-close-unconfirmed", "MCP 容器诊断通道停止结果未确认")
	}
	if err != nil {
		return problem(503, "mcp-close-unconfirmed", "MCP 容器停止结果未确认")
	}
	return nil
}
