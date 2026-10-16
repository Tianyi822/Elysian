package database

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/config"
)

type blockingAgentProtocol struct {
	*fakeProtocol
	entered chan struct{}
	release chan struct{}
}

func (p *blockingAgentProtocol) create(ctx context.Context, row databaseRecord, address databaseAddress, charset string) error {
	close(p.entered)
	select {
	case <-p.release:
		return p.fakeProtocol.create(ctx, row, address, charset)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func agentCreateTaskInput() AgentTaskInput {
	return AgentTaskInput{Action: "create", Create: AgentCreate{ID: "new:orders-agent", Expected: "missing", Engine: engineMySQL, VersionTag: "8.4", Name: "orders", ImageID: testImageID, ContainerName: "orders-agent"}}
}

func waitAgentTask(t *testing.T, f *AgentFacade, id, state string) agentTaskRecord {
	t.Helper()
	deadline := time.After(3 * time.Second)
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		f.taskMu.Lock()
		task := f.tasks[id]
		f.taskMu.Unlock()
		if task.State == state {
			return task
		}
		select {
		case <-deadline:
			t.Fatalf("task state=%q, want %q", task.State, state)
		case <-ticker.C:
		}
	}
}

func TestAgentDatabaseTaskPersistsBeforeDispatchAndIgnoresCallerCancellation(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	protocol := &blockingAgentProtocol{fakeProtocol: fixture.protocol, entered: make(chan struct{}), release: make(chan struct{})}
	fixture.service.deps.protocol = protocol
	var calls atomic.Int32
	facade := &AgentFacade{service: fixture.service, taskRoot: t.TempDir(), authorize: func(context.Context) error { calls.Add(1); return nil }}
	t.Cleanup(func() { _ = facade.Close(context.Background()) })
	ctx, cancel := context.WithCancel(context.Background())
	requestID := strings.Repeat("a", 64)
	input := agentCreateTaskInput()
	task, err := facade.SubmitTask(ctx, requestID, input)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case <-protocol.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("accepted task did not dispatch")
	}
	raw, err := os.ReadFile(filepath.Join(facade.taskRoot, task.ID+".json"))
	if err != nil {
		t.Fatal("dispatch did not have a durable receipt", err)
	}
	var stored agentTaskRecord
	if err := json.Unmarshal(raw, &stored); err != nil || stored.State != "running" || stored.Digest != agentTaskInputDigest(input) || stored.RegistrationID == "" || stored.RegistrationIdentity == "" {
		t.Fatalf("invalid durable receipt: %s", raw)
	}
	if strings.Contains(string(raw), "password") || strings.Contains(string(raw), "username") {
		t.Fatal("task record contains credential fields")
	}
	duplicate, err := facade.SubmitTask(context.Background(), requestID, input)
	if err != nil || duplicate.ID != task.ID {
		t.Fatalf("same request was not deduplicated: %#v %v", duplicate, err)
	}
	changed := input
	changed.Create.Charset = "utf8"
	if _, err := facade.SubmitTask(context.Background(), requestID, changed); err == nil {
		t.Fatal("same request accepted different full parameters")
	}
	close(protocol.release)
	completed := waitAgentTask(t, facade, task.ID, "succeeded")
	if completed.Result == nil || completed.Result.ID == "" || calls.Load() != 3 {
		t.Fatalf("invalid result or authorization count: %#v calls=%d", completed.Result, calls.Load())
	}
	fixture.docker.mu.Lock()
	created := len(fixture.docker.createCalls)
	fixture.docker.mu.Unlock()
	if created != 1 {
		t.Fatalf("create dispatched %d times", created)
	}
	rows, _ := fixture.registry.list()
	raw, _ = os.ReadFile(filepath.Join(facade.taskRoot, task.ID+".json"))
	if strings.Contains(string(raw), rows[0].Admin.Password) || strings.Contains(string(raw), rows[0].User.Password) {
		t.Fatal("completed task persisted database credentials")
	}
}

