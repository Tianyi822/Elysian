package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
	"elysian/server/internal/config"
	"elysian/server/internal/database"
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
	verify := agentTaskVerifier(containers, nil)
	ref, err := verify(context.Background(), v)
	if err != nil || ref.ID == "" || ref.Target != "name:mysql84" || ref.Digest == "" {
		t.Fatalf("missing bound receipt: %+v %v", ref, err)
	}
	again, err := verify(context.Background(), v)
	if err != nil || again != ref {
		t.Fatal("verification not idempotent")
	}
	status, err := agentTaskInspector(nil, nil, containers, database.LegacyTaskLedger{}, nil)(context.Background(), ref)
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
		status, err := agentTaskInspector(nil, nil, containers, database.LegacyTaskLedger{}, nil)(context.Background(), tools.TaskReference{Domain: docker.ContainerOperationDomain, ID: id, RequestID: requestID, Target: target, Digest: digest})
		want := tools.TaskSucceeded
		if exitCode != 0 {
			want = tools.TaskUnknown
		}
		if err != nil || status.EffectiveOutcome() != want || status.Evidence == nil || status.Evidence.Changes != "unknown" {
			t.Fatalf("exit=%d status=%+v error=%v", exitCode, status, err)
		}
	}
}

func TestLegacyDatabaseTaskRecoveryUsesPersistedReceipt(t *testing.T) {
	ledger := database.LegacyTaskLedger{StateDir: t.TempDir()}
	requestID := strings.Repeat("a", 64)
	idSum := sha256.Sum256([]byte(requestID))
	id := hex.EncodeToString(idSum[:])
	input := json.RawMessage(`{"action":"create","create":{"id":"new:db","expected":"","engine":"MySQL","versionTag":"8.4","name":"app","imageId":"image","containerName":"db","charset":""},"id":"","expected":""}`)
	digest := sha256.Sum256(input)
	path := filepath.Join(ledger.StateDir, "agent-database-tasks", id+".json")
	record := map[string]any{
		"id": id, "requestId": requestID, "action": "create", "state": "succeeded",
		"result": map[string]string{"id": "registered", "action": "create"}, "registrationId": "registered",
		"input": input, "digest": hex.EncodeToString(digest[:]),
	}
	if err := config.AtomicJSON(path, record); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	lookup := agentTaskLookup(nil, nil, nil, ledger, nil)
	ref, err := lookup(ctx, tools.TaskReference{Domain: "database", RequestID: requestID})
	if err != nil || ref.ID != id {
		t.Fatalf("old task lookup: %+v %v", ref, err)
	}
	inspect := agentTaskInspector(nil, nil, nil, ledger, nil)
	status, err := inspect(ctx, ref)
	if err != nil || status.EffectiveOutcome() != tools.TaskSucceeded {
		t.Fatalf("old task observation: %+v %v", status, err)
	}
	if err := agentTaskReconciler(inspect, nil, nil)(ctx, tools.TaskReconciliation{Task: ref}); err != nil {
		t.Fatalf("old task reconciliation: %v", err)
	}
	if _, err := lookup(ctx, tools.TaskReference{Domain: "database", ID: id, RequestID: strings.Repeat("b", 64)}); err == nil {
		t.Fatal("accepted mismatched legacy request identity")
	}
	record["state"] = "running"
	delete(record, "result")
	if err := config.AtomicJSON(path, record); err != nil {
		t.Fatal(err)
	}
	status, err = inspect(ctx, ref)
	if err != nil || status.EffectiveOutcome() != tools.TaskUnknown {
		t.Fatalf("old in-flight task lost unknown outcome: %+v %v", status, err)
	}
}

func TestLegacyDatabaseChangeKeepsOriginalDockerReceiptDigest(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tasks")
	requestID, target := strings.Repeat("a", 64), strings.Repeat("b", 64)
	idSum := sha256.Sum256([]byte(docker.ContainerOperationDomain + ":" + requestID))
	id := hex.EncodeToString(idSum[:])
	canonical := `{"id":"` + target + `","requestId":"` + requestID + `","databaseChange":{"action":"create","name":"orders","expectedRevision":"revision","charset":"utf8mb4"}}`
	digestSum := sha256.Sum256([]byte(canonical))
	digest := hex.EncodeToString(digestSum[:])
	task := docker.ContainerOperationTask{ID: id, RequestID: requestID, Target: target, Digest: digest, State: "unknown"}
	if err := config.AtomicJSON(filepath.Join(root, id+".json"), task); err != nil {
		t.Fatal(err)
	}
	containers := verificationContainerFacade(t, root)
	args := `{"requestId":"` + requestID + `","databaseChange":{"charset":"utf8mb4","name":"orders","action":"create","expectedRevision":"revision"},"id":"` + target + `"}`
	ctx := context.Background()
	ref, err := agentTaskVerifier(containers, nil)(ctx, tools.TaskVerification{
		OperationID: "operation", DispatchID: "dispatch", Tool: "docker_container_exec", ArgumentsJSON: args,
		Task: tools.TaskReference{Domain: docker.ContainerOperationDomain, RequestID: requestID},
	})
	if err != nil || ref.ID != id || ref.Digest != digest {
		t.Fatalf("old task verification: %+v %v", ref, err)
	}
	intent := tools.TaskReconciliation{ID: "decision", Task: ref, Tool: "docker_container_exec", ArgumentsJSON: args, Decision: "confirmed-stopped", Evidence: "checked actual state"}
	if err := agentTaskReconciler(nil, containers, nil)(ctx, intent); err != nil {
		t.Fatalf("old Docker receipt reconciliation: %v", err)
	}
}

func TestAgentVerifierSealsCanonicalContainerUpdateIdentity(t *testing.T) {
	containers := verificationContainerFacade(t, filepath.Join(t.TempDir(), "tasks"))
	requestID, target := strings.Repeat("a", 64), strings.Repeat("b", 64)
	verify := agentTaskVerifier(containers, nil)
	request := tools.TaskVerification{
		OperationID: "operation", DispatchID: "dispatch", Tool: "docker_container_update", ToolVersion: "1",
		Task:          tools.TaskReference{Domain: docker.ContainerOperationDomain, RequestID: requestID},
		ArgumentsJSON: `{"id":"` + target + `","requestId":"` + requestID + `","pidsLimit":0,"cpuMillis":5e2}`,
	}
	sealed, err := verify(t.Context(), request)
	if err != nil || sealed.Target != target || sealed.Digest == "" {
		t.Fatalf("update seal: %+v %v", sealed, err)
	}
	request.ArgumentsJSON = `{"id":"` + target + `","requestId":"` + requestID + `","cpuMillis":500,"pidsLimit":0.0}`
	if again, err := verify(t.Context(), request); err != nil || again != sealed {
		t.Fatalf("same canonical request did not match: %+v %v", again, err)
	}
	request.ArgumentsJSON = `{"id":"` + target + `","requestId":"` + requestID + `","cpuMillis":500}`
	if _, err := verify(t.Context(), request); err == nil {
		t.Fatal("omitting an explicit zero reused the sealed identity")
	}
}
