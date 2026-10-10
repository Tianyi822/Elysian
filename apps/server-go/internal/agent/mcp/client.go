package mcp

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strconv"
	"sync"
	"time"

	"elysian/server/internal/agent/jsonvalue"
)

type Client struct {
	mu               sync.Mutex
	http             *http.Client
	factory          DuplexFactory
	connections      map[string]*connection
	starting         map[string]*connectionStartup
	closed           bool
	closeDone        chan struct{}
	closeErr         error
	onCatalogChanged func(string, int)
	onLateResult     func(Server, string, string, json.RawMessage)
}
type connectionStartup struct {
	done   chan struct{}
	err    error
	cancel context.CancelFunc
}
type connection struct {
	server       Server
	id           string
	lock         chan struct{}
	transport    transport
	initialized  bool
	capabilities Capabilities
	mu           sync.Mutex
	changed      bool
	broken       bool
	requests     map[string]bool
}
type transport interface {
	exchange(context.Context, wireRequest) (json.RawMessage, bool, error)
	notify(context.Context, wireRequest) error
	close(context.Context) error
}
type wireRequest struct {
	JSONRPC string `json:"jsonrpc"`
	ID      string `json:"id,omitempty"`
	Method  string `json:"method"`
	Params  any    `json:"params,omitempty"`
}

// NewClient 不重试请求；HTTP 禁止重定向和 Cookie，stdio 必须注入容器通道。
func NewClient(h *http.Client, factory DuplexFactory) *Client {
	if h == nil {
		h = &http.Client{Timeout: 60 * time.Second}
	}
	copy := *h
	copy.Jar = nil
	copy.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{http: &copy, factory: factory, connections: make(map[string]*connection), starting: make(map[string]*connectionStartup), closeDone: make(chan struct{})}
}

// SetCatalogChangedHandler 回调只提供服务身份，不携带远端通知内容。
func (c *Client) SetCatalogChangedHandler(fn func(string, int)) {
	c.mu.Lock()
	c.onCatalogChanged = fn
	c.mu.Unlock()
}

