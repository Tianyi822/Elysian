package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sync/atomic"
	"testing"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
)

type demandTestCatalog struct{ operationCatalog }

func (c *demandTestCatalog) Prepare(_ context.Context, s CapabilitySnapshot, o Operation) (Operation, error) {
	if s.AuthorizationMode != AuthorizationOnDemand {
		return o, nil
	}
	if o.Capability.Name != "test_write" {
		return o, nil
	}
	o.Access = &AccessRequest{Revision: 1, Kind: "mcp", Directories: []execconfig.Directory{}, Network: []execconfig.NetworkEndpoint{}, PrivateCIDRs: []string{}, Resources: []execconfig.Resource{}, SessionAllowed: true}
	o.Access.ScopeKey = accessScopeKey(o)
	o.Access.Digest = accessDigest(o)
	return o, nil
}
func accessInput(a Approval, decision, request string) AccessDecision {
	return AccessDecision{RequestID: request, ExpectedRevision: a.Access.Revision, ExpectedDigest: a.Access.Digest, Decision: decision}
}
func submitDemand(t *testing.T, m *Manager, s Session, id string) Run {
	t.Helper()
	r, _, err := m.CreateTask(context.Background(), s.ID, AgentInput{RequestID: id, Content: "执行一次测试操作", AuthorizationMode: AuthorizationOnDemand})
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func TestRuntimeAccessNewRunsNeverRememberSessionScope(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	cat := &demandTestCatalog{operationCatalog{execute: func(_ context.Context, o Operation) (CapabilityResult, error) {
		calls.Add(1)
		if o.Authorization == nil || o.Authorization.SessionAuthorizationID != "" {
			t.Error("派发缺少逐次授权或复用旧会话授权")
		}
		return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
	}}}
	m, s, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
	first := submitDemand(t, m, s, "access-first")
	approval := waitingApproval(t, m, first.ID)
	_, err := m.DecideAccess(ctx, approval.ID, accessInput(approval, "session", "reject-session"))
	runtimeErrorCode(t, err, "session-authorization-denied")
	input := accessInput(approval, "once", "allow-once")
	m = reopenOperationManager(t, m)
	if _, err := m.DecideAccess(ctx, approval.ID, input); err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, first.ID); done.Status != StateSucceeded || calls.Load() != 1 {
		t.Fatalf("逐次授权恢复失败: %+v", done)
	}
	if _, err := m.DecideAccess(ctx, approval.ID, input); err != nil {
		t.Fatal("重试不幂等", err)
	}
	// 持久化存量允许项，新运行也必须重新询问。
	if err := m.store.write(ctx, "legacy-authorization-fixture", func(tx *sql.Tx) error {
		return saveSessionAuthorization(ctx, tx, SessionAuthorization{ID: "legacy-allow", SessionID: s.ID, Revision: 1, Status: "active", Access: *approval.Access})
	}); err != nil {
		t.Fatal(err)
	}
	second := submitDemand(t, m, s, "access-second")
	again := waitingApproval(t, m, second.ID)
	if calls.Load() != 1 {
		t.Fatal("新运行复用了旧会话允许项")
	}
	if _, err := m.DecideAccess(ctx, again.ID, accessInput(again, "denied", "deny-again")); err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, second.ID); done.Status != StateSucceeded || calls.Load() != 1 {
		t.Fatalf("拒绝后仍执行: %+v", done)
	}
	rows, err := m.SessionAuthorizations(ctx, s.ID)
	if err != nil || len(rows) != 1 || rows[0].ID != "legacy-allow" {
		t.Fatalf("改写旧授权或创建新授权: %+v %v", rows, err)
	}
}

