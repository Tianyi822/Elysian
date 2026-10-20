package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/execution"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

type probeFactory func(context.Context, mcp.Server) (mcp.Duplex, error)

func (f probeFactory) Open(ctx context.Context, s mcp.Server) (mcp.Duplex, error) { return f(ctx, s) }

type probeDuplex struct {
	inR, outR, errR *io.PipeReader
	inW, outW, errW *io.PipeWriter
	once            sync.Once
	closed          atomic.Int32
	unknown         bool
}

func (d *probeDuplex) Stdin() io.WriteCloser { return d.inW }
func (d *probeDuplex) Stdout() io.ReadCloser { return d.outR }
func (d *probeDuplex) Stderr() io.ReadCloser { return d.errR }
func (d *probeDuplex) Identity() string      { return strings.Repeat("a", 64) }
func (d *probeDuplex) Close(context.Context) error {
	d.closed.Add(1)
	d.once.Do(func() {
		_ = d.inR.Close()
		_ = d.inW.Close()
		_ = d.outR.Close()
		_ = d.outW.Close()
		_ = d.errR.Close()
		_ = d.errW.Close()
	})
	if d.unknown {
		return errors.New("unconfirmed stop")
	}
	return nil
}
func newProbeDuplex() *probeDuplex {
	d := &probeDuplex{}
	d.inR, d.inW = io.Pipe()
	d.outR, d.outW = io.Pipe()
	d.errR, d.errW = io.Pipe()
	go func() {
		decoder := json.NewDecoder(d.inR)
		for {
			var req struct {
				ID     string `json:"id"`
				Method string `json:"method"`
			}
			if decoder.Decode(&req) != nil {
				return
			}
			if req.ID == "" {
				continue
			}
			result := map[string]any{"protocolVersion": mcp.ProtocolVersion, "capabilities": map[string]any{}, "serverInfo": map[string]string{"name": "probe-fixture", "version": "1"}}
			if json.NewEncoder(d.outW).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result}) != nil {
				return
			}
		}
	}()
	return d
}

func probeManager(t *testing.T, factory probeFactory) (*Manager, *Extensions, mcp.Server) {
	t.Helper()
	store, err := mcp.Open(filepath.Join(t.TempDir(), "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := store.Create(mcp.Input{Name: "探测验收", Transport: "stdio", Active: true, Stdio: &mcp.ContainerInput{Image: "test@sha256:" + strings.Repeat("a", 64), Command: []string{"python", "-c", "pass"}}})
	if err != nil {
		t.Fatal(err)
	}
	e := &Extensions{Servers: store, MCP: mcp.NewClient(nil, factory)}
	t.Cleanup(func() { _ = e.MCP.Close(context.Background()) })
	m, _, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = e })
	return m, e, server
}

func TestProbeLifecycleLocksBeforeStartupAndClosesBeforeCatalogPublication(t *testing.T) {
	var m *Manager
	var observedScope string
	d := newProbeDuplex()
	var e *Extensions
	var server mcp.Server
	m, e, server = probeManager(t, func(ctx context.Context, _ mcp.Server) (mcp.Duplex, error) {
		observedScope = mcp.Scope(ctx)
		leases, err := m.ResourceLeases(ctx)
		if err != nil || len(leases) != 1 || leases[0].State != "held" || leases[0].ScopeID != observedScope || observedScope == "" {
			t.Errorf("probe started without persistent scope lease: %+v %v", leases, err)
		}
		if err := tools.ConsumeBackend(ctx, observedScope); err != nil {
			t.Errorf("probe was not admitted by the managed registry: %v", err)
		}
		return d, nil
	})
	response := runtimeRouteRequest(m.Router(), http.MethodPost, "/mcp-servers/"+server.ID+"/probe", `{"revision":1}`)
	if response.Code != 409 || d.closed.Load() != 0 {
		t.Fatalf("stdio probe bypassed runtime confirmation: %d %s closes=%d", response.Code, response.Body, d.closed.Load())
	}
	if _, err := m.probeServer(context.Background(), e, server); err != nil || d.closed.Load() != 1 {
		t.Fatalf("probe was not closed: %v closes=%d", err, d.closed.Load())
	}
	leases, err := m.ResourceLeases(context.Background())
	if err != nil || len(leases) != 1 || leases[0].State != "released" || leases[0].ContainerID != d.Identity() || leases[0].ServerID != server.ID || leases[0].Source != "mcp-probe" {
		t.Fatalf("missing probe lifecycle: %+v %v", leases, err)
	}
	if e.MCP.StdioIdentity(mcp.WithScope(context.Background(), observedScope), server.ID, 1) != "" {
		t.Fatal("probe left a stdio connection")
	}
	response = runtimeRouteRequest(m.Router(), http.MethodGet, "/resource-leases", "")
	if response.Code != 200 || !strings.Contains(response.Body.String(), observedScope) || !strings.Contains(response.Body.String(), d.Identity()) {
		t.Fatalf("probe lease not inspectable through API: %d %s", response.Code, response.Body)
	}
	if _, err := e.Servers.Catalog(server.ID, 1, ""); err != nil {
		t.Fatal(err)
	}
}