// SetLateResultHandler 仅追加迟到事实；调用者不能据此重放、再次消费审批或撤销人工核验。
func (c *Client) SetLateResultHandler(fn func(Server, string, string, json.RawMessage)) {
	c.mu.Lock()
	c.onLateResult = fn
	c.mu.Unlock()
}
func (c *Client) changed(conn *connection) {
	conn.mu.Lock()
	conn.changed = true
	conn.mu.Unlock()
	c.mu.Lock()
	fn := c.onCatalogChanged
	c.mu.Unlock()
	if fn != nil {
		fn(conn.server.ID, conn.server.Revision)
	}
}
func (c *Client) get(ctx context.Context, s Server) (*connection, error) {
	if ctx == nil {
		return nil, problem(400, "invalid-mcp-request", "MCP 请求缺少上下文")
	}
	if err := validateServer(s); err != nil {
		return nil, err
	}
	if s.Revoked {
		return nil, problem(409, "mcp-revoked", "MCP 服务已撤销")
	}
	key := connectionKey(ctx, s)
	for {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return nil, problem(503, "mcp-closed", "MCP 客户端已关闭")
		}
		if conn := c.connections[key]; conn != nil {
			if !reflect.DeepEqual(conn.server, s) {
				c.mu.Unlock()
				return nil, problem(409, "mcp-revision-conflict", "同一 MCP 修订的连接配置不一致")
			}
			conn.mu.Lock()
			broken := conn.broken
			conn.mu.Unlock()
			c.mu.Unlock()
			if !broken {
				return conn, nil
			}
			return nil, problem(409, "mcp-connection-lost", "MCP 连接已中断，请显式重新探测后重试")
		}
		if start := c.starting[key]; start != nil {
			c.mu.Unlock()
			select {
			case <-start.done:
				if start.err != nil {
					return nil, start.err
				}
				continue
			case <-ctx.Done():
				return nil, problem(499, "mcp-cancelled", "MCP 请求已取消")
			}
		}
		startupCtx, cancelStartup := context.WithCancel(ctx)
		start := &connectionStartup{done: make(chan struct{}), cancel: cancelStartup}
		c.starting[key] = start
		c.mu.Unlock()

		id, err := newID()
		var conn *connection
		if err == nil {
			conn = &connection{server: cloneServer(s), id: id, lock: make(chan struct{}, 1), requests: make(map[string]bool)}
			conn.lock <- struct{}{}
			if s.Transport == "streamable-http" {
				conn.transport = &httpTransport{client: c.http, server: cloneServer(s), changed: func() { c.changed(conn) }}
			} else if c.factory == nil {
				err = problem(503, "mcp-stdio-unavailable", "MCP 容器通道尚未装配")
			} else {
				// Container startup is deliberately outside Client.mu. Other MCP
				// revisions remain usable while Docker allocates this process.
				var duplex Duplex
				duplex, err = c.factory.Open(startupCtx, cloneServer(s))
				if err == nil && (duplex == nil || duplex.Stdin() == nil || duplex.Stdout() == nil || duplex.Stderr() == nil || !cleanText(duplex.Identity(), 200)) {
					if duplex != nil {
						_ = duplex.Close(ctx)
					}
					err = problem(502, "mcp-stdio-unavailable", "MCP 容器通道无效")
				}
				if err == nil {
					conn.id = duplex.Identity()
					conn.transport = newStdioTransport(duplex, func() { c.changed(conn) }, func(requestID string, result json.RawMessage) {
						c.mu.Lock()
						fn := c.onLateResult
						c.mu.Unlock()
						if fn != nil {
							fn(conn.server.Public(), requestID, conn.id, append(json.RawMessage(nil), result...))
						}
					}, func() { markBroken(conn) })
				}
			}
		}
		c.mu.Lock()
		if err == nil && (c.closed || startupCtx.Err() != nil) {
			err = problem(503, "mcp-closed", "MCP 客户端或连接作用域已关闭")
		}
		if err == nil {
			c.connections[key] = conn
		}
		c.mu.Unlock()
		// A startup racing with Close belongs to the closing scope even when
		// the factory returns success after its context has been cancelled.
		if err != nil && conn != nil && conn.transport != nil {
			closeCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if closeErr := conn.transport.close(closeCtx); closeErr != nil {
				err = closeErr
			}
			cancel()
		}
		cancelStartup()
		c.mu.Lock()
		delete(c.starting, key)
		start.err = err
		close(start.done)
		c.mu.Unlock()
		if err != nil {
			return nil, err
		}
		return conn, nil
	}
}
func acquire(ctx context.Context, conn *connection) error {
	select {
	case <-ctx.Done():
		return problem(499, "mcp-cancelled", "MCP 请求已取消")
	case <-conn.lock:
		return nil
	}
}
func release(conn *connection) { conn.lock <- struct{}{} }
func (c *Client) initialize(ctx context.Context, conn *connection) error {
	if conn.initialized {
		return nil
	}
	requestID, err := newID()
	if err != nil {
		return err
	}
	result, _, err := conn.transport.exchange(ctx, wireRequest{JSONRPC: "2.0", ID: requestID, Method: "initialize", Params: map[string]any{"protocolVersion": ProtocolVersion, "capabilities": map[string]any{}, "clientInfo": map[string]string{"name": "Elysian", "version": "1"}}})
	if err != nil {
		markBroken(conn)
		return err
	}
	var init struct {
		ProtocolVersion string                     `json:"protocolVersion"`
		Capabilities    map[string]json.RawMessage `json:"capabilities"`
		ServerInfo      json.RawMessage            `json:"serverInfo"`
	}
	if json.Unmarshal(result, &init) != nil || init.ProtocolVersion != ProtocolVersion || init.Capabilities == nil || len(init.ServerInfo) == 0 {
		markBroken(conn)
		return protocolError()
	}
	if _, err := jsonvalue.Object(init.ServerInfo); err != nil {
		markBroken(conn)
		return protocolError()
	}
	for _, name := range []string{"tools", "resources", "prompts"} {
		if raw, ok := init.Capabilities[name]; ok {
			if _, err := jsonvalue.Object(raw); err != nil {
				markBroken(conn)
				return protocolError()
			}
		}
	}
	_, conn.capabilities.Tools = init.Capabilities["tools"]
	_, conn.capabilities.Resources = init.Capabilities["resources"]
	_, conn.capabilities.Prompts = init.Capabilities["prompts"]
	if err := conn.transport.notify(ctx, wireRequest{JSONRPC: "2.0", Method: "notifications/initialized"}); err != nil {
		markBroken(conn)
		return err
	}
	conn.initialized = true
	return nil
}
func markBroken(conn *connection) { conn.mu.Lock(); conn.broken = true; conn.mu.Unlock() }
func checkChanged(conn *connection) error {
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if conn.changed {
		return problem(409, "mcp-catalog-changed", "MCP 目录已变化，必须重新探测并确认执行快照")
	}
	return nil
}

