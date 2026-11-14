package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/toolbridge"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domaindatabase "elysian/server/internal/database"
	domaindocker "elysian/server/internal/docker"
)

func TestExternalFailureNeedsEvidenceBeforeAnotherMutation(t *testing.T) {
	var executed atomic.Int32
	cat := &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		executed.Add(1)
		return CapabilityResult{BusinessError: &Failure{Code: "mcp-tool-error", Message: "MCP 工具返回业务错误"}}, nil
	}}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
	r := submitAgentTest(t, m, session, "mcp-error-evidence", "执行外部变更")
	approval := waitingApproval(t, m, r.ID)
	if _, err := m.Decide(m.ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool { current, _ := m.Get(m.ctx, r.ID); return current.Status == StateWaitingRecovery })
	calls, _ := m.Calls(m.ctx, r.ID, "", 10)
	if executed.Load() != 1 || len(calls.Items) != 2 || calls.Items[1].Error == nil || calls.Items[1].Error.Code != "mcp-tool-error" || calls.Items[1].Evidence == nil || calls.Items[1].Evidence.Changes != "unknown" {
		t.Fatalf("external error treated as safe to repeat: executions=%d calls=%+v", executed.Load(), calls)
	}
	if _, err := m.Cancel(m.ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, r.ID); done.Status != StateCancelled {
		t.Fatal("cancel did not persist")
	}
}

func TestScriptFailureDistinguishesVerifiedWorkspaceFromExternalChanges(t *testing.T) {
	s := CapabilitySnapshot{RecoveryPolicy: evidenceRecoveryPolicy}
	o := Operation{Capability: Capability{Source: BashSource}, Execution: &ExecutionPlan{}}
	result := CapabilityResult{Workspace: &workspace.Version{Revision: 2}, BusinessError: &Failure{Code: "bash-exit", Message: "Bash 非零退出"}}
	local := classifyRecoveryResult(s, o, result)
	if local.Unknown || local.BusinessError.Evidence == nil || local.BusinessError.Evidence.Stage != "workspace-verified" {
		t.Fatal("verified isolated effects cannot return to model")
	}
	o.Execution.Grant = &execconfig.Grant{Network: []execconfig.NetworkEndpoint{{Host: "example.invalid", Port: 443}}}
	external := classifyRecoveryResult(s, o, result)
	if !external.Unknown || external.BusinessError.Evidence.Changes != "unknown" || external.Workspace == nil {
		t.Fatal("possible external changes lost protection or captured workspace")
	}
	legacy := classifyRecoveryResult(CapabilitySnapshot{}, o, result)
	if legacy.Unknown || legacy.BusinessError.Evidence != nil {
		t.Fatal("old snapshot semantics changed")
	}
}