func TestAgentDatabaseTaskRestartNeverResubmitsAndKeepsUnknownBarrier(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	root := t.TempDir()
	requestID := strings.Repeat("b", 64)
	input := agentCreateTaskInput()
	id := agentDatabaseTaskID(requestID)
	record := agentTaskRecord{AgentTask: AgentTask{ID: id, RequestID: requestID, Action: "create", State: "running"}, Input: input, Digest: agentTaskInputDigest(input)}
	if err := config.AtomicJSON(filepath.Join(root, id+".json"), record); err != nil {
		t.Fatal(err)
	}
	facade := &AgentFacade{service: fixture.service, taskRoot: root, authorize: func(context.Context) error { return nil }}
	t.Cleanup(func() { _ = facade.Close(context.Background()) })
	task, err := facade.LookupTask(context.Background(), requestID)
	if err != nil || task.State != "unknown" {
		t.Fatalf("restart did not retain uncertainty: %#v %v", task, err)
	}
	if _, err := facade.SubmitTask(context.Background(), requestID, input); err != nil {
		t.Fatal(err)
	}
	if _, err := facade.SubmitTask(context.Background(), strings.Repeat("c", 64), input); err == nil {
		t.Fatal("unknown task released database dispatch barrier")
	}
	if len(fixture.docker.createCalls) != 0 || len(fixture.protocol.trace.items) != 0 {
		t.Fatal("restart replayed database mutation")
	}
	raw, _ := os.ReadFile(filepath.Join(root, id+".json"))
	if !strings.Contains(string(raw), `"state": "unknown"`) {
		t.Fatal("restart uncertainty was not persisted")
	}
}

func TestAgentDatabaseTaskRecoversOnlyExactRegistrationAndProtocolFacts(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	row := databaseRecord{ID: "db", Engine: engineMySQL, Name: "orders", VersionTag: "8.4", ContainerID: strings.Repeat("c", 64), Source: sourceManaged, State: stateNeedsAttention, Admin: databaseSecret{Username: "root", Password: "ADMIN_SECRET"}, User: databaseSecret{Username: "ordinary", Password: "USER_SECRET"}}
	fixture.docker.addContainer(row.ContainerID, "mysql:8.4", true, nil)
	input := AgentTaskInput{Action: "reconcile", ID: row.ID, Expected: agentRecordDigest(row)}
	requestID := strings.Repeat("d", 64)
	id := agentDatabaseTaskID(requestID)
	record := agentTaskRecord{AgentTask: AgentTask{ID: id, RequestID: requestID, Action: "reconcile", State: "running"}, Input: input, Digest: agentTaskInputDigest(input), AnchorContainerID: row.ContainerID, AnchorDigest: agentTaskIdentity(row)}
	root := t.TempDir()
	if err := config.AtomicJSON(filepath.Join(root, id+".json"), record); err != nil {
		t.Fatal(err)
	}
	row.State = stateActive
	fixture.registry.rows = []databaseRecord{row}
	fixture.protocol.verifyErr = errors.New("do not expose verification details")
	facade := &AgentFacade{service: fixture.service, taskRoot: root}
	t.Cleanup(func() { _ = facade.Close(context.Background()) })
	task, err := facade.InspectTask(context.Background(), id)
	if err != nil || task.State != "unknown" {
		t.Fatal("failed protocol verification settled task", err)
	}
	fixture.protocol.verifyErr = nil
	changed := row
	changed.User.Password = "REPLACED_SECRET"
	fixture.registry.rows = []databaseRecord{changed}
	task, err = facade.InspectTask(context.Background(), id)
	if err != nil || task.State != "unknown" {
		t.Fatal("different registration settled task", err)
	}
	fixture.registry.rows = []databaseRecord{row}
	task, err = facade.InspectTask(context.Background(), id)
	if err != nil || task.State != "succeeded" || task.Result == nil || task.Result.ID != row.ID {
		t.Fatalf("exact reconciled facts did not settle: %#v %v", task, err)
	}
	raw, _ := os.ReadFile(filepath.Join(root, id+".json"))
	for _, secret := range []string{row.Admin.Password, row.User.Password, changed.User.Password} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("recovery persisted credentials")
		}
	}
}

