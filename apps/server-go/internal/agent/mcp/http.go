package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
)

type httpTransport struct {
	client  *http.Client
	server  Server
	mu      sync.Mutex
	session string
	closed  bool
	active  context.CancelFunc
	changed func()
}

func (t *httpTransport) request(ctx context.Context, b []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, t.server.URL, bytes.NewReader(b))
	if err != nil {
		return nil, protocolError()
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	t.mu.Lock()
	session, closed := t.session, t.closed
	t.mu.Unlock()
	if closed {
		return nil, problem(503, "mcp-closed", "MCP 通道已关闭")
	}
	if session != "" {
		req.Header.Set("Mcp-Session-Id", session)
	}
	if t.server.Credential != "" {
		req.Header.Set("Authorization", "Bearer "+t.server.Credential)
	}
	res, err := t.client.Do(req)
	if err != nil {
		return nil, problem(502, "mcp-transport", "MCP 网络请求失败，未获得完整响应")
	}
	if res.StatusCode >= 300 && res.StatusCode <= 399 {
		res.Body.Close()
		return nil, problem(502, "mcp-redirect-refused", "MCP 服务要求跳转，已阻止请求")
	}
	return res, nil
}
func (t *httpTransport) exchange(ctx context.Context, req wireRequest) (json.RawMessage, bool, error) {
	b, err := marshalRequest(req)
	if err != nil {
		return nil, false, err
	}
	callCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil, false, problem(503, "mcp-closed", "MCP 通道已关闭")
	}
	t.active = cancel
	t.mu.Unlock()
	defer func() { t.mu.Lock(); t.active = nil; t.mu.Unlock() }()
	res, err := t.request(callCtx, b)
	if err != nil {
		return nil, true, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, true, problem(502, "mcp-http-status", "MCP 服务返回异常状态")
	}
	if err = t.negotiate(res, req.Method == "initialize"); err != nil {
		return nil, true, err
	}
	media, _, err := mime.ParseMediaType(res.Header.Get("Content-Type"))
	if err != nil {
		return nil, true, protocolError()
	}
	switch media {
	case "application/json":
		raw, err := io.ReadAll(io.LimitReader(res.Body, MaxMessageBytes+1))
		if err != nil {
			return nil, true, protocolError()
		}
		msg, err := parseIncoming(raw)
		if err != nil {
			return nil, true, err
		}
		returnValue, err := responseFor(msg, req.ID)
		return returnValue, true, err
	case "text/event-stream":
		result, err := t.readSSE(callCtx, res.Body, req.ID)
		return result, true, err
	default:
		return nil, true, protocolError()
	}
}
func (t *httpTransport) negotiate(res *http.Response, initialize bool) error {
	session := res.Header.Get("Mcp-Session-Id")
	if len(session) > 256 {
		return protocolError()
	}
	for _, r := range session {
		if r < 0x21 || r > 0x7e {
			return protocolError()
		}
	}
	if version := res.Header.Get("MCP-Protocol-Version"); version != "" && version != ProtocolVersion {
		return protocolError()
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if initialize {
		t.session = session
	} else if session != "" && session != t.session {
		return protocolError()
	}
	return nil
}
func (t *httpTransport) readSSE(ctx context.Context, body io.Reader, id string) (json.RawMessage, error) {
	scanner := bufio.NewScanner(io.LimitReader(body, MaxMessageBytes+1))
	scanner.Buffer(make([]byte, 4096), MaxMessageBytes)
	data := ""
	total := 0
	events := 0
	for scanner.Scan() {
		line := scanner.Text()
		total += len(line) + 1
		if total > MaxMessageBytes {
			return nil, protocolError()
		}
		if line == "" {
			if data == "" {
				continue
			}
			events++
			if events > 128 {
				return nil, protocolError()
			}
			msg, err := parseIncoming([]byte(strings.TrimSuffix(data, "\n")))
			data = ""
			if err != nil {
				return nil, err
			}
			if msg.Method != "" {
				if len(msg.ID) > 0 {
					if err := t.reply(ctx, reverseReply(msg)); err != nil {
						return nil, err
					}
				} else if changedMethod(msg.Method) && t.changed != nil {
					t.changed()
				}
				continue
			}
			return responseFor(msg, id)
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if !found {
			value = ""
		}
		value = strings.TrimPrefix(value, " ")
		if field == "data" {
			data += value + "\n"
		}
	}
	return nil, protocolError()
}
func (t *httpTransport) reply(ctx context.Context, b []byte) error {
	res, err := t.request(ctx, b)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		return protocolError()
	}
	return t.negotiate(res, false)
}
func (t *httpTransport) notify(ctx context.Context, req wireRequest) error {
	b, err := marshalRequest(req)
	if err != nil {
		return err
	}
	return t.reply(ctx, b)
}
func (t *httpTransport) close(ctx context.Context) error {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil
	}
	t.closed = true
	session, active := t.session, t.active
	t.mu.Unlock()
	if active != nil {
		active()
	}
	if session == "" {
		return nil
	}
	closeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(closeCtx, http.MethodDelete, t.server.URL, nil)
	if err != nil {
		return protocolError()
	}
	req.Header.Set("Mcp-Session-Id", session)
	req.Header.Set("MCP-Protocol-Version", ProtocolVersion)
	if t.server.Credential != "" {
		req.Header.Set("Authorization", "Bearer "+t.server.Credential)
	}
	res, err := t.client.Do(req)
	if err != nil {
		return problem(503, "mcp-close-unconfirmed", "MCP 会话停止结果未确认")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusAccepted && res.StatusCode != http.StatusNoContent && res.StatusCode != http.StatusNotFound && res.StatusCode != http.StatusMethodNotAllowed {
		return problem(503, "mcp-close-unconfirmed", "MCP 会话停止结果未确认")
	}
	return nil
}