// Probe 显式重新建立损坏连接并拉取所有分页目录，不自动重试任何请求。
func (c *Client) Probe(ctx context.Context, s Server) (Catalog, error) {
	if ctx == nil {
		return Catalog{}, problem(400, "invalid-mcp-request", "MCP 请求缺少上下文")
	}
	key := connectionKey(ctx, s)
	c.mu.Lock()
	old := c.connections[key]
	if old != nil {
		old.mu.Lock()
		broken := old.broken
		old.mu.Unlock()
		if !broken {
			old = nil
		}
	}
	c.mu.Unlock()
	if old != nil {
		closeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := old.transport.close(closeCtx)
		cancel()
		if err != nil {
			return Catalog{}, err
		}
		c.mu.Lock()
		if c.connections[key] == old {
			delete(c.connections, key)
		}
		c.mu.Unlock()
	}
	conn, err := c.get(ctx, s)
	if err != nil {
		return Catalog{}, err
	}
	if err = acquire(ctx, conn); err != nil {
		return Catalog{}, err
	}
	defer release(conn)
	if err = c.initialize(ctx, conn); err != nil {
		return Catalog{}, err
	}
	conn.mu.Lock()
	conn.changed = false
	conn.mu.Unlock()
	cat := Catalog{ProtocolVersion: ProtocolVersion, Capabilities: conn.capabilities, Tools: []Tool{}, Resources: []Resource{}, Prompts: []Prompt{}, FetchedAt: time.Now().UTC()}
	var total int
	for _, part := range []struct {
		method, field string
		enabled       bool
	}{{"tools/list", "tools", cat.Capabilities.Tools}, {"resources/list", "resources", cat.Capabilities.Resources}, {"prompts/list", "prompts", cat.Capabilities.Prompts}} {
		if !part.enabled {
			continue
		}
		cursor := ""
		seen := make(map[string]bool)
		for page := 0; ; page++ {
			if page >= 64 {
				return Catalog{}, protocolError()
			}
			id, err := newID()
			if err != nil {
				return Catalog{}, err
			}
			params := map[string]any{}
			if cursor != "" {
				params["cursor"] = cursor
			}
			result, _, err := conn.transport.exchange(ctx, wireRequest{JSONRPC: "2.0", ID: id, Method: part.method, Params: params})
			if err != nil {
				markBroken(conn)
				return Catalog{}, err
			}
			total += len(result)
			if total > MaxCatalogBytes {
				return Catalog{}, protocolError()
			}
			var wire map[string]json.RawMessage
			if json.Unmarshal(result, &wire) != nil {
				return Catalog{}, protocolError()
			}
			entries, ok := wire[part.field]
			if !ok || len(entries) == 0 || entries[0] != '[' {
				return Catalog{}, protocolError()
			}
			switch part.field {
			case "tools":
				var v []Tool
				if json.Unmarshal(entries, &v) != nil {
					return Catalog{}, protocolError()
				}
				cat.Tools = append(cat.Tools, v...)
			case "resources":
				var v []Resource
				if json.Unmarshal(entries, &v) != nil {
					return Catalog{}, protocolError()
				}
				cat.Resources = append(cat.Resources, v...)
			case "prompts":
				var v []Prompt
				if json.Unmarshal(entries, &v) != nil {
					return Catalog{}, protocolError()
				}
				cat.Prompts = append(cat.Prompts, v...)
			}
			if len(cat.Tools)+len(cat.Resources)+len(cat.Prompts) > MaxCatalogEntries {
				return Catalog{}, protocolError()
			}
			cursor = ""
			if raw, ok := wire["nextCursor"]; ok {
				if json.Unmarshal(raw, &cursor) != nil || !cleanText(cursor, 4096) {
					return Catalog{}, protocolError()
				}
			}
			if cursor == "" {
				break
			}
			if seen[cursor] {
				return Catalog{}, protocolError()
			}
			seen[cursor] = true
		}
	}
	if err := checkChanged(conn); err != nil {
		return Catalog{}, err
	}
	return NormalizeCatalog(cat)
}

