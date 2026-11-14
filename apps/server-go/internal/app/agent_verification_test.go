package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
	"elysian/server/internal/config"
	"elysian/server/internal/docker"
	"elysian/server/internal/seam"
)

func verificationContainerFacade(t *testing.T, root string) *docker.AgentFacade {
	t.Helper()
	socketRoot, err := os.MkdirTemp("", "ely-v-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketRoot) })
	socket := filepath.Join(socketRoot, "docker.sock")
	listener, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.TrimPrefix(r.URL.Path, seam.EngineAPIPrefix) == "/version" {
			_, _ = w.Write([]byte(`{"ApiVersion":"1.44"}`))
			return
		}
		_, _ = w.Write([]byte("[]"))
	}))
	_ = server.Listener.Close()
	server.Listener = listener
	server.Start()
	t.Cleanup(server.Close)
	stack, err := docker.Assemble(docker.Deps{Mode: config.ModeBareMetal, SocketPath: socket, AgentOperationRoot: root})
	if err != nil || stack.Agent == nil {
		t.Fatalf("verification fixture unavailable: %v", err)
	}
	t.Cleanup(func() { _ = stack.Agent.Close(context.Background()) })
	return stack.Agent
}

func TestAgentVerifierBindsUnacceptedNumericServiceRequest(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tasks")
	containers := verificationContainerFacade(t, root)
	requestID := strings.Repeat("a", 64)
	v := tools.TaskVerification{OperationID: "operation", DispatchID: "dispatch", Tool: "docker_container_create_service", Task: tools.TaskReference{Domain: docker.ContainerOperationDomain, RequestID: requestID}, ArgumentsJSON: `{"name":"mysql84","port":3306.0,"hostPort":3.306e3,"requestId":"` + requestID + `"}`}
	verify := agentTaskVerifier(containers)
	ref, err := verify(context.Background(), v)
	if err != nil || ref.ID == "" || ref.Target != "name:mysql84" || ref.Digest == "" {
		t.Fatalf("missing bound receipt: %+v %v", ref, err)
	}
	again, err := verify(context.Background(), v)
	if err != nil || again != ref {
		t.Fatal("verification not idempotent")
	}
	status, err := agentTaskInspector(nil, nil, containers, nil)(context.Background(), ref)
	if err != nil || status.EffectiveOutcome() != tools.TaskFailed || status.Evidence == nil || status.Evidence.Execution != "not-started" {
		t.Fatalf("unsafe non-acceptance proof: %+v %v", status, err)
	}
}

func TestAgentExecObservationRetainsProtectionForPossiblePartialChanges(t *testing.T) {
	for _, exitCode := range []int{0, 1} {
		root := filepath.Join(t.TempDir(), "tasks")
		if err := os.MkdirAll(root, 0700); err != nil {
			t.Fatal(err)
		}
		requestID, target, execID, digest := strings.Repeat("b", 64), strings.Repeat("c", 64), strings.Repeat("e", 64), strings.Repeat("d", 64)
		hash := sha256.Sum256([]byte(docker.ContainerOperationDomain + ":" + requestID))
		id := hex.EncodeToString(hash[:])
		task := docker.ContainerOperationTask{ID: id, RequestID: requestID, Target: target, Digest: digest, State: "unknown", ExecID: execID, ExecObservedRunning: true, Observation: &docker.ContainerOperationObservation{TaskID: id, RequestID: requestID, Target: target, Digest: digest, ExecID: execID, ExitCode: exitCode, ObservedAt: "observed"}}
		if err := config.AtomicJSON(filepath.Join(root, id+".json"), task); err != nil {
			t.Fatal(err)
		}
		containers := verificationContainerFacade(t, root)
		status, err := agentTaskInspector(nil, nil, containers, nil)(context.Background(), tools.TaskReference{Domain: docker.ContainerOperationDomain, ID: id, RequestID: requestID, Target: target, Digest: digest})
		want := tools.TaskSucceeded
		if exitCode != 0 {
			want = tools.TaskUnknown
		}
		if err != nil || status.EffectiveOutcome() != want || status.Evidence == nil || status.Evidence.Changes != "unknown" {
			t.Fatalf("exit=%d status=%+v error=%v", exitCode, status, err)
		}
	}
}