func TestMissingTaskVerificationRetriesDurableIntentWithoutRevivingHistory(t *testing.T) {
	for _, stage := range []string{"intent", "copy", "domain", "binding"} {
		t.Run(stage, func(t *testing.T) {
			m, o, _ := domainOutcomeFixture(t, "orphan-"+stage)
			if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
				t.Fatal(err)
			}
			o, _ = readOperation(m.ctx, m.store.db, o.ID)
			o.Task.ID = ""
			o.DispatchID = "original-dispatch"
			o.Capability = Capability{Name: "docker_container_create_service", Source: "builtin", Metadata: tools.Metadata{Async: true, Version: "3"}}
			o.ArgumentsJSON = `{"name":"mysql84","requestId":"original"}`
			if err := m.store.write(m.ctx, "orphan-fixture", func(tx *sql.Tx) error { return saveOperation(m.ctx, tx, o) }); err != nil {
				t.Fatal(err)
			}
			before, _ := m.Get(m.ctx, o.RunID)
			injected := errors.New("injected verification crash")
			effects, requests := 0, 0
			var receipt *tools.TaskReference
			m.deps.VerifyTask = func(_ context.Context, v tools.TaskVerification) (tools.TaskReference, error) {
				requests++
				if receipt == nil {
					ref := tools.TaskReference{Domain: v.Task.Domain, ID: "sealed-task", RequestID: v.Task.RequestID, Target: "name:mysql84", Digest: strings.Repeat("d", 64)}
					receipt = &ref
					effects++
				}
				if stage == "domain" && requests == 1 {
					return tools.TaskReference{}, injected
				}
				return *receipt, nil
			}
			m.deps.InspectTask = func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
				return tools.TaskStatus{Outcome: tools.TaskFailed, Failed: true, ErrorCode: "not-accepted", Error: "原请求未受理，未执行业务变更", Evidence: &tools.ExecutionEvidence{Execution: "not-started", Changes: "none"}}, nil
			}
			m.store.beforeWrite = func(op string) error {
				if stage == "intent" && op == "submission-verification-intent" || stage == "binding" && op == "submission-verification-result" {
					return injected
				}
				return nil
			}
			if stage == "copy" {
				m.store.recordHook = func(string) error { return injected }
			}
			if _, err := m.VerifyRecovery(m.ctx, o.RunID); err == nil {
				t.Fatal("injected verification failure ignored")
			}
			assertDomainProtection(t, m, o, "unknown")
			if (stage == "intent" || stage == "copy") && effects != 0 {
				t.Fatal("domain reached before durable healthy intent")
			}
			path := m.store.dbPathForTest(t)
			if err := m.store.close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := openStore(path, func() time.Time { return runtimeStoreTestTime })
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = reopened.close() })
			m.store = reopened
			after, err := m.VerifyRecovery(m.ctx, o.RunID)
			if err != nil || after.Status != StateInterrupted || after.EndReason != before.EndReason || effects != 1 {
				t.Fatalf("history revived or verification replayed: status=%s effects=%d error=%v", after.Status, effects, err)
			}
			used := after.Usage.ResultBytes
			after, err = m.VerifyRecovery(m.ctx, o.RunID)
			if err != nil || after.Usage.ResultBytes != used || effects != 1 {
				t.Fatal("verification charged or executed twice")
			}
			assertDomainProtection(t, m, o, "released")
		})
	}
}

func TestServiceSubmissionMissingDatabaseNameReturnsToModelAfterRealApproval(t *testing.T) {
	db := domaindatabase.NewAgentFacade(domaindatabase.Deps{EngineAvailable: true, Engine: unusedDatabaseTransport{}, Views: &dockerCatalogViews{}, AgentAuthorize: tools.Revalidate})
	bridge, _ := dockerCatalogBridge(t, func(a *domaindocker.AgentFacade) { a.SetDatabaseContainers(db.ContainerBridge(tools.Revalidate)) })
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		switch requests.Add(1) {
		case 1:
			return searchReply("docker_container_create_service"), nil
		case 2:
			r := toolReply("docker_container_create_service")
			r.ToolCalls[0].Arguments = json.RawMessage(`{"name":"mysql84","image":"mysql:8.4@sha256:` + strings.Repeat("a", 64) + `","requestId":"` + strings.Repeat("b", 64) + `","resourceTier":"small","networkScope":"any-host","port":3306,"hostPort":3306,"credentials":["MYSQL_ROOT_PASSWORD"],"volumes":["/var/lib/mysql"]}`)
			return r, nil
		default:
			text := allRequestText(request)
			if !strings.Contains(text, "MYSQL_DATABASE") || !strings.Contains(text, "not-started") {
				t.Errorf("missing actionable rejection, MYSQL_DATABASE=%v not-started=%v", strings.Contains(text, "MYSQL_DATABASE"), strings.Contains(text, "not-started"))
			}
			return finalReply("缺少初始逻辑库名，创建未执行。"), nil
		}
	}, func(d *Deps) { d.Tools = bridge; d.Catalog = &Extensions{MountRoot: "/srv"} })
	r, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "real-service-preflight", Content: "部署 MySQL，small 档，开放3306", AuthorizationMode: AuthorizationOnDemand, PermissionMode: PermissionAsk})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if t.Failed() {
			current, _ := m.Get(context.Background(), r.ID)
			t.Logf("service run status=%s reason=%s error=%+v requests=%d", current.Status, current.EndReason, current.Error, requests.Load())
			events, _ := m.Events(context.Background(), r.ID, "", 100)
			for _, e := range events.Items {
				t.Logf("event %s %s", e.Type, e.Data)
			}
		}
	}()
	a := waitingApproval(t, m, r.ID)
	if _, err := m.DecideAccess(context.Background(), a.ID, accessInput(a, "once", "approve-service-preflight")); err != nil {
		t.Fatal(err)
	}
	finished := runtimeFinished(t, m, r.ID)
	if finished.Status != StateSucceeded || requests.Load() != 3 {
		t.Fatalf("%+v requests=%d", finished, requests.Load())
	}
	ops, _ := m.Operations(context.Background(), r.ID)
	for _, o := range ops {
		if o.Capability.Name == "docker_container_create_service" && (o.Status != "completed" || o.Task != nil || o.Error == nil || !strings.Contains(o.Error.Message, "MYSQL_DATABASE")) {
			t.Fatalf("false unknown task status=%s task=%+v error=%+v", o.Status, o.Task, o.Error)
		}
	}
	barriers, _ := m.Barriers(context.Background())
	for _, b := range barriers {
		if b.RunID == r.ID && b.Status != "confirmed" {
			t.Fatalf("rejection kept barrier %+v", b)
		}
	}
}

