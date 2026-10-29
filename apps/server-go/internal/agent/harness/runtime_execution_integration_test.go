package harness

import (
	"archive/tar"
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/execution"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/tools"
)

type runtimeIntegrationEngine struct {
	mu          sync.Mutex
	pulls       int
	installed   bool
	pullFailure string
	creates     []map[string]any
	labels      map[string]map[string]string
	volumes     map[string]map[string]string
	command     []string
	image       string
}

func (f *runtimeIntegrationEngine) serve(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/v1.41")
	switch {
	case path == "/info":
		_ = json.NewEncoder(w).Encode(map[string]string{"OSType": "linux", "Architecture": "amd64"})
		return
	case strings.HasPrefix(path, "/distribution/"):
		_ = json.NewEncoder(w).Encode(map[string]any{"Descriptor": map[string]string{"Digest": strings.Split(f.image, "@")[1]}, "Platforms": []any{map[string]string{"os": "linux", "architecture": "amd64"}}})
		return
	case path == "/images/create":
		if r.URL.Query().Get("fromImage") != f.image || r.URL.Query().Get("platform") != "linux/amd64" {
			w.WriteHeader(400)
			return
		}
		f.mu.Lock()
		f.pulls++
		failure := f.pullFailure
		if failure == "" {
			f.installed = true
		}
		f.mu.Unlock()
		if failure == "failed" {
			w.WriteHeader(502)
			return
		}
		if failure == "unknown" {
			_, _ = io.WriteString(w, "invalid-response\n")
			return
		}
		_, _ = io.WriteString(w, "{\"id\":\"layer\",\"progressDetail\":{\"current\":4,\"total\":4}}\n")
		return
	case strings.HasPrefix(path, "/images/"):
		f.mu.Lock()
		installed := f.installed
		f.mu.Unlock()
		if !installed {
			w.WriteHeader(404)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Os": "linux", "Architecture": "amd64", "RepoDigests": []string{f.image}, "Config": map[string]any{}})
		return
	case path == "/volumes/create":
		var in struct {
			Name   string
			Labels map[string]string
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		f.volumes[in.Name] = in.Labels
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"Name": in.Name})
		return
	case strings.HasPrefix(path, "/volumes/"):
		name := strings.TrimPrefix(path, "/volumes/")
		f.mu.Lock()
		labels, ok := f.volumes[name]
		if r.Method == "DELETE" {
			delete(f.volumes, name)
		}
		f.mu.Unlock()
		if !ok {
			w.WriteHeader(404)
			return
		}
		if r.Method == "DELETE" {
			w.WriteHeader(204)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"Name": name, "Labels": labels})
		return
	case path == "/containers/create":
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		f.creates = append(f.creates, in)
		id := fmt.Sprintf("%064x", len(f.creates))
		labels := map[string]string{}
		for k, v := range in["Labels"].(map[string]any) {
			labels[k] = v.(string)
		}
		f.labels[id] = labels
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]string{"Id": id})
		return
	}
	if !strings.HasPrefix(path, "/containers/") {
		w.WriteHeader(404)
		return
	}
	parts := strings.Split(strings.TrimPrefix(path, "/containers/"), "/")
	id := parts[0]
	f.mu.Lock()
	labels, exists := f.labels[id]
	if r.Method == "DELETE" {
		delete(f.labels, id)
	}
	f.mu.Unlock()
	if !exists {
		w.WriteHeader(404)
		return
	}
	if r.Method == "DELETE" {
		w.WriteHeader(204)
		return
	}
	if len(parts) < 2 {
		w.WriteHeader(404)
		return
	}
	switch parts[1] {
	case "json":
		_ = json.NewEncoder(w).Encode(map[string]any{"Id": id, "Config": map[string]any{"Labels": labels}, "State": map[string]bool{"Running": false}})
	case "archive":
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	case "start":
		w.WriteHeader(204)
	case "attach":
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n")
		_ = rw.Flush()
		go func() {
			defer conn.Close()
			scanner := bufio.NewScanner(rw)
			for scanner.Scan() {
				var start struct {
					Kind    string
					Command []string
				}
				if json.Unmarshal(scanner.Bytes(), &start) != nil {
					return
				}
				if start.Kind != "start" {
					continue
				}
				f.mu.Lock()
				f.command = append([]string{}, start.Command...)
				f.mu.Unlock()
				var archive bytes.Buffer
				tw := tar.NewWriter(&archive)
				_ = tw.Close()
				for _, frame := range []map[string]any{{"kind": "stdout", "data": []byte("runtime-approved\n")}, {"kind": "workspace", "data": archive.Bytes()}, {"kind": "exit", "exitCode": 0}} {
					raw, _ := json.Marshal(frame)
					raw = append(raw, '\n')
					var header [8]byte
					header[0] = 1
					binary.BigEndian.PutUint32(header[4:], uint32(len(raw)))
					if _, err = conn.Write(header[:]); err != nil {
						return
					}
					if _, err = conn.Write(raw); err != nil {
						return
					}
				}
				return
			}
		}()
	default:
		w.WriteHeader(404)
	}
}