// CheckCatalog 在派发前刷新并核对固定目录；重连也必须经过同一核对。
func (c *Client) CheckCatalog(ctx context.Context, s Server, digest string) error {
	if len(digest) != 64 {
		return problem(409, "mcp-catalog-required", "执行 MCP 工具前必须固定已验证的目录")
	}
	cat, err := c.Probe(ctx, s)
	if err != nil {
		return err
	}
	if cat.Digest != digest {
		c.mu.Lock()
		conn := c.connections[connectionKey(ctx, s)]
		c.mu.Unlock()
		if conn != nil {
			c.changed(conn)
		}
		return problem(409, "mcp-catalog-changed", "MCP 目录已变化，必须重新探测并确认执行快照")
	}
	return nil
}

func (c *Client) execute(ctx context.Context, s Server, id, method string, params any) (json.RawMessage, *connection, error) {
	if !cleanText(id, 200) {
		return nil, nil, problem(400, "invalid-mcp-request", "MCP 请求编号无效")
	}
	conn, err := c.get(ctx, s)
	if err != nil {
		return nil, nil, err
	}
	if err = acquire(ctx, conn); err != nil {
		return nil, conn, err
	}
	defer release(conn)
	if err = c.initialize(ctx, conn); err != nil {
		return nil, conn, err
	}
	if err = checkChanged(conn); err != nil {
		return nil, conn, err
	}
	if conn.requests[id] || len(conn.requests) >= 8192 {
		return nil, conn, problem(409, "mcp-request-conflict", "MCP 请求编号已使用或连接请求数量达到上限")
	}
	conn.requests[id] = true
	if method == "tools/call" && !conn.capabilities.Tools || method == "resources/read" && !conn.capabilities.Resources || method == "prompts/get" && !conn.capabilities.Prompts {
		return nil, conn, problem(409, "mcp-capability-unavailable", "MCP 服务没有声明所需能力")
	}
	result, dispatched, err := conn.transport.exchange(ctx, wireRequest{JSONRPC: "2.0", ID: id, Method: method, Params: params})
	if err != nil {
		if ctx.Err() != nil && dispatched {
			cancelCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_ = conn.transport.notify(cancelCtx, wireRequest{JSONRPC: "2.0", Method: "notifications/cancelled", Params: map[string]string{"requestId": id, "reason": "请求上下文已取消"}})
			cancel()
		}
		var typed *Error
		if errors.As(err, &typed) && typed.Code == "mcp-remote-error" {
			copy := *typed
			copy.RequestID = id
			copy.ConnectionID = conn.id
			return nil, conn, &copy
		}
		markBroken(conn)
		return nil, conn, withIdentity(err, id, conn.id, dispatched)
	}
	return result, conn, nil
}
func (c *Client) CallTool(ctx context.Context, s Server, call Call) (CallResult, error) {
	if !cleanText(call.Name, 256) {
		return CallResult{}, problem(400, "invalid-mcp-request", "MCP 工具名称无效")
	}
	args, err := jsonvalue.Object(call.Arguments)
	if err != nil {
		return CallResult{}, problem(400, "invalid-mcp-arguments", "MCP 工具参数必须是无重复字段的 JSON 对象")
	}
	if err = Validate(call.InputSchema, call.Arguments); err != nil {
		return CallResult{}, err
	}
	result, conn, err := c.execute(ctx, s, call.RequestID, "tools/call", map[string]any{"name": call.Name, "arguments": args})
	if err != nil {
		return CallResult{}, err
	}
	var out CallResult
	if json.Unmarshal(result, &out) != nil || out.Content == nil || validateBlocks(out.Content) != nil {
		return CallResult{}, withIdentity(protocolError(), call.RequestID, conn.id, true)
	}
	var fields map[string]json.RawMessage
	_ = json.Unmarshal(result, &fields)
	if raw, ok := fields["isError"]; ok && string(raw) != "true" && string(raw) != "false" {
		return CallResult{}, withIdentity(protocolError(), call.RequestID, conn.id, true)
	}
	if len(out.StructuredContent) > 0 {
		if _, err := jsonvalue.Object(out.StructuredContent); err != nil {
			return CallResult{}, withIdentity(protocolError(), call.RequestID, conn.id, true)
		}
	}
	if !out.IsError && len(call.OutputSchema) > 0 {
		if len(out.StructuredContent) == 0 || Validate(call.OutputSchema, out.StructuredContent) != nil {
			return CallResult{}, withIdentity(protocolError(), call.RequestID, conn.id, true)
		}
	}
	out.RequestID = call.RequestID
	out.ConnectionID = conn.id
	return out, nil
}
func (c *Client) ReadResource(ctx context.Context, s Server, id, uri string) (ResourceResult, error) {
	if !cleanText(uri, 4096) {
		return ResourceResult{}, problem(400, "invalid-mcp-request", "MCP 资源地址无效")
	}
	result, conn, err := c.execute(ctx, s, id, "resources/read", map[string]string{"uri": uri})
	if err != nil {
		return ResourceResult{}, err
	}
	var out ResourceResult
	if json.Unmarshal(result, &out) != nil || out.Contents == nil || len(out.Contents) > MaxContentBlocks {
		return ResourceResult{}, withIdentity(protocolError(), id, conn.id, true)
	}
	for _, raw := range out.Contents {
		if err := validateResource(raw); err != nil {
			return ResourceResult{}, withIdentity(err, id, conn.id, true)
		}
	}
	out.RequestID = id
	out.ConnectionID = conn.id
	return out, nil
}
func (c *Client) GetPrompt(ctx context.Context, s Server, id, name string, args map[string]string) (PromptResult, error) {
	if !cleanText(name, 256) || len(args) > 128 {
		return PromptResult{}, problem(400, "invalid-mcp-request", "MCP 提示模板参数无效")
	}
	for k, v := range args {
		if !cleanText(k, 256) || len(v) > 32768 {
			return PromptResult{}, problem(400, "invalid-mcp-request", "MCP 提示模板参数无效")
		}
	}
	result, conn, err := c.execute(ctx, s, id, "prompts/get", map[string]any{"name": name, "arguments": args})
	if err != nil {
		return PromptResult{}, err
	}
	var out PromptResult
	if json.Unmarshal(result, &out) != nil || out.Messages == nil || len(out.Messages) > MaxContentBlocks || len(out.Description) > 32768 {
		return PromptResult{}, withIdentity(protocolError(), id, conn.id, true)
	}
	for _, msg := range out.Messages {
		if msg.Role != "user" && msg.Role != "assistant" || validateBlocks([]json.RawMessage{msg.Content}) != nil {
			return PromptResult{}, withIdentity(protocolError(), id, conn.id, true)
		}
	}
	out.RequestID = id
	out.ConnectionID = conn.id
	return out, nil
}
func (c *Client) Cancel(ctx context.Context, server string, revision int, requestID string) error {
	if !cleanText(requestID, 200) {
		return problem(400, "invalid-mcp-request", "MCP 请求编号无效")
	}
	c.mu.Lock()
	conn := c.connections[scopedConnectionKey(ctx, server, revision)]
	if conn == nil && Scope(ctx) != "" {
		conn = c.connections[server+":"+strconv.Itoa(revision)]
	}
	c.mu.Unlock()
	if conn == nil {
		return nil
	}
	return conn.transport.notify(ctx, wireRequest{JSONRPC: "2.0", Method: "notifications/cancelled", Params: map[string]string{"requestId": requestID, "reason": "用户取消"}})
}