type recoverySchemaCatalog struct{ operationCatalog }

func (c *recoverySchemaCatalog) Snapshot(ctx context.Context, env Environment) (CapabilitySnapshot, error) {
	s, err := c.operationCatalog.Snapshot(ctx, env)
	for i := range s.Tools {
		if s.Tools[i].Name == "test_read" {
			s.Tools[i].Parameters = json.RawMessage(`{"type":"object","properties":{"id":{"type":"string"}},"required":["id"],"additionalProperties":false}`)
		}
	}
	return s, err
}

func TestSchemaCorrectionsRejectWholeBatchAndReturnSpecificFields(t *testing.T) {
	var requests, executed atomic.Int32
	cat := &recoverySchemaCatalog{operationCatalog{execute: func(_ context.Context, o Operation) (CapabilityResult, error) {
		executed.Add(1)
		if o.ArgumentsJSON != `{"id":"target"}` {
			t.Error("rejected arguments reached handler")
		}
		return CapabilityResult{Value: json.RawMessage(`{"checked":true}`)}, nil
	}}}
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if !contains(toolNames(r), "test_read") {
			return searchReply("test_read"), nil
		}
		switch requests.Add(1) {
		case 1, 2, 3, 4:
			reply := searchReply("test_read")
			args := `{}`
			if requests.Load() >= 2 {
				if !strings.Contains(allRequestText(r), "id") {
					t.Error("specific required field missing from correction")
				}
				value, _ := json.Marshal(map[string]int{"id": int(requests.Load())})
				args = string(value)
			}
			reply.ToolCalls = append(reply.ToolCalls, model.ToolCall{ID: "invalid", Name: "test_read", Arguments: json.RawMessage(args)})
			return reply, nil
		case 5:
			if !strings.Contains(allRequestText(r), "type") {
				t.Error("specific type constraint missing from correction")
			}
			reply := toolReply("test_read")
			reply.ToolCalls[0].Arguments = json.RawMessage(`{"id":"target"}`)
			return reply, nil
		default:
			return finalReply("已修正参数并验证读取成功"), nil
		}
	}, func(d *Deps) { d.Catalog = cat })
	approveEnvironment(t, m, session)
	r := submitAgentTest(t, m, session, "schema-correction", "读取目标")
	done := runtimeFinished(t, m, r.ID)
	calls, err := m.Calls(m.ctx, r.ID, "", 50)
	if err != nil || done.Status != StateSucceeded || executed.Load() != 1 || len(calls.Items) != 2 {
		t.Fatalf("batch partially executed or correction stopped: status=%s reason=%s failure=%+v executed=%d calls=%d err=%v", done.Status, done.EndReason, done.Error, executed.Load(), len(calls.Items), err)
	}
}