func TestAgentDatabaseTaskCloseCancelsWorkerAndLeavesUnknown(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	protocol := &blockingAgentProtocol{fakeProtocol: fixture.protocol, entered: make(chan struct{}), release: make(chan struct{})}
	fixture.service.deps.protocol = protocol
	facade := &AgentFacade{service: fixture.service, taskRoot: t.TempDir(), authorize: func(context.Context) error { return nil }}
	task, err := facade.SubmitTask(context.Background(), strings.Repeat("e", 64), agentCreateTaskInput())
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-protocol.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("task did not dispatch")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := facade.Close(ctx); err != nil {
		t.Fatal("worker was not reaped", err)
	}
	waitAgentTask(t, facade, task.ID, "unknown")
	if _, err := facade.SubmitTask(context.Background(), strings.Repeat("f", 64), agentCreateTaskInput()); err == nil {
		t.Fatal("closed service accepted task")
	}
}

func TestAgentDatabaseCreateTaskRecoveryRequiresExactNewRegistrationAndContainerIdentity(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	input := agentCreateTaskInput()
	creator := &AgentFacade{service: fixture.service, authorize: func(context.Context) error { return nil }}
	if _, err := creator.Create(context.Background(), input.Create); err != nil {
		t.Fatal(err)
	}
	rows, _ := fixture.registry.list()
	row := rows[0]
	requestID := strings.Repeat("f", 64)
	id := agentDatabaseTaskID(requestID)
	record := agentTaskRecord{AgentTask: AgentTask{ID: id, RequestID: requestID, Action: "create", State: "running"}, Input: input, Digest: agentTaskInputDigest(input), RegistrationID: row.ID, RegistrationIdentity: agentTaskIdentity(row)}
	root := t.TempDir()
	if err := config.AtomicJSON(filepath.Join(root, id+".json"), record); err != nil {
		t.Fatal(err)
	}
	facade := &AgentFacade{service: fixture.service, taskRoot: root}
	t.Cleanup(func() { _ = facade.Close(context.Background()) })
	fixture.docker.inspectInfos[row.ContainerID]["Name"] = "/other-name"
	task, err := facade.InspectTask(context.Background(), id)
	if err != nil || task.State != "unknown" {
		t.Fatal("different container name settled create", err)
	}
	fixture.docker.inspectInfos[row.ContainerID]["Name"] = "/" + input.Create.ContainerName
	fixture.docker.inspectInfos[row.ContainerID]["Image"] = "sha256:" + strings.Repeat("0", 64)
	task, err = facade.InspectTask(context.Background(), id)
	if err != nil || task.State != "unknown" {
		t.Fatal("different image settled create", err)
	}
	fixture.docker.inspectInfos[row.ContainerID]["Image"] = testImageID
	duplicate := row
	duplicate.ID = "another-registration"
	fixture.registry.rows = []databaseRecord{duplicate}
	task, err = facade.InspectTask(context.Background(), id)
	if err != nil || task.State != "unknown" {
		t.Fatal("different new registration settled create", err)
	}
	fixture.registry.rows = []databaseRecord{row, duplicate}
	task, err = facade.InspectTask(context.Background(), id)
	if err != nil || task.State != "succeeded" || task.Result == nil || task.Result.ID != row.ID {
		t.Fatalf("exact created facts did not settle: %#v %v", task, err)
	}
	if len(fixture.docker.createCalls) != 1 {
		t.Fatal("recovery resubmitted create")
	}
}