func TestProbeUnknownStopBlocksRestartUntilExplicitLeaseReconciliation(t *testing.T) {
	var opens atomic.Int32
	d := newProbeDuplex()
	d.unknown = true
	m, e, server := probeManager(t, func(context.Context, mcp.Server) (mcp.Duplex, error) { opens.Add(1); return d, nil })
	_, err := m.probeServer(context.Background(), e, server)
	runtimeErrorCode(t, err, "mcp-probe-stop-unconfirmed")
	if _, err := e.Servers.Catalog(server.ID, 1, ""); err == nil {
		t.Fatal("unconfirmed probe published catalog")
	}
	m = reopenOperationManager(t, m)
	_, err = m.probeServer(context.Background(), e, server)
	runtimeErrorCode(t, err, "resource-busy")
	if opens.Load() != 1 {
		t.Fatal("unknown probe started another process")
	}
	leases, err := m.ResourceLeases(context.Background())
	if err != nil || len(leases) != 1 || leases[0].State != "unknown" {
		t.Fatalf("unknown lease lost: %+v %v", leases, err)
	}
	path := "/resource-locks/" + leases[0].ID + "/reconcile"
	invalid := runtimeRouteRequest(m.Router(), http.MethodPost, path, `{"decision":"confirmed-completed","evidence":"catalog complete"}`)
	if invalid.Code != 400 {
		t.Fatalf("accepted non-stop evidence: %d", invalid.Code)
	}
	body := `{"decision":"confirmed-stopped","evidence":"Docker inspect confirms labeled container removed"}`
	for i := 0; i < 2; i++ {
		response := runtimeRouteRequest(m.Router(), http.MethodPost, path, body)
		if response.Code != 200 {
			t.Fatalf("reconciliation failed: %d %s", response.Code, response.Body)
		}
	}
	leases, _ = m.ResourceLeases(context.Background())
	if leases[0].State != "released" || leases[0].Evidence == "" {
		t.Fatal("reconciliation did not retain evidence")
	}
	primary := runtimeRouteRequest(m.Router(), http.MethodGet, "/resource-locks", "")
	alias := runtimeRouteRequest(m.Router(), http.MethodGet, "/resource-leases", "")
	if primary.Code != 200 || alias.Code != 200 || primary.Body.String() != alias.Body.String() {
		t.Fatal("resource lock aliases do not expose the same durable state")
	}
}