func TestIdenticalSchemaFailureIgnoresNewRequestIDsAndStops(t *testing.T) {
	var attempts, executed atomic.Int32
	cat := &recoverySchemaCatalog{operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		executed.Add(1)
		return CapabilityResult{}, nil
	}}}
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "none" {
			return finalReply("相同无效参数已停止重复纠正，本批未执行。"), nil
		}
		if !contains(toolNames(r), "test_read") {
			return searchReply("test_read"), nil
		}
		n := attempts.Add(1)
		reply := toolReply("test_read")
		reply.ToolCalls[0].Arguments, _ = json.Marshal(map[string]any{"id": 33, "requestId": n})
		return reply, nil
	}, func(d *Deps) { d.Catalog = cat })
	approveEnvironment(t, m, session)
	r := submitAgentTest(t, m, session, "schema-no-progress", "读取状态")
	done := runtimeFinished(t, m, r.ID)
	if done.EndReason != "no-progress" || done.Status != StateInterrupted || attempts.Load() != 3 || executed.Load() != 0 {
		t.Fatalf("unbounded or executed schema proposal: status=%s reason=%s attempts=%d executed=%d", done.Status, done.EndReason, attempts.Load(), executed.Load())
	}
}

func recoveryOutcomeFixture(t *testing.T, suffix string) (*Manager, Operation, ExecutionBarrier) {
	m, o, b := domainOutcomeFixture(t, suffix)
	_, task, r := sessionStoreFixture(t, m.store, "recovery-"+suffix, runtimeStoreTestTime)
	r = acceptSessionTestRun(t, m.store, task, r, true)
	_, err := m.store.change(context.Background(), o.RunID, "attach-session", func(tx *sql.Tx, original *Run) error {
		original.SessionID = r.SessionID
		original.DriverVersion = "v2"
		original.RecoveryPolicy = evidenceRecoveryPolicy
		return saveRun(context.Background(), tx, original)
	})
	if err != nil {
		t.Fatal(err)
	}
	return m, o, b
}

func TestEvidenceRecoveryWaitsResumesOnceAndNeverRevivesCancelledRun(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "resume", true: "cancelled"}[cancelled], func(t *testing.T) {
			m, o, _ := recoveryOutcomeFixture(t, "recover")
			if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskUnknown, ErrorCode: "lost-receipt", Error: "回执中断"}); err != nil {
				t.Fatal(err)
			}
			r, _ := m.store.get(context.Background(), o.RunID)
			if r.Status != StateWaitingRecovery || r.Recovery == nil {
				t.Fatalf("%+v", r)
			}
			if cancelled {
				_, err := m.store.change(context.Background(), r.ID, "cancel-fixture", func(tx *sql.Tx, r *Run) error {
					r.Status = StateCancelled
					r.CancelRequestedAt = stamp(runtimeStoreTestTime)
					return saveRun(context.Background(), tx, r)
				})
				if err != nil {
					t.Fatal(err)
				}
			}
			o, _ = readOperation(context.Background(), m.store.db, o.ID)
			status := tools.TaskStatus{Outcome: tools.TaskSucceeded, Value: map[string]bool{"done": true}}
			if err := m.settleDomainTask(o, status); err != nil {
				t.Fatal(err)
			}
			after, _ := m.store.get(context.Background(), o.RunID)
			want := StateQueued
			if cancelled {
				want = StateCancelled
			}
			if after.Status != want {
				t.Fatalf("%+v", after)
			}
			used := after.Usage.ResultBytes
			if err := m.settleDomainTask(o, status); err != nil {
				t.Fatal(err)
			}
			after, _ = m.store.get(context.Background(), o.RunID)
			if after.Usage.ResultBytes != used {
				t.Fatal("receipt charged twice")
			}
			assertDomainProtection(t, m, o, "released")
		})
	}
}