func TestAgentDatabaseTaskPersistenceFailureDoesNotDispatch(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	root := filepath.Join(t.TempDir(), "not-directory")
	if err := os.WriteFile(root, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	facade := &AgentFacade{service: fixture.service, taskRoot: root, authorize: func(context.Context) error { return nil }}
	if _, err := facade.SubmitTask(context.Background(), strings.Repeat("a", 64), agentCreateTaskInput()); err == nil {
		t.Fatal("unpersisted task accepted")
	}
	if len(fixture.docker.createCalls) != 0 {
		t.Fatal("persistence failure dispatched create")
	}
}

func TestAgentDatabaseTaskCancelIsDurableScopedAndRetainsUnknownBarrier(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	protocol := &blockingAgentProtocol{fakeProtocol: fixture.protocol, entered: make(chan struct{}), release: make(chan struct{})}
	fixture.service.deps.protocol = protocol
	facade := &AgentFacade{service: fixture.service, taskRoot: t.TempDir(), authorize: func(context.Context) error { return nil }}
	t.Cleanup(func() { _ = facade.Close(context.Background()) })
	input := agentCreateTaskInput()
	task, err := facade.SubmitTask(context.Background(), strings.Repeat("1", 64), input)
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-protocol.entered:
	case <-time.After(3 * time.Second):
		t.Fatal("task did not dispatch")
	}
	if _, err := facade.CancelTask(context.Background(), "another-database", task.ID); err == nil {
		t.Fatal("cancel accepted another resource grant")
	}
	if _, err := facade.TaskStatus(context.Background(), "another-database", task.ID); err == nil {
		t.Fatal("status accepted another resource grant")
	}
	if _, err := facade.TaskLogs(context.Background(), "another-database", task.ID, 0, 20); err == nil {
		t.Fatal("logs accepted another resource grant")
	}
	cancelled, err := facade.CancelTask(context.Background(), input.Create.ID, task.ID)
	if err != nil || !cancelled.CancelRequested {
		t.Fatalf("cancel request was not accepted: %#v %v", cancelled, err)
	}
	stored := waitAgentTask(t, facade, task.ID, "unknown")
	if !stored.CancelRequested || !strings.Contains(stored.Message, "禁止重投") {
		t.Fatal("cancel lost uncertainty or durable flag")
	}
	raw, _ := os.ReadFile(filepath.Join(facade.taskRoot, task.ID+".json"))
	if !strings.Contains(string(raw), `"cancelRequested": true`) {
		t.Fatal("cancel request was not durable")
	}
	if _, err := facade.SubmitTask(context.Background(), strings.Repeat("2", 64), input); err == nil {
		t.Fatal("cancel released unknown barrier")
	}
	page, err := facade.TaskLogs(context.Background(), input.Create.ID, task.ID, 0, 2)
	if err != nil || len(page.Entries) != 2 || !page.HasMore {
		t.Fatalf("first log page invalid: %#v %v", page, err)
	}
	next, err := facade.TaskLogs(context.Background(), input.Create.ID, task.ID, page.Next, 50)
	if err != nil || len(next.Entries) == 0 || next.Entries[0].Sequence <= page.Next || next.HasMore {
		t.Fatalf("next log page invalid: %#v %v", next, err)
	}
	stages := map[string]bool{}
	for _, entry := range append(page.Entries, next.Entries...) {
		stages[entry.Stage] = true
	}
	if !stages["cancel-requested"] || !stages["execution-stopped"] {
		t.Fatalf("cancel phases missing: %#v", stages)
	}
	status, err := facade.CancelTask(context.Background(), input.Create.ID, task.ID)
	if err != nil || status.State != "unknown" || !strings.Contains(status.Message, "无法用取消确认") {
		t.Fatal("unknown task cancellation did not explain uncertainty", err)
	}
}

func TestAgentDatabaseTaskLogsBoundedAndCursorValidated(t *testing.T) {
	fixture := newServiceFixture("8.4.7")
	facade := &AgentFacade{service: fixture.service, taskRoot: t.TempDir(), authorize: func(context.Context) error { return nil }}
	t.Cleanup(func() { _ = facade.Close(context.Background()) })
	input := agentCreateTaskInput()
	requestID := strings.Repeat("3", 64)
	id := agentDatabaseTaskID(requestID)
	record := agentTaskRecord{AgentTask: AgentTask{ID: id, RequestID: requestID, Action: "create", State: "unknown"}, Input: input, Digest: agentTaskInputDigest(input)}
	for i := 0; i < 150; i++ {
		appendAgentTaskLog(&record, "unknown")
	}
	if err := config.AtomicJSON(filepath.Join(facade.taskRoot, id+".json"), record); err != nil {
		t.Fatal(err)
	}
	page, err := facade.TaskLogs(context.Background(), input.Create.ID, id, 0, 50)
	if err != nil || !page.Truncated || len(page.Entries) != 50 || page.Entries[0].Sequence != 23 || !page.HasMore {
		t.Fatalf("log cap invalid: %#v %v", page, err)
	}
	for _, invalid := range [][2]int{{-1, 20}, {151, 20}, {0, 51}, {0, 0}} {
		if _, err := facade.TaskLogs(context.Background(), input.Create.ID, id, invalid[0], invalid[1]); err == nil {
			t.Fatalf("invalid log boundary accepted: %#v", invalid)
		}
	}
}
