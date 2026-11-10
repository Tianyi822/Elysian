package docker

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/seam"
)

func awaitContainerTask(t *testing.T, a *AgentFacade, id string) ContainerOperationTask {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		task, err := a.InspectContainerOperation(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if task.State != "running" {
			return task
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("任务未收敛")
	return ContainerOperationTask{}
}

func TestContainerOperationExactRetryRestartAndUnknownBarrier(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tasks")
	a := &AgentFacade{operationRoot: root}
	var calls atomic.Int32
	request := strings.Repeat("a", 64)
	run := func(context.Context, string) (any, error) { calls.Add(1); return map[string]bool{"done": true}, nil }
	first, err := a.submitContainerOperation(request, "target", map[string]string{"input": "fixed"}, run)
	if err != nil {
		t.Fatal(err)
	}
	if got := awaitContainerTask(t, a, first.ID); got.State != "succeeded" {
		t.Fatalf("%+v", got)
	}
	retry, err := a.submitContainerOperation(request, "target", map[string]string{"input": "fixed"}, run)
	if err != nil || retry.ID != first.ID || calls.Load() != 1 {
		t.Fatalf("retry=%+v err=%v calls=%d", retry, err, calls.Load())
	}
	if _, err := a.submitContainerOperation(request, "target", map[string]string{"input": "changed"}, run); err == nil {
		t.Fatal("changed input reused request")
	}
	unknown, err := a.submitContainerOperation(strings.Repeat("b", 64), "other", nil, func(context.Context, string) (any, error) { return nil, errors.New("PRIVATE_ENGINE_RESPONSE") })
	if err != nil {
		t.Fatal(err)
	}
	got := awaitContainerTask(t, a, unknown.ID)
	if got.State != "unknown" || strings.Contains(got.Message, "PRIVATE_ENGINE") {
		t.Fatalf("%+v", got)
	}
	if _, err := a.submitContainerOperation(strings.Repeat("c", 64), "other", nil, run); err == nil {
		t.Fatal("unknown barrier bypassed")
	}
	if err := a.CheckContainerMutation(context.Background(), "other", "", ""); err == nil {
		t.Fatal("page mutation bypassed unknown barrier")
	}
	if err := a.CheckContainerMutation(context.Background(), "other", "", unknown.RequestID); err != nil {
		t.Fatalf("accepted worker blocked by itself: %v", err)
	}
	restarted := &AgentFacade{operationRoot: root}
	got, err = restarted.LookupContainerOperation(context.Background(), request)
	if err != nil || got.State != "succeeded" || calls.Load() != 1 {
		t.Fatalf("restart=%+v %v", got, err)
	}
	task := ContainerOperationTask{ID: operationID(strings.Repeat("d", 64)), RequestID: strings.Repeat("d", 64), State: "running", Target: "lost"}
	if err := config.AtomicJSON(filepath.Join(root, task.ID+".json"), task); err != nil {
		t.Fatal(err)
	}
	restarted = &AgentFacade{operationRoot: root}
	got, err = restarted.InspectContainerOperation(context.Background(), task.ID)
	if err != nil || got.State != "unknown" {
		t.Fatalf("running replayed: %+v %v", got, err)
	}
}

func TestContainerOperationRejectsUntrustedTaskRecord(t *testing.T) {
	root := t.TempDir()
	request := strings.Repeat("a", 64)
	task := ContainerOperationTask{ID: operationID(request), RequestID: request, State: "succeeded"}
	raw, _ := json.Marshal(task)
	source := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(source, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(source, filepath.Join(root, task.ID+".json")); err != nil {
		t.Fatal(err)
	}
	if _, err := (&AgentFacade{operationRoot: root}).InspectContainerOperation(context.Background(), task.ID); err == nil {
		t.Fatal("symlink record trusted")
	}
}

func TestExecOutputDrainsFragmentedOversizedFrames(t *testing.T) {
	body := []byte(strings.Repeat("x", 100<<10))
	header := make([]byte, 8)
	header[0] = 1
	binary.BigEndian.PutUint32(header[4:], uint32(len(body)))
	wire := append(header, body...)
	output := &execOutput{}
	for len(wire) > 0 {
		n := 19
		if n > len(wire) {
			n = len(wire)
		}
		output.consume(wire[:n])
		wire = wire[n:]
	}
	if output.invalid || output.remaining != 0 || len(output.header) != 0 || !output.truncated || len(output.stdout) > 65<<10 {
		t.Fatalf("decoder failed: %+v", output)
	}
}

func execFrame(stream byte, value string) []byte {
	header := make([]byte, 8)
	header[0] = stream
	binary.BigEndian.PutUint32(header[4:], uint32(len(value)))
	return append(header, []byte(value)...)
}

func TestContainerExecCannotBypassUnknownCreationNameWithContainerID(t *testing.T) {
	for _, structured := range []bool{false, true} {
		t.Run(fmt.Sprint(structured), func(t *testing.T) {
			facade, engine := execTaskFacade(t, "", nil)
			pending, err := facade.submitContainerOperation(strings.Repeat("a", 64), "name:mysql-main", nil, func(context.Context, string) (any, error) {
				return nil, errors.New("create receipt lost")
			})
			if err != nil || awaitContainerTask(t, facade, pending.ID).State != "unknown" {
				t.Fatalf("未建立新建容器未知屏障: %v", err)
			}
			input := ContainerExecInput{ID: strings.Repeat("c", 64), RequestID: strings.Repeat("b", 64), Argv: []string{"true"}}
			if structured {
				input.Argv = nil
				input.DatabaseChange = &seam.AgentDatabaseChange{Action: "create", Name: "orders", ExpectedRevision: "fixed"}
			}
			if _, err := facade.SubmitExec(context.Background(), input); err == nil || !strings.Contains(err.Error(), "结果未确认") {
				t.Fatalf("容器 ID 绕过了按名称持久化的未知屏障: %v", err)
			}
			for _, call := range engine.Requests() {
				if call.Method != http.MethodGet {
					t.Fatalf("拒绝前派发了写操作: %+v", call)
				}
			}
		})
	}
}

func execTaskFacade(t *testing.T, finalStatus string, stream func(context.Context, engineCall, func([]byte)) (seam.EngineResponse, error)) (*AgentFacade, *fakeEngine) {
	t.Helper()
	containerID, execID := strings.Repeat("c", 64), strings.Repeat("e", 64)
	facade := newServiceFacade(t, func(call engineCall) (int, string, bool) {
		switch {
		case call.Method == http.MethodGet && call.Path == "/containers/"+containerID+"/json":
			return http.StatusOK, serviceContainerInspectBody(), true
		case call.Method == http.MethodPost && call.Path == "/containers/"+containerID+"/exec":
			return http.StatusCreated, `{"Id":"` + execID + `"}`, true
		case call.Method == http.MethodGet && call.Path == "/exec/"+execID+"/json":
			return http.StatusOK, finalStatus, true
		}
		return 0, "", false
	}, &recordingPortOpener{})
	facade.operationRoot = filepath.Join(t.TempDir(), "tasks")
	engine := facade.service.deps.transport.(*fakeEngine)
	engine.streamFn = stream
	return facade, engine
}

func TestContainerExecPreservesExitCodeRedactsAndDoesNotReplay(t *testing.T) {
	secret := strings.Repeat("d", 48)
	status := fmt.Sprintf(`{"Running":false,"ExitCode":7,"ContainerID":%q}`, strings.Repeat("c", 64))
	facade, engine := execTaskFacade(t, status, func(_ context.Context, call engineCall, consume func([]byte)) (seam.EngineResponse, error) {
		if call.Method != http.MethodPost || call.Path != "/exec/"+strings.Repeat("e", 64)+"/start" || call.Body != `{"Detach":false,"Tty":false}` {
			t.Errorf("unexpected exec stream: %+v", call)
		}
		wire := append(execFrame(1, "password="+secret+"\n"), execFrame(2, "failed: "+secret)...)
		for len(wire) > 0 {
			n := 11
			if n > len(wire) {
				n = len(wire)
			}
			consume(wire[:n])
			wire = wire[n:]
		}
		return seam.EngineResponse{Status: http.StatusOK}, nil
	})
	if err := facade.credentials.save(agentServiceCredentialRecord{Name: "test", ContainerID: strings.Repeat("c", 64), Credentials: map[string]string{"APP_PASSWORD": secret}}); err != nil {
		t.Fatal(err)
	}
	var authorizations atomic.Int32
	facade.authorize = func(context.Context) error { authorizations.Add(1); return nil }
	input := ContainerExecInput{ID: strings.Repeat("c", 64), RequestID: strings.Repeat("a", 64), Argv: []string{"/bin/false"}}
	task, err := facade.SubmitExec(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	got := awaitContainerTask(t, facade, task.ID)
	if got.State != "succeeded" || got.ExecID != strings.Repeat("e", 64) || strings.Contains(string(got.Result), secret) || !strings.Contains(string(got.Result), "[REDACTED]") {
		t.Fatalf("invalid result: %+v", got)
	}
	var result struct {
		ExitCode int `json:"exitCode"`
	}
	if json.Unmarshal(got.Result, &result) != nil || result.ExitCode != 7 || authorizations.Load() != 1 {
		t.Fatalf("exit=%d auth=%d", result.ExitCode, authorizations.Load())
	}
	requests := len(engine.Requests())
	retry, err := facade.SubmitExec(context.Background(), input)
	if err != nil || retry.State != "succeeded" || len(engine.Requests()) != requests {
		t.Fatalf("exact retry reran execution: %+v %v", retry, err)
	}
}

func TestContainerExecCancellationKeepsUnknownBarrierWithoutStoppingContainer(t *testing.T) {
	started := make(chan struct{})
	facade, engine := execTaskFacade(t, "", func(ctx context.Context, _ engineCall, _ func([]byte)) (seam.EngineResponse, error) {
		close(started)
		<-ctx.Done()
		return seam.EngineResponse{}, ctx.Err()
	})
	input := ContainerExecInput{ID: strings.Repeat("c", 64), RequestID: strings.Repeat("a", 64), Argv: []string{"sleep", "300"}}
	task, err := facade.SubmitExec(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("exec did not start")
	}
	if err := facade.CancelContainerOperation(context.Background(), task.ID, input.RequestID); err != nil {
		t.Fatal(err)
	}
	got := awaitContainerTask(t, facade, task.ID)
	if got.State != "unknown" || !got.CancelRequested || len(got.Result) != 0 {
		t.Fatalf("unconfirmed cancellation: %+v", got)
	}
	input.RequestID = strings.Repeat("b", 64)
	if _, err := facade.SubmitExec(context.Background(), input); err == nil {
		t.Fatal("unknown execution barrier bypassed")
	}
	for _, call := range engine.Requests() {
		if strings.HasSuffix(call.Path, "/stop") || strings.HasSuffix(call.Path, "/kill") || call.Method == http.MethodDelete {
			t.Fatalf("cancellation changed business container lifecycle: %+v", call)
		}
	}
}

func TestContainerExecRequiresConfirmedActualExitStatus(t *testing.T) {
	for name, status := range map[string]string{
		"still-running":   fmt.Sprintf(`{"Running":true,"ExitCode":0,"ContainerID":%q}`, strings.Repeat("c", 64)),
		"missing-exit":    fmt.Sprintf(`{"Running":false,"ContainerID":%q}`, strings.Repeat("c", 64)),
		"wrong-container": fmt.Sprintf(`{"Running":false,"ExitCode":0,"ContainerID":%q}`, strings.Repeat("d", 64)),
	} {
		t.Run(name, func(t *testing.T) {
			facade, _ := execTaskFacade(t, status, func(context.Context, engineCall, func([]byte)) (seam.EngineResponse, error) {
				return seam.EngineResponse{Status: http.StatusOK}, nil
			})
			task, err := facade.SubmitExec(context.Background(), ContainerExecInput{ID: strings.Repeat("c", 64), RequestID: strings.Repeat("a", 64), Argv: []string{"true"}})
			if err != nil {
				t.Fatal(err)
			}
			if got := awaitContainerTask(t, facade, task.ID); got.State != "unknown" || len(got.Result) != 0 {
				t.Fatalf("unconfirmed exit reported as success: %+v", got)
			}
		})
	}
}

type lifecycleDatabaseBridge struct{ calls int }

func (b *lifecycleDatabaseBridge) PrepareCreate(context.Context, seam.AgentServiceContainerInput, string) (func(context.Context) (any, error), bool, error) {
	return nil, false, nil
}
func (b *lifecycleDatabaseBridge) PrepareChange(context.Context, string, string, seam.AgentDatabaseChange) (func(context.Context) (any, error), error) {
	return nil, errors.New("unused")
}
func (b *lifecycleDatabaseBridge) Inspect(context.Context, string, *seam.AgentDatabaseInspection) (any, error) {
	return nil, nil
}
func (b *lifecycleDatabaseBridge) Registered(context.Context, string) (bool, error) { return true, nil }
func (b *lifecycleDatabaseBridge) Lifecycle(context.Context, string, string) (bool, error) {
	b.calls++
	return true, nil
}

func TestLegacyDockerLifecycleDoesNotGainDatabaseTargets(t *testing.T) {
	body := strings.Replace(serviceContainerInspectBody(), `"elysian.managed":"true"`, `"elysian.managed":"true","elysian.database":"true"`, 1)
	facade := newServiceFacade(t, func(call engineCall) (int, string, bool) {
		if call.Method == http.MethodGet && call.Path == "/containers/"+strings.Repeat("c", 64)+"/json" {
			return http.StatusOK, body, true
		}
		return 0, "", false
	}, &recordingPortOpener{})
	facade.operationRoot = filepath.Join(t.TempDir(), "tasks")
	bridge := &lifecycleDatabaseBridge{}
	facade.SetDatabaseContainers(bridge)
	if _, err := facade.LegacyAction(context.Background(), strings.Repeat("c", 64), "stop"); err == nil {
		t.Fatal("legacy stop gained database permission")
	}
	if err := facade.LegacyRemove(context.Background(), strings.Repeat("c", 64)); err == nil || bridge.calls != 0 {
		t.Fatal("legacy removal used new database bridge")
	}
	if err := facade.Remove(context.Background(), strings.Repeat("c", 64)); err != nil || bridge.calls != 1 {
		t.Fatalf("version-2 removal did not use shared database implementation: %v", err)
	}
}