func TestEvidenceRecoveryDeadlinePersistsInterruptionAndProtection(t *testing.T) {
	m, o, _ := recoveryOutcomeFixture(t, "deadline")
	if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
		t.Fatal(err)
	}
	o, _ = readOperation(context.Background(), m.store.db, o.ID)
	m.deps.Now = func() time.Time { return runtimeStoreTestTime.Add(2 * time.Minute) }
	if allowed, err := m.recoveryObservation(o); err != nil || allowed {
		t.Fatalf("%v %v", allowed, err)
	}
	r, _ := m.store.get(context.Background(), o.RunID)
	if r.Status != StateInterrupted || r.Recovery == nil || r.Recovery.Status != "unresolved" {
		t.Fatalf("%+v", r)
	}
	assertDomainProtection(t, m, o, "unknown")
}

func TestEvidenceRecoveryRetainsLaterSpecificUnknownCause(t *testing.T) {
	m, o, _ := recoveryOutcomeFixture(t, "specific-unknown")
	if err := m.settleDomainTask(o, tools.TaskStatus{Outcome: tools.TaskUnknown}); err != nil {
		t.Fatal(err)
	}
	o, _ = readOperation(m.ctx, m.store.db, o.ID)
	status := tools.TaskStatus{Outcome: tools.TaskUnknown, ErrorCode: "exec-exited-partial", Error: "命令已结束，已有变更仍待核对", Evidence: &tools.ExecutionEvidence{Execution: "finished", Changes: "unknown", Recovery: "verify"}}
	if err := m.settleDomainTask(o, status); err != nil {
		t.Fatal(err)
	}
	o, _ = readOperation(m.ctx, m.store.db, o.ID)
	calls, _ := m.Calls(m.ctx, o.RunID, "", 10)
	r, _ := m.Get(m.ctx, o.RunID)
	if o.Error == nil || o.Error.Code != status.ErrorCode || o.Error.Evidence == nil || len(calls.Items) != 1 {
		t.Fatalf("specific unknown evidence lost: %+v", o.Error)
	}
	content := toolFactContent(projectToolExecution(r, &o, &calls.Items[0], nil), &calls.Items[0])
	if !strings.Contains(content, status.ErrorCode) || !strings.Contains(content, "outcome-unknown") {
		t.Fatal("model lost specific reason or unknown protection")
	}
	before := r.Usage
	if err := m.settleDomainTask(o, status); err != nil {
		t.Fatal(err)
	}
	after, _ := m.Get(m.ctx, o.RunID)
	if after.Usage != before {
		t.Fatal("same observation charged twice")
	}
	assertDomainProtection(t, m, o, "unknown")
}