func newRuntimeIntegration(t *testing.T, installed bool, pullFailure string) (*Manager, Session, *runtimeIntegrationEngine, *atomic.Value) {
	t.Helper()
	root := t.TempDir()
	socket := filepath.Join(root, "engine.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	fake := &runtimeIntegrationEngine{installed: installed, pullFailure: pullFailure, labels: map[string]map[string]string{}, volumes: map[string]map[string]string{}, image: "docker.io/library/bash@sha256:" + strings.Repeat("a", 64)}
	server := &http.Server{Handler: http.HandlerFunc(fake.serve)}
	go server.Serve(listener)
	t.Cleanup(func() { _ = server.Close() })
	binaryPath := filepath.Join(root, "supervisor")
	if err = os.WriteFile(binaryPath, []byte("\x7fELF-fixture"), 0700); err != nil {
		t.Fatal(err)
	}
	executor, err := execution.New(execution.Options{SocketPath: socket, SupervisorPath: binaryPath, MountRoot: root, Authorize: tools.ConsumeBackend, MCPDispatchID: tools.DispatchID, ResolveRuntimeAuthorization: RuntimeExecutionAuthorization})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = executor.Close(context.Background()) })
	files, err := workspace.Open(filepath.Join(root, "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	extensions := &Extensions{Executor: executor, Workspaces: files, MountRoot: root}
	var calls atomic.Int32
	args := &atomic.Value{}
	args.Store(`{"command":"printf runtime-approved"}`)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if missingOperationTools(r, BashExec) {
			return searchReply("Bash"), nil
		}
		if calls.Add(1)%2 == 0 {
			return finalReply("已完成受限 Bash 执行"), nil
		}
		return model.Response{FinishReason: "tool_calls", ToolCalls: []model.ToolCall{{ID: "bash-one", Name: BashExec, Arguments: json.RawMessage(args.Load().(string))}}}, nil
	}, func(d *Deps) { d.Catalog = extensions; d.Workspaces = files })
	return m, session, fake, args
}

