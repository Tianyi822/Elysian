package execution

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/mcp"
)

var digestImage = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$`)
var identityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

type Executor struct {
	options  Options
	client   *http.Client
	mu       sync.Mutex
	active   map[string]*Process
	closed   bool
	lifetime context.Context
	stop     context.CancelFunc
	revoked  map[string]map[int]bool
}

func New(options Options) (*Executor, error) {
	if options.Authorize == nil {
		options.Authorize = func(context.Context, string) error {
			return problem(403, "execution-authorization", "执行器未装配派发授权门禁")
		}
	}
	if options.SocketPath == "" {
		options.SocketPath = "/var/run/docker.sock"
	}
	if !filepath.IsAbs(options.SocketPath) || !filepath.IsAbs(options.SupervisorPath) {
		return nil, problem(400, "execution-path", "Docker socket 与执行二进制必须使用绝对路径")
	}
	if options.LookupIP == nil {
		options.LookupIP = net.DefaultResolver.LookupIPAddr
	}
	if options.DialContext == nil {
		options.DialContext = (&net.Dialer{Timeout: 10 * time.Second}).DialContext
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", options.SocketPath)
	}, DisableCompression: true}
	lifetime, stop := context.WithCancel(context.Background())
	return &Executor{options: options, client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, active: make(map[string]*Process), lifetime: lifetime, stop: stop, revoked: make(map[string]map[int]bool)}, nil
}

func (e *Executor) request(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, "http://docker/v1.41"+path, body)
	if err != nil {
		return nil, engineError()
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := e.client.Do(req)
	if err != nil {
		return nil, engineError()
	}
	return resp, nil
}
func (e *Executor) call(ctx context.Context, method, path string, body any, result any) error {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return protocolError()
		}
		reader = bytes.NewReader(raw)
	}
	cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	resp, err := e.request(cctx, method, path, reader, "application/json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return engineError()
	}
	if result == nil {
		_, err = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		return err
	}
	raw, err := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil || len(raw) > 1<<20 || json.Unmarshal(raw, result) != nil {
		return engineError()
	}
	return nil
}
func validateProfile(p config.Profile) error {
	if !p.Enabled {
		return problem(403, "execution-profile-disabled", "执行配置已停用")
	}
	if !digestImage.MatchString(p.Image) || p.TimeoutSeconds < 1 || p.TimeoutSeconds > 300 || p.CPUMillis < 1 || p.CPUMillis > 1000 || p.MemoryBytes < 1 || p.MemoryBytes > 512<<20 || p.PIDs < 1 || p.PIDs > 128 {
		return problem(400, "execution-profile", "执行配置的镜像摘要或资源限额无效")
	}
	return nil
}
func validateCommand(command []string, env map[string]string) error {
	if len(command) < 1 || len(command) > 128 || command[0] == "" {
		return problem(400, "execution-command", "执行命令无效")
	}
	n := 0
	for _, v := range command {
		n += len(v)
		if strings.ContainsRune(v, 0) {
			return problem(400, "execution-command", "执行参数无效")
		}
	}
	for k, v := range env {
		n += len(k) + len(v)
		if !envName.MatchString(k) || strings.ContainsRune(v, 0) {
			return problem(400, "execution-environment", "执行环境变量无效")
		}
	}
	if n > 32<<10 || len(env) > 128 {
		return problem(413, "execution-input-limit", "执行参数或环境变量超过上限")
	}
	return nil
}

// Open 实现 MCP 的专属容器工厂。服务器配置不能解除固定的隔离限制。
func (e *Executor) Open(ctx context.Context, server mcp.Server) (mcp.Duplex, error) {
	if !identityPattern.MatchString(server.ID) || server.Revision < 1 {
		return nil, problem(400, "execution-server", "MCP stdio 服务必须固定编号和修订")
	}
	if server.Stdio == nil {
		return nil, problem(400, "execution-stdio", "MCP 缺少容器 stdio 配置")
	}
	var grant *config.Grant
	if server.Stdio.GrantID != "" {
		if e.options.ResolveGrant == nil {
			return nil, problem(503, "execution-grant-unavailable", "MCP 容器网络授权未装配")
		}
		var err error
		grant, err = e.options.ResolveGrant(server.Stdio.GrantID, server.Stdio.GrantRevision)
		if err != nil {
			return nil, err
		}
		if grant == nil || grant.ID != server.Stdio.GrantID || grant.Revision != server.Stdio.GrantRevision {
			return nil, problem(409, "execution-grant-changed", "MCP 容器授权修订不符")
		}
	}
	id := server.ID
	if scope := mcp.Scope(ctx); scope != "" {
		id = scope
	}
	return e.OpenStdio(ctx, StdioRequest{ID: id, Profile: defaultProfile(server.Stdio.Image), Grant: grant, Command: server.Stdio.Command, Environment: server.Stdio.Environment, ServerID: server.ID, ServerRevision: server.Revision})
}
func (e *Executor) OpenStdio(ctx context.Context, request StdioRequest) (*Process, error) {
	return e.start(ctx, request.ID, request.Profile, request.Grant, frame{Kind: "start", Mode: "stdio", Command: request.Command, Environment: request.Environment, serverID: request.ServerID, serverRevision: request.ServerRevision}, nil, nil, nil)
}

func (e *Executor) start(ctx context.Context, id string, p config.Profile, grant *config.Grant, start frame, skill, workspace io.Reader, output io.Writer) (*Process, error) {
	if !identityPattern.MatchString(id) {
		return nil, problem(400, "execution-id", "执行编号无效")
	}
	if e.options.Authorize != nil {
		authorizationID := id
		if start.Mode == "stdio" && start.serverID != "" && e.options.MCPDispatchID != nil {
			authorizationID = e.options.MCPDispatchID(ctx)
		}
		if authorizationID == "" {
			return nil, problem(403, "execution-authorization", "MCP 执行缺少匹配的单次派发身份")
		}
		if err := e.options.Authorize(ctx, authorizationID); err != nil {
			return nil, problem(403, "execution-authorization", "执行缺少匹配的一次性派发授权")
		}
	}
	if err := validateProfile(p); err != nil {
		return nil, err
	}
	if p.ID != "" && e.options.ResolveProfile != nil {
		latest, err := e.options.ResolveProfile(p.ID, 0)
		if err != nil || latest == nil || latest.ID != p.ID || !latest.Enabled {
			return nil, problem(403, "execution-profile-disabled", "执行配置已停用，不能用于新的操作")
		}
	}
	if err := validateCommand(start.Command, start.Environment); err != nil {
		return nil, err
	}
	// 停用是紧急切断语义：停用只追加 Enabled=false 的新修订，固定修订快照本身仍为启用，
	// 必须回查配置里的最新修订，禁止停用授权继续挂载业务目录或启动执行容器。
	if grant != nil && !grant.Enabled {
		return nil, problem(403, "execution-grant-disabled", "执行授权已停用，不能用于新的操作")
	}
	if grant != nil && e.options.ResolveGrant != nil {
		if latest, err := e.options.ResolveGrant(grant.ID, 0); err != nil || latest == nil || latest.ID != grant.ID || !latest.Enabled {
			return nil, problem(403, "execution-grant-disabled", "执行授权已停用，不能用于新的操作")
		}
	}
	binds, err := e.binds(grant)
	if err != nil {
		return nil, err
	}
	if grant != nil {
		copied := *grant
		copied.Directories = append([]config.Directory(nil), grant.Directories...)
		copied.Network = append([]config.NetworkEndpoint(nil), grant.Network...)
		copied.PrivateCIDRs = append([]string(nil), grant.PrivateCIDRs...)
		copied.Resources = append([]config.Resource(nil), grant.Resources...)
		grant = &copied
	}
	e.mu.Lock()
	closed := e.closed
	revoked := e.revokedSource(grant, start.serverID, start.serverRevision)
	e.mu.Unlock()
	if closed {
		return nil, problem(503, "execution-closed", "执行器已关闭")
	}
	if revoked {
		return nil, problem(403, "execution-revoked", "执行授权或 MCP 服务已撤销")
	}
	baseContext := ctx
	if start.Mode == "stdio" {
		baseContext = e.lifetime
	}
	rctx, cancel := context.WithTimeout(baseContext, timeoutFor(p))
	stopStartup := context.AfterFunc(ctx, cancel)
	defer stopStartup()
	accepted := false
	defer func() {
		if !accepted {
			cancel()
		}
	}()
	labels := map[string]string{"elysian.agent.execution": "true", "elysian.agent.execution.id": id}
	if start.serverID != "" {
		labels["elysian.agent.execution.server-id"] = start.serverID
		labels["elysian.agent.execution.server-revision"] = strconv.Itoa(start.serverRevision)
	}
	var image struct {
		OS     string `json:"Os"`
		Config struct{ Volumes map[string]any }
	}
	if err = e.call(rctx, "GET", "/images/"+url.PathEscape(p.Image)+"/json", nil, &image); err != nil {
		return nil, err
	}
	if image.OS != "linux" || len(image.Config.Volumes) > 0 {
		return nil, problem(400, "execution-image", "执行镜像必须为 Linux 镜像且不能声明额外可写卷")
	}
	body := map[string]any{"Image": p.Image, "User": "65532:65532", "WorkingDir": "/workspace", "Entrypoint": []string{"/bundle/elysian/supervisor"}, "Cmd": []string{"agent-exec-supervisor"}, "Env": []string{"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/tmp", "TMPDIR=/tmp"}, "Labels": labels, "OpenStdin": true, "StdinOnce": false, "AttachStdin": true, "AttachStdout": true, "AttachStderr": true, "Tty": false, "StopSignal": "SIGKILL", "HostConfig": map[string]any{"NetworkMode": "none", "ReadonlyRootfs": true, "Privileged": false, "CapDrop": []string{"ALL"}, "SecurityOpt": []string{"no-new-privileges:true"}, "Memory": p.MemoryBytes, "MemorySwap": p.MemoryBytes, "NanoCpus": int64(p.CPUMillis) * 1000000, "PidsLimit": p.PIDs, "Binds": binds, "Tmpfs": map[string]string{"/tmp": "rw,nosuid,nodev,noexec,size=67108864,mode=1777", "/workspace": "rw,nosuid,nodev,size=134217728,mode=0700,uid=65532,gid=65532"}, "RestartPolicy": map[string]string{"Name": "no"}, "LogConfig": map[string]string{"Type": "none"}}}
	body["Healthcheck"] = map[string]any{"Test": []string{"NONE"}}
	if start.Mode == "stdio" {
		body["WorkingDir"] = "/tmp"
		delete(body["HostConfig"].(map[string]any)["Tmpfs"].(map[string]string), "/workspace")
	}
	volume, err := e.prepareBundle(rctx, id, p.Image, labels, skill, workspace)
	if err != nil {
		return nil, err
	}
	volumeCleanup := func() error {
		cctx, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		return e.removeVolume(cctx, volume, id)
	}
	body["HostConfig"].(map[string]any)["Mounts"] = []any{map[string]any{"Type": "volume", "Source": volume, "Target": "/bundle", "ReadOnly": true, "VolumeOptions": map[string]bool{"NoCopy": true}}}
	var created struct {
		ID string `json:"Id"`
	}
	if err = e.call(rctx, "POST", "/containers/create", body, &created); err != nil {
		if volumeCleanup() != nil {
			return nil, stopError()
		}
		return nil, err
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(created.ID) {
		_ = volumeCleanup()
		return nil, stopError()
	}
	cleanup := func() error {
		cctx, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		if err := e.remove(cctx, created.ID, id); err != nil {
			return err
		}
		return e.removeVolume(cctx, volume, id)
	}
	conn, reader, err := e.attach(rctx, created.ID)
	if err != nil {
		if cleanup() != nil {
			return nil, stopError()
		}
		return nil, err
	}
	process := newProcess(e, rctx, cancel, created.ID, id, conn, reader, grant, output)
	process.volume = volume
	// Runtime identity is immutable after publishing to active under e.mu.
	process.serverID = start.serverID
	process.serverRevision = start.serverRevision
	e.mu.Lock()
	if e.closed || e.revokedSource(grant, start.serverID, start.serverRevision) {
		e.mu.Unlock()
		conn.Close()
		if cleanup() != nil {
			return nil, stopError()
		}
		return nil, problem(503, "execution-closed", "执行器已关闭")
	}
	e.active[created.ID] = process
	e.mu.Unlock()
	go process.read()
	if err = e.call(rctx, "POST", "/containers/"+created.ID+"/start", nil, nil); err != nil {
		if process.Close(context.Background()) != nil {
			return nil, stopError()
		}
		return nil, err
	}
	if err = process.send(start); err != nil {
		if process.Close(context.Background()) != nil {
			return nil, stopError()
		}
		return nil, err
	}
	if !stopStartup() || ctx.Err() != nil {
		if process.Close(context.Background()) != nil {
			return nil, stopError()
		}
		return nil, problem(499, "execution-cancelled", "执行容器启动已取消")
	}
	go func() {
		select {
		case <-rctx.Done():
			cctx, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			_ = process.Close(cctx)
		case <-process.done:
		}
	}()
	accepted = true
	return process, nil
}

func (e *Executor) attach(ctx context.Context, id string) (net.Conn, *bufio.Reader, error) {
	conn, err := (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "unix", e.options.SocketPath)
	if err != nil {
		return nil, nil, engineError()
	}
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	req, _ := http.NewRequest("POST", "http://docker/v1.41/containers/"+id+"/attach?stream=1&stdin=1&stdout=1&stderr=1", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "tcp")
	if err = req.Write(conn); err != nil {
		conn.Close()
		return nil, nil, engineError()
	}
	reader := bufio.NewReader(conn)
	resp, err := http.ReadResponse(reader, req)
	if err != nil || (resp.StatusCode != 101 && resp.StatusCode != 200) {
		conn.Close()
		return nil, nil, engineError()
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, reader, nil
}
func (e *Executor) remove(ctx context.Context, id, identity string) error {
	var inspect struct {
		ID     string `json:"Id"`
		Config struct{ Labels map[string]string }
		State  struct{ Running bool }
	}
	if err := e.call(ctx, "GET", "/containers/"+id+"/json", nil, &inspect); err != nil {
		return stopError()
	}
	if inspect.ID != id || inspect.Config.Labels["elysian.agent.execution"] != "true" || inspect.Config.Labels["elysian.agent.execution.id"] != identity {
		return stopError()
	}
	if err := e.call(ctx, "DELETE", "/containers/"+id+"?force=1&v=1", nil, nil); err != nil {
		return stopError()
	}
	resp, err := e.request(ctx, "GET", "/containers/"+id+"/json", nil, "")
	if err != nil {
		return stopError()
	}
	defer resp.Body.Close()
	if resp.StatusCode != 404 {
		return stopError()
	}
	return nil
}
func (e *Executor) Close(ctx context.Context) error {
	e.mu.Lock()
	e.closed = true
	e.stop()
	active := make([]*Process, 0, len(e.active))
	for _, p := range e.active {
		active = append(active, p)
	}
	e.mu.Unlock()
	var first error
	for _, p := range active {
		if err := p.Close(ctx); err != nil && first == nil {
			first = err
		}
	}
	if t, ok := e.client.Transport.(*http.Transport); ok {
		t.CloseIdleConnections()
	}
	return first
}

func (e *Executor) binds(grant *config.Grant) ([]string, error) {
	result := []string{}
	if grant == nil {
		return result, nil
	}
	if err := config.ValidateGrant(*grant, e.options.MountRoot); err != nil {
		return nil, err
	}
	if len(grant.Directories) > 16 {
		return nil, problem(400, "execution-grant", "目录授权数量超过上限")
	}
	root := filepath.Clean(e.options.MountRoot)
	for i, d := range grant.Directories {
		clean := filepath.Clean(d.Path)
		rel, err := filepath.Rel(root, clean)
		if root == "." || !filepath.IsAbs(root) || !filepath.IsAbs(clean) || err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) || strings.ContainsAny(clean, ":\x00") || (d.Access != "ro" && d.Access != "rw") {
			return nil, problem(400, "execution-directory", "执行目录必须是挂载根下明确授权的业务子目录")
		}
		resolved, err := filepath.EvalSymlinks(clean)
		if err != nil || resolved != clean {
			return nil, problem(400, "execution-directory", "执行目录不可访问或包含符号链接")
		}
		info, err := os.Stat(clean)
		if err != nil || !info.IsDir() {
			return nil, problem(400, "execution-directory", "执行目录必须已存在")
		}
		if err := validateGrantDirectory(clean); err != nil {
			return nil, problem(400, "execution-directory", err.Error())
		}
		result = append(result, clean+":/grants/"+strconv.Itoa(i)+":"+d.Access+",rprivate")
	}
	return result, nil
}

var _ mcp.DuplexFactory = (*Executor)(nil)