func TestNoProgressIgnoresRequestIDsAndRepeatedSearch(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	_, task, r := sessionStoreFixture(t, s, "no-progress", runtimeStoreTestTime)
	r = acceptSessionTestRun(t, s, task, r, true)
	r.DriverVersion = "v2"
	r.RecoveryPolicy = evidenceRecoveryPolicy
	m := &Manager{store: s}
	err := s.write(context.Background(), "failures", func(tx *sql.Tx) error {
		for i := 0; i < 3; i++ {
			c := Call{ID: string(rune('a' + i)), RunID: r.ID, Tool: "docker_container_create_service", Status: StateFailed, StepIndex: i, Args: map[string]any{"name": "mysql84", "requestId": string(rune('a' + i))}, Error: &Failure{Code: "input-invalid", Message: "缺少库名"}}
			if err := saveCall(context.Background(), tx, c); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := (&agentExecution{run: r, manager: m}).checkRecoveryProgress(context.Background()); err == nil {
		t.Fatal("random IDs reset progress limit")
	}
}

func TestRecoveryFingerprintNormalizesNumbersWithoutLosingPrecision(t *testing.T) {
	a := recoveryArguments(Call{ArgumentsJSON: `{"port":3306,"requestId":"a"}`})
	b := recoveryArguments(Call{ArgumentsJSON: `{"requestId":"b","port":3.306e3}`})
	c := recoveryArguments(Call{ArgumentsJSON: `{"port":"3306"}`})
	if a != b || a == c {
		t.Fatal("request identity or numeric spelling reset progress")
	}
	if recoveryArguments(Call{ArgumentsJSON: `{"n":9007199254740993}`}) == recoveryArguments(Call{ArgumentsJSON: `{"n":9007199254740992}`}) {
		t.Fatal("large identifiers lost precision")
	}
}

func TestReadRetriesAreAuthorizedCountedAndPersisted(t *testing.T) {
	var executions atomic.Int32
	plugin := &kardia.Plugin{Name: "retry-read-fixture", Inject: kardia.InjectMap{tools.ServiceName: nil}, Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		return nil, tools.RegisterAll(c, tools.Descriptor{Name: "docker_images_list", Description: "读取镜像", Parameters: tools.Schema{Type: tools.SchemaObject}, Metadata: tools.Metadata{Domain: "docker", Action: "images_list", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}, Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) {
			ctx := tools.Lifetime(c)
			if err := tools.ConsumeBackend(ctx, tools.DispatchID(ctx)); err != nil {
				return nil, err
			}
			if executions.Add(1) < 3 {
				return nil, &tools.BusinessError{Code: "read-temporary", Message: "读取通道暂不可用", Retryable: true}
			}
			return map[string]bool{"readConfirmed": true}, nil
		}})
	}}
	bridge, err := toolbridge.NewWithPlugins(nil, plugin)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bridge.Close(context.Background()) })
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if strings.Contains(allRequestText(r), "readConfirmed") {
			return finalReply("读取成功"), nil
		}
		if !contains(toolNames(r), "docker_images_list") {
			return searchReply("docker_images_list"), nil
		}
		return toolReply("docker_images_list"), nil
	}, func(d *Deps) { d.Tools = bridge; d.Catalog = &Extensions{} })
	r := submitAgentTest(t, m, session, "retry-safe-read", "读取镜像")
	finished := runtimeFinished(t, m, r.ID)
	if finished.Status != StateSucceeded || executions.Load() != 3 || finished.Usage.Calls != 3 {
		t.Fatalf("status=%s calls=%d executed=%d error=%+v", finished.Status, finished.Usage.Calls, executions.Load(), finished.Error)
	}
	calls, _ := m.Calls(context.Background(), r.ID, "", 50)
	for _, call := range calls.Items {
		if call.Tool == "docker_images_list" && (len(call.Attempts) != 3 || call.Attempts[2].Error != nil) {
			t.Fatalf("attempt facts %+v", call.Attempts)
		}
	}
}