func TestProbeConflictingLeaseAndMaintenancePreventAnyStartup(t *testing.T) {
	var opens atomic.Int32
	m, e, server := probeManager(t, func(context.Context, mcp.Server) (mcp.Duplex, error) { opens.Add(1); return newProbeDuplex(), nil })
	ctx := context.Background()
	m.mu.Lock()
	err := m.store.write(ctx, "fixture-lease", func(tx *sql.Tx) error {
		return saveResourceLease(ctx, tx, ResourceLease{ID: "existing", ScopeID: "scope-existing", State: "held", Claims: []ResourceClaim{{Kind: "file", Authority: "host", Key: "/grants/project", Access: "write"}}, CreatedAt: stamp(time.Now())})
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.probeServer(ctx, e, server)
	runtimeErrorCode(t, err, "resource-busy")
	m.mu.Lock()
	m.deps.DispatchGuard = func() error { return &Error{503, "maintenance", "维护期间暂停派发"} }
	m.mu.Unlock()
	_, err = m.probeServer(ctx, e, server)
	runtimeErrorCode(t, err, "maintenance")
	if opens.Load() != 0 {
		t.Fatal("blocked probe started a process")
	}
	leases, err := m.ResourceLeases(ctx)
	if err != nil || len(leases) != 1 {
		t.Fatalf("rejected probe left a waiting lease: %+v %v", leases, err)
	}
}

func TestExecutionRuntimesRouteReturnsEmptyArrayAndHonorsClosedManager(t *testing.T) {
	executor, err := execution.New(execution.Options{SupervisorPath: "/test-supervisor"})
	if err != nil {
		t.Fatal(err)
	}
	defer executor.Close(context.Background())
	m := &Manager{deps: Deps{Catalog: &Extensions{Executor: executor}}}
	response := runtimeRouteRequest(m.Router(), http.MethodGet, "/execution-runtimes", "")
	if response.Code != 200 || strings.TrimSpace(response.Body.String()) != "[]" {
		t.Fatalf("unexpected runtime projection: %d %s", response.Code, response.Body)
	}
	m.closed = true
	response = runtimeRouteRequest(m.Router(), http.MethodGet, "/execution-runtimes", "")
	if response.Code != 503 {
		t.Fatalf("closed manager leaked runtimes: %d", response.Code)
	}
}

func TestProbeRealDockerScopedLifecycle(t *testing.T) {
	image := os.Getenv("ELYSIAN_EXECUTION_TEST_IMAGE")
	if image == "" {
		t.Skip("显式选择已有本地 Python 镜像摘要后运行管理探测容器验收")
	}
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	var authorizations atomic.Int32
	executor, err := execution.New(execution.Options{SupervisorPath: binary, MountRoot: t.TempDir(), Authorize: func(ctx context.Context, id string) error {
		authorizations.Add(1)
		return tools.ConsumeBackend(ctx, id)
	}, MCPDispatchID: tools.DispatchID, ResolveRuntimeAuthorization: RuntimeExecutionAuthorization})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := executor.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	m, e, server := probeManager(t, executor.Open)
	script := `import json,os,pathlib,sys
assert os.getuid() == 65532
assert not pathlib.Path('/var/run/docker.sock').exists()
for line in sys.stdin:
    req=json.loads(line)
    if 'id' not in req: continue
    result={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'real-probe-fixture','version':'1'}}
    if req['method']=='tools/list':
        result={'tools':[{'name':'inspect','description':'Inspect fixture','inputSchema':{'type':'object','properties':{},'additionalProperties':False}}]}
    elif req['method']=='tools/call':
        result={'content':[{'type':'text','text':'real-stdio-call-complete'}]}
    print(json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result}),flush=True)
`
	server, err = e.Servers.Update(server.ID, server.Revision, mcp.Input{Name: server.Name, Transport: "stdio", Active: true, Stdio: &mcp.ContainerInput{Image: image, Command: []string{"python3", "-u", "-c", script}}})
	if err != nil {
		t.Fatal(err)
	}
	e.Executor = executor
	request, err := m.RequestProbeAccess(context.Background(), e, server, "real-probe-request")
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.DecideProbeAccess(context.Background(), e, request.ID, ProbeAccessDecision{RequestID: "real-probe-decision", ExpectedVersion: request.Version, ExpectedDigest: request.Digest, Decision: "allow-once"})
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		request, err = m.ProbeAccess(context.Background(), request.ID)
		if err != nil {
			t.Fatal(err)
		}
		if request.State != "preparing" && request.State != "running" {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if request.State != "completed" {
		t.Fatalf("real scoped probe failed: %+v", request)
	}
	leases, err := m.ResourceLeases(context.Background())
	if err != nil || len(leases) != 1 || leases[0].State != "released" || len(leases[0].ContainerID) != 64 || leases[0].ServerRevision != 2 {
		t.Fatalf("real probe lifecycle missing: %+v %v", leases, err)
	}
	if runtimes := executor.Runtimes(); len(runtimes) != 0 {
		t.Fatalf("real probe left running containers: %+v", runtimes)
	}
	profile := m.deps.Profiles.List()[0]
	session, err := m.CreateSession(context.Background(), CreateSessionInput{Title: "stdio dispatch", ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := e.Servers.Catalog(server.ID, server.Revision, "")
	if err != nil {
		t.Fatal(err)
	}
	alias := capabilityAlias("mcp", server.ID, "inspect")
	var inference atomic.Int32
	m.mu.Lock()
	m.deps.ModelClient = agentTestClient(func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if inference.Add(1) == 1 {
			return toolReply(alias), nil
		}
		raw, _ := json.Marshal(request.Messages)
		if !strings.Contains(string(raw), "real-stdio-call-complete") {
			t.Error("stdio result did not reach the model")
		}
		return finalReply("stdio completed"), nil
	})
	m.mu.Unlock()
	_, err = m.PutEnvironment(context.Background(), session.ID, 0, Environment{Servers: []RevisionRef{{ID: server.ID, Revision: server.Revision, Digest: catalog.Digest}}, Tools: []string{alias}, TrustedReadOnly: []string{alias}})
	if err != nil {
		t.Fatal(err)
	}
	run := submitAgentTest(t, m, session, "stdio-production-gate", "inspect")
	if finished := runtimeFinished(t, m, run.ID); finished.Status != StateSucceeded {
		t.Fatalf("real stdio dispatch failed: %+v", finished)
	}
	operations, err := m.Operations(context.Background(), run.ID)
	if err != nil || len(operations) != 1 || operations[0].Status != "completed" || operations[0].ID == operations[0].DispatchID {
		t.Fatalf("stdio dispatch identity or result invalid: %+v %v", operations, err)
	}
	if authorizations.Load() != 2 {
		t.Fatalf("CheckCatalog and CallTool did not share one authorized process: authorizations=%d", authorizations.Load())
	}
	if runtimes := executor.Runtimes(); len(runtimes) != 0 {
		t.Fatalf("real stdio dispatch left running containers: %+v", runtimes)
	}
}
