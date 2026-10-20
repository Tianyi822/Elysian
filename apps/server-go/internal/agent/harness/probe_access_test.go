package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

func attachProbeRuntime(t *testing.T, e *Extensions, image string) {
	t.Helper()
	root := t.TempDir()
	socket := filepath.Join(root, "engine.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("preinstalled probe image mutated Docker: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(400)
			return
		}
		if r.URL.Path == "/v1.41/info" {
			_ = json.NewEncoder(w).Encode(map[string]string{"OSType": "linux", "Architecture": "amd64"})
			return
		}
		if strings.HasPrefix(r.URL.Path, "/v1.41/images/") {
			_ = json.NewEncoder(w).Encode(map[string]any{"Os": "linux", "Architecture": "amd64", "RepoDigests": []string{image}, "Config": map[string]any{}})
			return
		}
		t.Errorf("unexpected engine read %s", r.URL.Path)
		w.WriteHeader(404)
	})}
	go server.Serve(listener)
	t.Cleanup(func() { _ = server.Close() })
	e.Executor, err = execution.New(execution.Options{SocketPath: socket, SupervisorPath: "/test-supervisor", MountRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = e.Executor.Close(context.Background()) })
}

func waitProbe(t *testing.T, m *Manager, id string) ProbeAccessRequest {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		p, err := m.ProbeAccess(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if p.State != "preparing" && p.State != "running" {
			return p
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("probe did not settle")
	return ProbeAccessRequest{}
}

func TestProbeAccessRequiresDurableOnceConfirmationAndDoesNotReplay(t *testing.T) {
	var opens atomic.Int32
	m, e, server := probeManager(t, func(ctx context.Context, s mcp.Server) (mcp.Duplex, error) {
		opens.Add(1)
		a, err := RuntimeExecutionAuthorization(ctx, tools.DispatchID(ctx))
		if err != nil || a == nil || a.ServerID != s.ID || a.ServerRevision != s.Revision || a.ScopeID != mcp.Scope(ctx) || a.CatalogDigest == "" || a.Grant == nil || a.Grant.ID != "authorization-"+a.ID {
			t.Errorf("probe authorization not isolated: %+v %v", a, err)
		}
		if err := tools.ConsumeBackend(ctx, tools.DispatchID(ctx)); err != nil {
			t.Errorf("backend lacked once ticket: %v", err)
		}
		return newProbeDuplex(), nil
	})
	attachProbeRuntime(t, e, server.Stdio.Image)
	ctx := context.Background()
	p, err := m.RequestProbeAccess(ctx, e, server, "request-one")
	if err != nil {
		t.Fatal(err)
	}
	if p.State != "waiting" || p.Access.SessionAllowed || p.Environment == nil || p.Environment.RequiresDownload || p.Environment.Platform != "linux/amd64" || opens.Load() != 0 {
		t.Fatalf("preflight started a probe: %+v opens=%d", p, opens.Load())
	}
	badDecision := ProbeAccessDecision{RequestID: "decision-one", ExpectedVersion: p.Version, ExpectedDigest: "changed", Decision: "allow-once"}
	_, err = m.DecideProbeAccess(ctx, e, p.ID, badDecision)
	runtimeErrorCode(t, err, "probe-request-changed")
	decision := badDecision
	decision.ExpectedDigest = p.Digest
	accepted, err := m.DecideProbeAccess(ctx, e, p.ID, decision)
	if err != nil || accepted.State != "preparing" {
		t.Fatalf("accept failed: %+v %v", accepted, err)
	}
	settled := waitProbe(t, m, p.ID)
	if settled.State != "completed" || settled.Catalog == nil || opens.Load() != 1 {
		t.Fatalf("probe failed: %+v opens=%d", settled, opens.Load())
	}
	for i := 0; i < 2; i++ {
		again, err := m.DecideProbeAccess(ctx, e, p.ID, decision)
		if err != nil || again.State != "completed" {
			t.Fatalf("decision retry changed result: %+v %v", again, err)
		}
	}
	again, err := m.RequestProbeAccess(ctx, e, server, "request-one")
	if err != nil || again.ID != p.ID || again.State != "completed" || opens.Load() != 1 {
		t.Fatalf("request retry replayed: %+v %v opens=%d", again, err, opens.Load())
	}
	decision.RequestID = "new-decision"
	_, err = m.DecideProbeAccess(ctx, e, p.ID, decision)
	runtimeErrorCode(t, err, "probe-decision-conflict")
}

func TestProbeAccessDenyCancelAndRestartRemainNonExecuting(t *testing.T) {
	var opens atomic.Int32
	m, e, server := probeManager(t, func(context.Context, mcp.Server) (mcp.Duplex, error) { opens.Add(1); return newProbeDuplex(), nil })
	attachProbeRuntime(t, e, server.Stdio.Image)
	ctx := context.Background()
	denied, err := m.RequestProbeAccess(ctx, e, server, "request-deny")
	if err != nil {
		t.Fatal(err)
	}
	denied, err = m.DecideProbeAccess(ctx, e, denied.ID, ProbeAccessDecision{RequestID: "decision-deny", ExpectedVersion: denied.Version, ExpectedDigest: denied.Digest, Decision: "deny"})
	if err != nil || denied.State != "denied" {
		t.Fatalf("denial failed: %+v %v", denied, err)
	}
	p, err := m.RequestProbeAccess(ctx, e, server, "request-cancel")
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := m.CancelProbeAccess(ctx, p.ID, "cancel-once")
	if err != nil || cancelled.State != "cancelled" {
		t.Fatalf("cancel failed: %+v %v", cancelled, err)
	}
	p, err = m.RequestProbeAccess(ctx, e, server, "request-restart")
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	err = m.store.write(ctx, "fixture-probe-interrupted", func(tx *sql.Tx) error {
		lease, err := readProbeLease(ctx, tx, p.ID)
		if err != nil {
			return err
		}
		lease.State = "held"
		lease.Probe.State = "running"
		return saveResourceLease(ctx, tx, lease)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	m = reopenOperationManager(t, m)
	restored, err := m.ProbeAccess(ctx, p.ID)
	if err != nil || restored.State != "unknown" || opens.Load() != 0 {
		t.Fatalf("restart replayed or lost unknown state: %+v %v opens=%d", restored, err, opens.Load())
	}
	_, err = m.DecideProbeAccess(ctx, e, p.ID, ProbeAccessDecision{RequestID: "decision-after-restart", ExpectedVersion: p.Version, ExpectedDigest: p.Digest, Decision: "allow-once"})
	runtimeErrorCode(t, err, "probe-state-conflict")
}

func TestMCPRequestedAccessIsDeclarationAndCannotMixLegacyGrant(t *testing.T) {
	store, err := mcp.Open(filepath.Join(t.TempDir(), "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	scope := &execconfig.AccessScope{Directories: []execconfig.Directory{{Path: "/srv/apps/example", Access: "ro"}}, Network: []execconfig.NetworkEndpoint{{Scheme: "https", Host: "api.example.com", Port: 443}}, PrivateCIDRs: []string{}}
	in := mcp.Input{Name: "声明需求", Transport: "stdio", Active: true, Stdio: &mcp.ContainerInput{Image: "example@sha256:" + strings.Repeat("a", 64), Command: []string{"server"}, RequestedAccess: scope}}
	server, err := store.Create(in)
	if err != nil {
		t.Fatal(err)
	}
	scope.Directories[0].Path = "/srv/apps/changed"
	public := server.Public()
	public.Stdio.RequestedAccess.Directories[0].Path = "/srv/apps/public-mutated"
	stored, err := store.Resolve(server.ID, server.Revision, false)
	if err != nil || stored.Stdio.RequestedAccess.Directories[0].Path != "/srv/apps/example" {
		t.Fatalf("scope aliases input/public mutable slices: %+v %v", stored, err)
	}
	in.Stdio.GrantID = "grant-" + strings.Repeat("b", 32)
	in.Stdio.GrantRevision = 1
	if _, err := store.Create(in); err == nil {
		t.Fatal("mixed runtime and legacy grants accepted")
	}
}