func TestStructuredFailureReportPersistsFactsWithoutParametersOrResults(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	session, task, r := sessionStoreFixture(t, s, "structured-report", runtimeStoreTestTime)
	r = acceptSessionTestRun(t, s, task, r, true)
	_, err := s.change(context.Background(), r.ID, "report-fixture", func(tx *sql.Tx, current *Run) error {
		current.DriverVersion = "v2"
		current.RecoveryPolicy = evidenceRecoveryPolicy
		for i, state := range []string{StateSucceeded, StateFailed, StateInterrupted} {
			call := Call{ID: string(rune('a' + i)), RunID: r.ID, Tool: "docker_container_exec", Status: state, StepIndex: i, Args: map[string]any{"password": "SECRET_ARGUMENT"}, Result: json.RawMessage(`{"secret":"SECRET_RESULT"}`)}
			if state == StateFailed {
				call.Error = &Failure{Code: "preflight", Message: "需要更新登记版本", Evidence: &tools.ExecutionEvidence{Execution: "not-started", Changes: "none"}}
			}
			if err := saveCall(context.Background(), tx, call); err != nil {
				return err
			}
		}
		return saveRun(context.Background(), tx, current)
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := finishFailedTestRun(s, r.ID, StateInterrupted, &Failure{Code: "outcome-unknown", Message: "缺少可信结束回执"}); err != nil {
		t.Fatal(err)
	}
	stored, _ := s.get(context.Background(), r.ID)
	if stored.Report == nil || stored.Report.Completed != 1 || stored.Report.Failed != 1 || stored.Report.Unconfirmed != 1 {
		t.Fatalf("%+v", stored.Report)
	}
	page, err := s.messages(context.Background(), session.ID, "", 100)
	if err != nil || len(page.Items) != 2 {
		t.Fatal(err)
	}
	text := page.Items[1].Content
	if strings.Contains(text, "SECRET_") || !strings.Contains(text, "需要更新登记版本") || !strings.Contains(text, "下一步") {
		t.Fatalf("unsafe or incomplete report: %s", text)
	}
}

func TestModelTransientRetryKeepsBudgetAndRestoresResponse(t *testing.T) {
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if requests.Add(1) < 3 {
			return model.Response{}, &model.Error{Status: 502, Code: "model-rate-limited", Message: "模型服务暂时限流", Retryable: true}
		}
		return finalReply("模型通道已恢复，没有执行变更"), nil
	}, nil)
	r := submitAgentTest(t, m, session, "model-transient-retry", "查询状态")
	finished := runtimeFinished(t, m, r.ID)
	if finished.Status != StateSucceeded || requests.Load() != 3 || finished.Usage.ModelRequests != 4 || finished.Recovery == nil || finished.Recovery.Status != "recovered" {
		t.Fatalf("%+v requests=%d", finished, requests.Load())
	}
	records, _ := m.ModelRequests(context.Background(), r.ID, "", 50)
	if records.Items[0].Status != StateFailed || records.Items[1].Status != StateFailed || records.Items[0].EstimatedTokens == 0 {
		t.Fatal("failed requests were not durably charged")
	}
}

func TestModelRetryCancellationPreservesFactsAndStopsRecoveryLabel(t *testing.T) {
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		requests.Add(1)
		return model.Response{}, &model.Error{Code: "model-rate-limited", Message: "暂时限流", Retryable: true}
	}, nil)
	r := submitAgentTest(t, m, session, "cancel-model-retry", "查询")
	runtimeEventually(t, func() bool {
		current, _ := m.Get(m.ctx, r.ID)
		return current.Recovery != nil && current.Recovery.Status == "correcting"
	})
	if _, err := m.Cancel(m.ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	done := runtimeFinished(t, m, r.ID)
	if done.Status != StateCancelled || requests.Load() != 1 || done.Report == nil || done.Recovery == nil || done.Recovery.Status != "exhausted" {
		t.Fatalf("retry revived after cancellation: status=%s requests=%d recovery=%+v", done.Status, requests.Load(), done.Recovery)
	}
}

func TestFailureAnalysisIsToolFreeAndOnlyRequestedOnce(t *testing.T) {
	var summaries atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "none" {
			summaries.Add(1)
			if len(r.Tools) != 0 {
				t.Error("summary exposed tools")
			}
			return finalReply("模型服务持续不可用，当前未执行业务变更。"), nil
		}
		return model.Response{}, &model.Error{Status: 502, Code: "model-auth-failed", Message: "模型服务鉴权失败"}
	}, nil)
	r := submitAgentTest(t, m, session, "summary-once", "查询状态")
	finished := runtimeFinished(t, m, r.ID)
	if finished.Status != StateFailed || summaries.Load() != 1 || finished.Report == nil || finished.Report.Analysis == "" {
		t.Fatalf("status=%s summaries=%d report=%+v", finished.Status, summaries.Load(), finished.Report)
	}
	if finished.Usage.Calls != 0 || finished.Usage.ModelRequests != 2 {
		t.Fatalf("unexpected dispatch %+v", finished.Usage)
	}
}