func TestRuntimeExecutionFullApprovalDownloadAndDispatchBinding(t *testing.T) {
	m, session, fake, _ := newRuntimeIntegration(t, false, "")
	run := submitDemand(t, m, session, "runtime-full-flow")
	approval := waitingApproval(t, m, run.ID)
	if approval.Access == nil || approval.Access.Runtime == nil || !approval.Access.Runtime.RequiresDownload || approval.Operation.Execution == nil {
		t.Fatalf("approval lacks exact runtime proposal: %+v", approval)
	}
	fake.mu.Lock()
	beforePull, beforeCreate := fake.pulls, len(fake.creates)
	fake.mu.Unlock()
	if beforePull != 0 || beforeCreate != 0 {
		t.Fatal("runtime mutated Docker before confirmation")
	}
	if _, err := m.DecideAccess(context.Background(), approval.ID, accessInput(approval, "once", "runtime-approve")); err != nil {
		t.Fatal(err)
	}
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("runtime flow failed: %+v", finished)
	}
	operations, err := m.Operations(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var executed *Operation
	for i := range operations {
		if operations[i].Capability.Name == BashExec {
			executed = &operations[i]
		}
	}
	if executed == nil || executed.Status != "completed" || executed.Authorization == nil {
		t.Fatalf("runtime operation not completed: %+v", operations)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	want := []string{"bash", "--noprofile", "--norc", "-c", "printf runtime-approved", "elysian-command"}
	if fake.pulls != 1 || len(fake.creates) != 2 || !reflect.DeepEqual(fake.command, want) {
		t.Fatalf("approval not bound to real executor: pulls=%d creates=%d command=%v", fake.pulls, len(fake.creates), fake.command)
	}
	cfg := fake.creates[1]["HostConfig"].(map[string]any)
	if cfg["NanoCpus"] != float64(500000000) || cfg["Memory"] != float64(256<<20) || cfg["PidsLimit"] != float64(64) || cfg["NetworkMode"] != "none" || cfg["ReadonlyRootfs"] != true {
		t.Fatalf("runtime isolation changed: %+v", cfg)
	}
}

func TestRuntimeExecutionRetriesFailedPreparationOnlyAfterNewDecision(t *testing.T) {
	m, session, fake, _ := newRuntimeIntegration(t, false, "failed")
	run := submitDemand(t, m, session, "runtime-fail-first")
	first := waitingApproval(t, m, run.ID)
	if _, err := m.DecideAccess(context.Background(), first.ID, accessInput(first, "once", "allow-failing-download")); err != nil {
		t.Fatal(err)
	}
	second := waitingApproval(t, m, run.ID)
	if second.ID == first.ID || second.Access.Revision <= first.Access.Revision || second.Operation.Preparation == nil || second.Operation.Preparation.State != "failed" {
		t.Fatalf("failed preparation did not request new confirmation: %+v", second)
	}
	fake.mu.Lock()
	pulls, creates := fake.pulls, len(fake.creates)
	fake.pullFailure = ""
	fake.mu.Unlock()
	if pulls != 1 || creates != 0 {
		t.Fatalf("failed preparation replayed or dispatched: pulls=%d creates=%d", pulls, creates)
	}
	if _, err := m.DecideAccess(context.Background(), second.ID, accessInput(second, "once", "allow-retry-download")); err != nil {
		t.Fatal(err)
	}
	if finished := runtimeFinished(t, m, run.ID); finished.Status != StateSucceeded {
		t.Fatalf("confirmed retry failed: %+v", finished)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.pulls != 2 || len(fake.creates) != 2 {
		t.Fatalf("retry did not dispatch once: pulls=%d creates=%d", fake.pulls, len(fake.creates))
	}
}

func TestRuntimeExecutionUnknownPreparationOnlyInspectsUntilConfirmedInstalled(t *testing.T) {
	m, session, fake, _ := newRuntimeIntegration(t, false, "unknown")
	run := submitDemand(t, m, session, "runtime-unknown")
	first := waitingApproval(t, m, run.ID)
	if _, err := m.DecideAccess(context.Background(), first.ID, accessInput(first, "once", "allow-unknown-download")); err != nil {
		t.Fatal(err)
	}
	second := waitingApproval(t, m, run.ID)
	if second.ID == first.ID || second.Operation.Preparation == nil || second.Operation.Preparation.State != "unknown" {
		t.Fatalf("unknown pull did not pause: %+v", second)
	}
	if _, err := m.DecideAccess(context.Background(), second.ID, accessInput(second, "once", "inspect-still-missing")); err != nil {
		t.Fatal(err)
	}
	third := waitingApproval(t, m, run.ID)
	if third.ID == second.ID || third.Operation.Preparation == nil || third.Operation.Preparation.State != "unknown" {
		t.Fatalf("missing image lost unknown state: %+v", third)
	}
	fake.mu.Lock()
	pulls, creates := fake.pulls, len(fake.creates)
	fake.installed = true
	fake.pullFailure = ""
	fake.mu.Unlock()
	if pulls != 1 || creates != 0 {
		t.Fatalf("unknown pull was replayed: pulls=%d creates=%d", pulls, creates)
	}
	if _, err := m.DecideAccess(context.Background(), third.ID, accessInput(third, "once", "inspect-now-installed")); err != nil {
		t.Fatal(err)
	}
	if finished := runtimeFinished(t, m, run.ID); finished.Status != StateSucceeded {
		t.Fatalf("verified local image did not resume: %+v", finished)
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.pulls != 1 || len(fake.creates) != 2 {
		t.Fatalf("readback resume downloaded again: pulls=%d creates=%d", fake.pulls, len(fake.creates))
	}
}

func TestRuntimeExecutionEveryNewRunConfirmsDownloadAndScope(t *testing.T) {
	m, session, fake, args := newRuntimeIntegration(t, true, "")
	first := submitDemand(t, m, session, "runtime-local-first")
	a := waitingApproval(t, m, first.ID)
	if a.Access.Runtime.RequiresDownload {
		t.Fatal("installed environment requested download")
	}
	if _, err := m.DecideAccess(context.Background(), a.ID, accessInput(a, "once", "allow-installed-session")); err != nil {
		t.Fatal(err)
	}
	if finished := runtimeFinished(t, m, first.ID); finished.Status != StateSucceeded {
		t.Fatalf("first run failed: %+v", finished)
	}
	second := submitDemand(t, m, session, "runtime-local-reuse")
	secondApproval := waitingApproval(t, m, second.ID)
	if _, err := m.DecideAccess(context.Background(), secondApproval.ID, accessInput(secondApproval, "once", "second-once")); err != nil {
		t.Fatal(err)
	}
	if finished := runtimeFinished(t, m, second.ID); finished.Status != StateSucceeded {
		t.Fatalf("second run approval failed: %+v", finished)
	}
	fake.mu.Lock()
	fake.installed = false
	pulls, creates := fake.pulls, len(fake.creates)
	fake.mu.Unlock()
	if pulls != 0 || creates != 4 {
		t.Fatalf("per-run confirmation wrong: pulls=%d creates=%d", pulls, creates)
	}
	third := submitDemand(t, m, session, "runtime-local-disappeared")
	missing := waitingApproval(t, m, third.ID)
	if missing.Access.Runtime == nil || !missing.Access.Runtime.RequiresDownload {
		t.Fatalf("disappeared local image failed to ask permission to download: %+v", missing)
	}
	fake.mu.Lock()
	pulls = fake.pulls
	fake.mu.Unlock()
	if pulls != 0 {
		t.Fatal("download happened under per-run confirmation")
	}
	if _, err := m.DecideAccess(context.Background(), missing.ID, accessInput(missing, "once", "allow-missing-image-download")); err != nil {
		t.Fatal(err)
	}
	if finished := runtimeFinished(t, m, third.ID); finished.Status != StateSucceeded {
		t.Fatalf("download confirmation failed: %+v", finished)
	}
	args.Store(`{"command":"printf runtime-approved","access":{"network":[{"scheme":"https","host":"api.example.com","port":443}]}}`)
	fourth := submitDemand(t, m, session, "runtime-new-network")
	newScope := waitingApproval(t, m, fourth.ID)
	if len(newScope.Access.Network) != 1 || newScope.Access.ScopeKey == a.Access.ScopeKey {
		t.Fatal("expanded network scope reused existing grant")
	}
	if _, err := m.Cancel(context.Background(), fourth.ID); err != nil {
		t.Fatal(err)
	}
}

func TestRuntimeExecutionModesAutomaticallyPrepareIsolatedEnvironment(t *testing.T) {
	for _, mode := range []PermissionMode{PermissionAssist, PermissionFull} {
		t.Run(string(mode), func(t *testing.T) {
			m, session, engine, _ := newRuntimeIntegration(t, false, "")
			run, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "automatic-runtime-" + string(mode), Content: "执行隔离命令", AuthorizationMode: AuthorizationOnDemand, PermissionMode: mode})
			if err != nil {
				t.Fatal(err)
			}
			if done := runtimeFinished(t, m, run.ID); done.Status != StateSucceeded {
				t.Fatalf("自动准备执行失败: %+v", done)
			}
			approvals, err := m.Approvals(context.Background())
			if err != nil || len(approvals) != 0 {
				t.Fatalf("自动模式仍需批准: %+v %v", approvals, err)
			}
			engine.mu.Lock()
			defer engine.mu.Unlock()
			if engine.pulls != 1 || len(engine.creates) != 2 {
				t.Fatalf("未实际准备并运行环境: pulls=%d creates=%d", engine.pulls, len(engine.creates))
			}
		})
	}
}
