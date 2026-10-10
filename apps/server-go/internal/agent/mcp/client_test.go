package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type failingCloseTransport struct {
	started chan struct{}
	release chan struct{}
	closes  atomic.Int32
}

func (t *failingCloseTransport) exchange(context.Context, wireRequest) (json.RawMessage, bool, error) {
	return nil, false, errors.New("不应派发")
}
func (t *failingCloseTransport) notify(context.Context, wireRequest) error {
	return errors.New("不应通知")
}
func (t *failingCloseTransport) close(context.Context) error {
	t.closes.Add(1)
	if t.started != nil {
		close(t.started)
		<-t.release
	}
	return problem(503, "mcp-close-unconfirmed", "MCP 通道停止结果未确认")
}

func TestClientCloseKeepsUnconfirmedOutcomeForConcurrentAndRepeatedCallers(t *testing.T) {
	transport := &failingCloseTransport{started: make(chan struct{}), release: make(chan struct{})}
	c := NewClient(nil, nil)
	c.connections["test"] = &connection{transport: transport}
	done := make(chan error, 1)
	go func() { done <- c.Close(context.Background()) }()
	select {
	case <-transport.started:
	case <-time.After(time.Second):
		t.Fatal("停止未开始")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	requireCode(t, c.Close(ctx), "mcp-close-unconfirmed")
	close(transport.release)
	requireCode(t, <-done, "mcp-close-unconfirmed")
	requireCode(t, c.Close(context.Background()), "mcp-close-unconfirmed")
	if transport.closes.Load() != 1 {
		t.Fatal("重复关闭重新触发底层操作")
	}
}

func TestProbeDoesNotReplaceBrokenConnectionUntilStopConfirmed(t *testing.T) {
	transport := &failingCloseTransport{}
	c := NewClient(nil, nil)
	server := httpConfig("https://example.test/mcp")
	previous := &connection{server: server, broken: true, transport: transport}
	key := server.ID + ":1"
	c.connections[key] = previous
	_, err := c.Probe(context.Background(), server)
	requireCode(t, err, "mcp-close-unconfirmed")
	if c.connections[key] != previous || transport.closes.Load() != 1 {
		t.Fatal("未确认停止的连接被遗忘或替换")
	}
}

func TestClosedStdioMarksConnectionBrokenBeforeNextBusinessRequest(t *testing.T) {
	d := newFakeDuplex()
	c := NewClient(nil, fakeFactory{d: d})
	server := Server{ID: "mcp-00000000000000000000000000000000", Revision: 1, Name: "容器", Transport: "stdio", Active: true, Stdio: &ContainerSpec{Image: "example:test", Command: []string{"serve"}}}
	conn, err := c.get(context.Background(), server)
	if err != nil {
		t.Fatal(err)
	}
	_ = d.outW.Close()
	transport := conn.transport.(*stdioTransport)
	select {
	case <-transport.done:
	case <-time.After(time.Second):
		t.Fatal("失联读取未退出")
	}
	conn.mu.Lock()
	broken := conn.broken
	conn.mu.Unlock()
	if !broken {
		t.Fatal("stdio 失联没有立即标记失效连接")
	}
	_, err = c.get(context.Background(), server)
	requireCode(t, err, "mcp-connection-lost")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = c.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func initialization() any {
	return map[string]any{"protocolVersion": ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}, "resources": map[string]any{}, "prompts": map[string]any{}}, "serverInfo": map[string]string{"name": "test", "version": "1"}}
}
func httpConfig(url string) Server {
	return Server{ID: "mcp-00000000000000000000000000000000", Revision: 1, Name: "测试", Transport: "streamable-http", URL: url, Active: true, Credential: "test-secret-mcp", HasCredential: true}
}
func replyRPC(w http.ResponseWriter, id string, result any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func TestHTTPNegotiatesPaginatesRejectsReverseRequestsAndPreservesErrorResult(t *testing.T) {
	var refused atomic.Bool
	var changed atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-secret-mcp" || r.Header.Get("MCP-Protocol-Version") != ProtocolVersion {
			t.Error("凭据或版本头错误")
		}
		if r.Method == http.MethodDelete {
			w.WriteHeader(204)
			return
		}
		var request struct {
			ID     string                     `json:"id"`
			Method string                     `json:"method"`
			Params map[string]json.RawMessage `json:"params"`
			Error  json.RawMessage            `json:"error"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("请求无效")
			w.WriteHeader(400)
			return
		}
		if request.Method != "initialize" && r.Header.Get("Mcp-Session-Id") != "session-test" {
			t.Error("未发送协商会话")
		}
		if request.Method == "" {
			if request.ID == "reverse" && len(request.Error) > 0 {
				refused.Store(true)
			}
			w.WriteHeader(202)
			return
		}
		switch request.Method {
		case "initialize":
			w.Header().Set("Mcp-Session-Id", "session-test")
			replyRPC(w, request.ID, initialization())
		case "notifications/initialized", "notifications/cancelled":
			w.WriteHeader(202)
		case "tools/list":
			if len(request.Params["cursor"]) == 0 {
				replyRPC(w, request.ID, map[string]any{"tools": []Tool{{Name: "a", InputSchema: json.RawMessage(`{"type":"object"}`)}}, "nextCursor": "second"})
			} else {
				replyRPC(w, request.ID, map[string]any{"tools": []Tool{{Name: "b", InputSchema: json.RawMessage(`{"type":"object"}`)}}})
			}
		case "resources/list":
			replyRPC(w, request.ID, map[string]any{"resources": []Resource{{URI: "test://resource", Name: "resource"}}})
		case "prompts/list":
			replyRPC(w, request.ID, map[string]any{"prompts": []Prompt{{Name: "prompt"}}})
		case "tools/call":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"jsonrpc\":\"2.0\",\"id\":\"reverse\",\"method\":\"sampling/createMessage\",\"params\":{}}\n\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\"}\n\n")
			raw, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": map[string]any{"content": []any{map[string]string{"type": "text", "text": "业务失败"}}, "structuredContent": map[string]json.RawMessage{"n": json.RawMessage(`9007199254740993`)}, "isError": true}})
			_, _ = fmt.Fprintf(w, "data: %s\n\n", raw)
		default:
			w.WriteHeader(400)
		}
	}))
	defer server.Close()
	c := NewClient(server.Client(), nil)
	defer c.Close(context.Background())
	c.SetCatalogChangedHandler(func(string, int) { changed.Add(1) })
	config := httpConfig(server.URL)
	catalog, err := c.Probe(context.Background(), config)
	if err != nil || len(catalog.Tools) != 2 || len(catalog.Resources) != 1 || len(catalog.Prompts) != 1 {
		t.Fatalf("目录探测失败：%+v %v", catalog, err)
	}
	if err := c.CheckCatalog(context.Background(), config, catalog.Digest); err != nil {
		t.Fatal(err)
	}
	result, err := c.CallTool(context.Background(), config, Call{RequestID: "call-1", Name: "a", Arguments: json.RawMessage(`{}`), InputSchema: json.RawMessage(`{"type":"object"}`)})
	if err != nil || !result.IsError || !strings.Contains(string(result.StructuredContent), "9007199254740993") || !refused.Load() || changed.Load() != 1 {
		t.Fatalf("工具结果或反向拒绝错误：%+v %v", result, err)
	}
	_, err = c.CallTool(context.Background(), config, Call{RequestID: "call-2", Name: "a", Arguments: json.RawMessage(`{}`), InputSchema: json.RawMessage(`{"type":"object"}`)})
	requireCode(t, err, "mcp-catalog-changed")
}

func TestHTTPUnknownDoesNotRetryOrExposeSecretBody(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req wireRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch req.Method {
		case "initialize":
			replyRPC(w, req.ID, initialization())
		case "notifications/initialized", "notifications/cancelled":
			w.WriteHeader(202)
		case "tools/call":
			calls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":"wrong","result":{"secret":"test-secret-mcp"}}`)
		default:
			w.WriteHeader(204)
		}
	}))
	defer server.Close()
	c := NewClient(server.Client(), nil)
	defer c.Close(context.Background())
	_, err := c.CallTool(context.Background(), httpConfig(server.URL), Call{RequestID: "write-1", Name: "write", Arguments: json.RawMessage(`{}`), InputSchema: json.RawMessage(`{"type":"object"}`)})
	var typed *Error
	if err == nil || !strings.Contains(err.Error(), "结果未确认") || strings.Contains(err.Error(), "test-secret-mcp") {
		t.Fatalf("错误不安全：%v", err)
	}
	typed = err.(*Error)
	if !typed.OutcomeUnknown || typed.RequestID != "write-1" || typed.ConnectionID == "" || calls.Load() != 1 {
		t.Fatal("派发状态或请求关联错误")
	}
}