// CloseServer closes one stdio generation. HTTP transports are stateless and
// remain reusable. The harness calls this when an operation enters approval or
// resource wait and after every completed stdio operation, so a process never
// survives beyond the operation scope.
func (c *Client) CloseServer(ctx context.Context, server string, revision int) error {
	key := scopedConnectionKey(ctx, server, revision)
	c.mu.Lock()
	start := c.starting[key]
	if start != nil {
		start.cancel()
	}
	c.mu.Unlock()
	if start != nil {
		select {
		case <-start.done:
			var typed *Error
			if errors.As(start.err, &typed) && typed.Code == "mcp-close-unconfirmed" {
				return typed
			}
		case <-ctx.Done():
			return problem(503, "mcp-close-unconfirmed", "MCP 容器启动停止结果未确认")
		}
	}
	c.mu.Lock()
	conn := c.connections[key]
	c.mu.Unlock()
	if conn == nil || conn.server.Stdio == nil {
		return nil
	}
	if err := conn.transport.close(ctx); err != nil {
		markBroken(conn)
		return err
	}
	c.mu.Lock()
	if c.connections[key] == conn {
		delete(c.connections, key)
	}
	c.mu.Unlock()
	return nil
}
func (c *Client) Close(ctx context.Context) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		select {
		case <-c.closeDone:
			c.mu.Lock()
			err := c.closeErr
			c.mu.Unlock()
			return err
		case <-ctx.Done():
			return problem(503, "mcp-close-unconfirmed", "MCP 通道停止结果未确认")
		}
	}
	c.closed = true
	starts := make([]*connectionStartup, 0, len(c.starting))
	for _, start := range c.starting {
		start.cancel()
		starts = append(starts, start)
	}
	all := make([]*connection, 0, len(c.connections))
	for _, conn := range c.connections {
		all = append(all, conn)
	}
	c.mu.Unlock()
	var failure error
	for _, conn := range all {
		if err := conn.transport.close(ctx); err != nil {
			failure = problem(503, "mcp-close-unconfirmed", "MCP 通道停止结果未确认")
		}
	}
	for _, start := range starts {
		select {
		case <-start.done:
			var typed *Error
			if errors.As(start.err, &typed) && typed.Code == "mcp-close-unconfirmed" {
				failure = typed
			}
		case <-ctx.Done():
			failure = problem(503, "mcp-close-unconfirmed", "MCP 容器启动停止结果未确认")
		}
	}
	c.http.CloseIdleConnections()
	c.mu.Lock()
	c.closeErr = failure
	close(c.closeDone)
	c.mu.Unlock()
	return failure
}
func newID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", problem(503, "mcp-id-unavailable", "无法分配 MCP 请求编号")
	}
	return hex.EncodeToString(b[:]), nil
}
func withIdentity(err error, id, conn string, unknown bool) error {
	var typed *Error
	if errors.As(err, &typed) {
		copy := *typed
		copy.RequestID = id
		copy.ConnectionID = conn
		copy.OutcomeUnknown = unknown
		if unknown {
			copy.Code = "mcp-outcome-unknown"
			copy.Message = "MCP 请求已派发但结果未确认，不能自动重放"
		}
		return &copy
	}
	return &Error{Status: 502, Code: "mcp-outcome-unknown", Message: "MCP 请求结果未确认，不能自动重放", OutcomeUnknown: unknown, RequestID: id, ConnectionID: conn}
}