func readRecordCount(t *testing.T, s *store, id string) int {
	t.Helper()
	var n int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM agent_record_outbox WHERE fact_type='session_authorizations' AND fact_key=?", id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
func TestRuntimeAccessDenialCannotBeReaskedInSameRun(t *testing.T) {
	var inferences, calls atomic.Int32
	cat := &demandTestCatalog{operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		calls.Add(1)
		return CapabilityResult{}, nil
	}}}
	client := func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		if missingOperationTools(r, "test_write") {
			return searchReply("test"), nil
		}
		if inferences.Add(1) <= 2 {
			return toolReply("test_write"), nil
		}
		return finalReply("改为只解释方案"), nil
	}
	m, s, _ := agentManager(t, client, func(d *Deps) { d.Catalog = cat })
	run := submitDemand(t, m, s, "denied-repeat")
	a := waitingApproval(t, m, run.ID)
	if _, err := m.DecideAccess(context.Background(), a.ID, accessInput(a, "denied", "refuse-one")); err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded || calls.Load() != 0 {
		t.Fatalf("拒绝后未继续/重派发: %+v calls=%d", got, calls.Load())
	}
	approvals, err := m.ApprovalsByRun(context.Background(), "", run.ID)
	if err != nil || len(approvals) != 1 {
		t.Fatalf("重复索取权限: %+v %v", approvals, err)
	}
}
func TestRuntimeAccessScopeSeparatesActionsResourcesAndScripts(t *testing.T) {
	base := Operation{Capability: Capability{Name: "restart", Source: "builtin"}, ArgumentsJSON: `{"id":"A"}`, Access: &AccessRequest{Kind: "platform", Resources: []execconfig.Resource{{Domain: "docker-container", ID: "A", Access: "write"}}, SessionAllowed: true}}
	key := accessScopeKey(base)
	changed := base
	changed.Capability.Name = "delete"
	if accessScopeKey(changed) == key {
		t.Fatal("不同动作共享授权")
	}
	copyAccess := *base.Access
	changed = base
	changed.Access = &copyAccess
	changed.Access.Resources = []execconfig.Resource{{Domain: "docker-container", ID: "B", Access: "write"}}
	if accessScopeKey(changed) == key {
		t.Fatal("不同资源共享授权")
	}
	script := Operation{Capability: Capability{Name: BashExec, Source: BashSource}, ArgumentsJSON: `{"command":"echo first"}`, Access: &AccessRequest{Kind: "script", Runtime: &AccessRuntime{Name: "bash", Image: "repo@sha256:one", Platform: "linux/amd64"}, Directories: []execconfig.Directory{{Path: "/srv/app", Access: "ro"}}, SessionAllowed: true}}
	script.Execution = &ExecutionPlan{Profile: execconfig.Profile{Runtime: "bash", Command: []string{"bash"}, CPUMillis: 500, MemoryBytes: 256 << 20, PIDs: 64, TimeoutSeconds: 300}}
	scriptKey := accessScopeKey(script)
	script.Execution.Profile.CPUMillis = 1000
	if accessScopeKey(script) == scriptKey {
		t.Fatal("提高 CPU 限额仍复用")
	}
	script.Execution.Profile.CPUMillis = 500
	script.Execution.Profile.TimeoutSeconds = 200
	if accessScopeKey(script) != scriptKey {
		t.Fatal("剩余时限改变了权限范围而非授权上限")
	}
	script.Capability.Ref = RevisionRef{ID: "skill", Revision: 2, Digest: "skill-body"}
	if accessScopeKey(script) != scriptKey {
		t.Fatal("同环境内不同脚本不能复用")
	}

	script.ArgumentsJSON = `{"command":"echo second"}`
	if accessScopeKey(script) != scriptKey {
		t.Fatal("范围内不同命令无法复用")
	}
	script.Access.Directories[0].Access = "rw"
	if accessScopeKey(script) == scriptKey {
		t.Fatal("提高权限仍复用")
	}
	mcp := base
	mcp.Access = &AccessRequest{Kind: "mcp"}
	mcp.Capability = Capability{Name: "mcp", Ref: RevisionRef{ID: "server", Revision: 1}, CatalogDigest: "one"}
	mcpKey := accessScopeKey(mcp)
	mcp.ArgumentsJSON = `{"id":"B"}`
	if accessScopeKey(mcp) == mcpKey {
		t.Fatal("未知 MCP 目标参数共享授权")
	}
	mcp.ArgumentsJSON = base.ArgumentsJSON
	mcp.Capability.CatalogDigest = "two"
	if accessScopeKey(mcp) == mcpKey {
		t.Fatal("MCP 目录变化仍复用")
	}
}

func TestFullModePersistsExactRuntimeAuthorizationBeforeDispatch(t *testing.T) {
	var m *Manager
	var calls atomic.Int32
	cat := &demandTestCatalog{operationCatalog{execute: func(ctx context.Context, o Operation) (CapabilityResult, error) {
		stored, err := readOperation(ctx, m.store.db, o.ID)
		if err != nil || stored.Authorization == nil || stored.Authorization.Digest != o.Access.Digest || stored.Authorization.SessionAuthorizationID != "" {
			t.Errorf("授权未精确落盘: %+v %v", stored.Authorization, err)
		}
		var records int
		if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM agent_record_outbox WHERE fact_type='operations' AND fact_key=?", o.ID).Scan(&records); err != nil || records == 0 {
			t.Errorf("缺少同事务 JSONL 账本: %d %v", records, err)
		}
		calls.Add(1)
		return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
	}}}
	var s Session
	m, s, _ = agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
	run, _, err := m.CreateTask(context.Background(), s.ID, AgentInput{RequestID: "full-runtime", Content: "执行操作", AuthorizationMode: AuthorizationOnDemand, PermissionMode: PermissionFull})
	if err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, run.ID); done.Status != StateSucceeded || calls.Load() == 0 {
		t.Fatalf("完全开放未自动执行: %+v", done)
	}
	approvals, err := m.Approvals(context.Background())
	if err != nil || len(approvals) != 0 {
		t.Fatalf("完全开放仍创建手动审批: %+v %v", approvals, err)
	}
}

func TestAutomaticRuntimeAuthorizationReplicaFailureBlocksDispatch(t *testing.T) {
	var calls atomic.Int32
	cat := &demandTestCatalog{operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		calls.Add(1)
		return CapabilityResult{}, nil
	}}}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
	m.mu.Lock()
	m.store.beforeWrite = func(op string) error {
		if op == "access-auto-decision" {
			m.store.recordHook = func(stage string) error {
				if stage == "append" {
					return errors.New("injected auto authorization replica failure")
				}
				return nil
			}
		}
		return nil
	}
	m.mu.Unlock()
	run, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "automatic-replica-fault", Content: "执行操作", AuthorizationMode: AuthorizationOnDemand, PermissionMode: PermissionFull})
	if err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool { return m.store.recordsFault() != nil })
	operations, err := m.Operations(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, operation := range operations {
		if operation.Access != nil {
			found = true
			if operation.Authorization == nil || operation.DispatchID != "" {
				t.Fatalf("自动授权回执丢失或已经派发: %+v", operation)
			}
		}
	}
	if !found || calls.Load() != 0 {
		t.Fatalf("副本故障后仍派发: found=%v calls=%d", found, calls.Load())
	}
}
