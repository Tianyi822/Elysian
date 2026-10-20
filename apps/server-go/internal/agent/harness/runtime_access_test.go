package harness

import (
	"context"
	"encoding/json"
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
func TestRuntimeAccessRestoresAndRemembersOnlyExactSessionScope(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	cat := &demandTestCatalog{operationCatalog{execute: func(_ context.Context, o Operation) (CapabilityResult, error) {
		if o.Capability.Name == "test_write" {
			calls.Add(1)
			if o.Authorization == nil {
				t.Error("未授权就派发")
			}
		}
		return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
	}}}
	m, s, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = cat })
	first := submitDemand(t, m, s, "access-first")
	a := waitingApproval(t, m, first.ID)
	if a.Access == nil || calls.Load() != 0 {
		t.Fatal("缺少运行时请求或提前派发")
	}
	original := first.Snapshot.Digest
	_, err := m.Decide(ctx, a.ID, "approved")
	runtimeErrorCode(t, err, "access-decision-required")
	in := accessInput(a, "session", "approve-first")
	wrong := in
	wrong.ExpectedDigest = "wrong"
	_, err = m.DecideAccess(ctx, a.ID, wrong)
	runtimeErrorCode(t, err, "access-conflict")
	m = reopenOperationManager(t, m)
	if _, err = m.DecideAccess(ctx, a.ID, in); err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, first.ID)
	if got.Status != StateSucceeded || got.Snapshot.Digest != original || calls.Load() != 1 {
		t.Fatalf("恢复失败或改写快照: %+v calls=%d", got, calls.Load())
	}
	if _, err = m.DecideAccess(ctx, a.ID, in); err != nil {
		t.Fatal("确认重试不幂等", err)
	}
	conflict := in
	conflict.Decision = "once"
	_, err = m.DecideAccess(ctx, a.ID, conflict)
	runtimeErrorCode(t, err, "decision-conflict")
	remembered, err := m.SessionAuthorizations(ctx, s.ID)
	if err != nil || len(remembered) != 1 {
		t.Fatalf("会话授权未保存: %+v %v", remembered, err)
	}
	second := submitDemand(t, m, s, "access-second")
	if got = runtimeFinished(t, m, second.ID); got.Status != StateSucceeded || calls.Load() != 2 {
		t.Fatalf("相同范围未复用: %+v", got)
	}
	other, err := m.CreateSession(ctx, CreateSessionInput{Title: "隔离会话", ModelProfileID: s.ModelProfileID, ModelRevision: s.ModelRevision})
	if err != nil {
		t.Fatal(err)
	}
	third := submitDemand(t, m, other, "access-other")
	otherApproval := waitingApproval(t, m, third.ID)
	if otherApproval.Access == nil || calls.Load() != 2 {
		t.Fatal("跨会话复用授权")
	}
	if _, err = m.Cancel(ctx, third.ID); err != nil {
		t.Fatal(err)
	}
	_, err = m.DecideAccess(ctx, otherApproval.ID, accessInput(otherApproval, "once", "cancelled-answer"))
	if err == nil {
		t.Fatal("取消后仍允许授权")
	}
	revoke := RevokeAuthorizationInput{RequestID: "revoke-one", ExpectedRevision: remembered[0].Revision}
	if _, err = m.RevokeSessionAuthorization(ctx, s.ID, remembered[0].ID, revoke); err != nil {
		t.Fatal(err)
	}
	if _, err = m.RevokeSessionAuthorization(ctx, s.ID, remembered[0].ID, revoke); err != nil {
		t.Fatal("撤回重试不幂等", err)
	}
	fourth := submitDemand(t, m, s, "access-after-revoke")
	again := waitingApproval(t, m, fourth.ID)
	if _, err = m.DecideAccess(ctx, again.ID, accessInput(again, "denied", "refuse-after-revoke")); err != nil {
		t.Fatal(err)
	}
	if got = runtimeFinished(t, m, fourth.ID); got.Status != StateSucceeded || calls.Load() != 2 {
		t.Fatalf("拒绝未交回模型或发生执行: %+v", got)
	}
	lines := readRecordCount(t, m.store, remembered[0].ID)
	if lines < 2 {
		t.Fatal("授权与撤回缺少同事务记录")
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