func TestHTTPRejectsRedirectAndDuplicateResponseFields(t *testing.T) {
	var targetCalls atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { targetCalls.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer server.Close()
	c := NewClient(server.Client(), nil)
	_, err := c.Probe(context.Background(), httpConfig(server.URL))
	requireCode(t, err, "mcp-redirect-refused")
	if targetCalls.Load() != 0 {
		t.Fatal("MCP 重定向泄露凭据")
	}
	_ = c.Close(context.Background())
	if _, err := parseIncoming([]byte(`{"jsonrpc":"2.0","id":"a","result":{},"result":{}}`)); err == nil {
		t.Fatal("接收重复字段")
	}
}

type fakeDuplex struct {
	inR  *io.PipeReader
	inW  *io.PipeWriter
	outR *io.PipeReader
	outW *io.PipeWriter
	errR *io.PipeReader
	errW *io.PipeWriter
	once sync.Once
}

func (d *fakeDuplex) Stdin() io.WriteCloser { return d.inW }
func (d *fakeDuplex) Stdout() io.ReadCloser { return d.outR }
func (d *fakeDuplex) Stderr() io.ReadCloser { return d.errR }
func (d *fakeDuplex) Identity() string      { return "container-task-test" }
func (d *fakeDuplex) Close(context.Context) error {
	d.once.Do(func() {
		_ = d.inR.Close()
		_ = d.inW.Close()
		_ = d.outR.Close()
		_ = d.outW.Close()
		_ = d.errR.Close()
		_ = d.errW.Close()
	})
	return nil
}

type fakeFactory struct{ d *fakeDuplex }

func (f fakeFactory) Open(context.Context, Server) (Duplex, error) { return f.d, nil }
func newFakeDuplex() *fakeDuplex {
	d := &fakeDuplex{}
	d.inR, d.inW = io.Pipe()
	d.outR, d.outW = io.Pipe()
	d.errR, d.errW = io.Pipe()
	return d
}
func (d *fakeDuplex) send(v any) { b, _ := json.Marshal(v); _, _ = d.outW.Write(append(b, '\n')) }

func TestStdioDrainsDiagnosticsAndRefusesReverseRequest(t *testing.T) {
	d := newFakeDuplex()
	stderrDone := make(chan struct{})
	refused := make(chan struct{})
	go func() {
		_, _ = io.WriteString(d.errW, strings.Repeat("private diagnostic test-secret-mcp", 32768))
		close(stderrDone)
	}()
	go func() {
		scanner := bufio.NewScanner(d.inR)
		for scanner.Scan() {
			var req wireRequest
			_ = json.Unmarshal(scanner.Bytes(), &req)
			if req.Method == "initialize" {
				d.send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": initialization()})
			} else if req.Method == "tools/call" {
				d.send(map[string]any{"jsonrpc": "2.0", "id": "server-root", "method": "roots/list"})
				var reply map[string]json.RawMessage
				if scanner.Scan() {
					_ = json.Unmarshal(scanner.Bytes(), &reply)
					if len(reply["error"]) > 0 {
						close(refused)
					}
				}
				d.send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": map[string]any{"content": []any{map[string]string{"type": "text", "text": "ok"}}}})
			}
		}
	}()
	c := NewClient(nil, fakeFactory{d})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s := Server{ID: "mcp-00000000000000000000000000000000", Revision: 1, Name: "容器", Transport: "stdio", Stdio: &ContainerSpec{Image: "example:test", Command: []string{"serve"}}, Active: true}
	out, err := c.CallTool(ctx, s, Call{RequestID: "stdio-call", Name: "check", Arguments: json.RawMessage(`{}`), InputSchema: json.RawMessage(`{"type":"object"}`)})
	if err != nil || out.ConnectionID != "container-task-test" {
		t.Fatalf("stdio 调用失败：%+v %v", out, err)
	}
	select {
	case <-refused:
	case <-ctx.Done():
		t.Fatal("没有拒绝反向请求")
	}
	select {
	case <-stderrDone:
	case <-ctx.Done():
		t.Fatal("stderr 未独立排空")
	}
	if err := c.Close(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestStdioCancellationKeepsUnknownAndAppendsLateFact(t *testing.T) {
	d := newFakeDuplex()
	started := make(chan struct{})
	sendLate := make(chan struct{})
	late := make(chan json.RawMessage, 1)
	go func() {
		scanner := bufio.NewScanner(d.inR)
		callID := ""
		for scanner.Scan() {
			var req wireRequest
			_ = json.Unmarshal(scanner.Bytes(), &req)
			switch req.Method {
			case "initialize":
				d.send(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": initialization()})
			case "tools/call":
				callID = req.ID
				close(started)
			case "notifications/cancelled":
				<-sendLate
				d.send(map[string]any{"jsonrpc": "2.0", "id": callID, "result": map[string]any{"content": []any{map[string]string{"type": "text", "text": "已完成"}}}})
			}
		}
	}()
	c := NewClient(nil, fakeFactory{d})
	c.SetLateResultHandler(func(s Server, id, connectionID string, result json.RawMessage) {
		if id != "cancel-me" || connectionID != "container-task-test" || s.Credential != "" {
			t.Error("迟到事实关联错误")
		}
		late <- result
	})
	s := Server{ID: "mcp-00000000000000000000000000000000", Revision: 1, Name: "容器", Transport: "stdio", Stdio: &ContainerSpec{Image: "example:test", Command: []string{"serve"}}, Active: true}
	ctx, cancel := context.WithCancel(context.Background())
	finished := make(chan error, 1)
	go func() {
		_, err := c.CallTool(ctx, s, Call{RequestID: "cancel-me", Name: "write", Arguments: json.RawMessage(`{}`), InputSchema: json.RawMessage(`{"type":"object"}`)})
		finished <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("调用未开始")
	}
	cancel()
	select {
	case err := <-finished:
		requireCode(t, err, "mcp-outcome-unknown")
		if !err.(*Error).OutcomeUnknown {
			t.Fatal("取消后错误冒充已确认")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("取消未退出")
	}
	close(sendLate)
	select {
	case fact := <-late:
		if !strings.Contains(string(fact), "已完成") {
			t.Fatal("迟到事实丢失")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("未追加迟到事实")
	}
	closeCtx, closeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer closeCancel()
	if err := c.Close(closeCtx); err != nil {
		t.Fatal(err)
	}
}

func TestCheckCatalogRejectsChangedRemoteDefinition(t *testing.T) {
	var modified atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req wireRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		switch req.Method {
		case "initialize":
			replyRPC(w, req.ID, map[string]any{"protocolVersion": ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]string{"name": "test", "version": "1"}})
		case "notifications/initialized":
			w.WriteHeader(202)
		case "tools/list":
			description := "first"
			if modified.Load() {
				description = "changed"
			}
			replyRPC(w, req.ID, map[string]any{"tools": []Tool{{Name: "tool", Description: description, InputSchema: json.RawMessage(`{"type":"object"}`)}}})
		default:
			w.WriteHeader(204)
		}
	}))
	defer server.Close()
	c := NewClient(server.Client(), nil)
	defer c.Close(context.Background())
	config := httpConfig(server.URL)
	cat, err := c.Probe(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	modified.Store(true)
	requireCode(t, c.CheckCatalog(context.Background(), config, cat.Digest), "mcp-catalog-changed")
}
