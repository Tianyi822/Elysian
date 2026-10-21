package harness

import (
	"context"
	"database/sql"
	"elysian/server/internal/agent/harness/model"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func workflowLiteral(s string) WorkflowBinding { return WorkflowBinding{LiteralJSON: &s} }
func workflowStepsTest(t *testing.T, m *Manager, s Session, steps []WorkflowStepDefinition) WorkflowInstance {
	return startWorkflowAgentTest(t, m, s, steps)
}
func workflowTestManager(t *testing.T, c *operationCatalog) (*Manager, Session) {
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("源会话仍可独立运行"), nil
	}, func(d *Deps) { d.Catalog = c })
	approveEnvironment(t, m, s)
	return m, s
}
func workflowWait(t *testing.T, m *Manager, id, state string) WorkflowInstance {
	t.Helper()
	var w WorkflowInstance
	runtimeEventually(t, func() bool {
		var e error
		w, e = m.GetWorkflow(context.Background(), id)
		return e == nil && w.Status == state
	})
	return w
}
func workflowIdle(t *testing.T, m *Manager) {
	t.Helper()
	runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.activeID == "" })
}
func workflowOneOperation(name string) []WorkflowStepDefinition {
	return []WorkflowStepDefinition{{ID: "act", Kind: "operation", Capability: name, Input: workflowLiteral(`{"n":9007199254740993}`), OutputSchemaJSON: `{"type":"object"}`, Finish: &WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "act"}}}}
}
func TestWorkflowConditionGateOperationAndIsolation(t *testing.T) {
	ctx := context.Background()
	var writes atomic.Int32
	m, s := workflowTestManager(t, &operationCatalog{execute: func(_ context.Context, o Operation) (CapabilityResult, error) {
		writes.Add(1)
		if o.Source != "workflow" || o.ModelRequestID != "" || o.ArgumentsJSON != `{"n":9007199254740993}` {
			t.Errorf("静态操作来源或精度错误：%+v", o)
		}
		return CapabilityResult{Value: json.RawMessage(`{"done":true}`)}, nil
	}})
	yes := workflowLiteral("true")
	steps := []WorkflowStepDefinition{
		{ID: "choose", Kind: "condition", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Condition: &WorkflowCondition{Op: "eq", Left: &yes, Right: &yes}, Then: "confirm", Else: "skip"},
		{ID: "confirm", Kind: "approval", Instruction: "确认执行这次变更", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Next: "write"},
		{ID: "write", Kind: "operation", Capability: "test_write", Input: workflowLiteral(`{"n":9007199254740993}`), OutputSchemaJSON: `{"type":"object"}`, Finish: &WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "write"}}},
		{ID: "skip", Kind: "approval", Instruction: "确认结束", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Finish: &WorkflowBinding{Step: &WorkflowOutputBinding{StepID: "skip"}}},
	}
	w := workflowStepsTest(t, m, s, steps)
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	a := waitingApproval(t, m, w.ActiveRunID)
	if a.Kind != "workflow-gate" || a.OperationID != "" {
		t.Fatalf("业务确认伪装为操作：%+v", a)
	}
	_, _, e := m.CreateTask(ctx, w.SessionID, AgentInput{RequestID: "busy-workflow", Content: "抢占"})
	runtimeErrorCode(t, e, "session-busy")
	if _, e = m.SwitchSessionModel(ctx, w.SessionID, SwitchModelInput{ModelProfileID: s.ModelProfileID, ModelRevision: s.ModelRevision}); e == nil {
		t.Fatal("流程占用期间切换模型")
	}
	other := submitAgentTest(t, m, s, "source-free", "源会话继续")
	if runtimeFinished(t, m, other.ID).Status != StateSucceeded {
		t.Fatal("流程等待占住全局槽")
	}
	if _, e = m.Decide(ctx, a.ID, "approved"); e != nil {
		t.Fatal(e)
	}
	runtimeEventually(t, func() bool {
		w, _ = m.GetWorkflow(ctx, w.ID)
		return w.Status == StateWaitingApproval && w.CurrentStepID == "write"
	})
	a = waitingApproval(t, m, w.ActiveRunID)
	if writes.Load() != 0 || a.Kind != "operation" {
		t.Fatal("业务确认绕过操作审批")
	}
	m = reopenOperationManager(t, m)
	if _, e = m.Decide(ctx, a.ID, "approved"); e != nil {
		t.Fatal(e)
	}
	w = workflowWait(t, m, w.ID, StateSucceeded)
	if writes.Load() != 1 || w.OutputJSON != `{"done":true}` {
		t.Fatalf("写入重复或结果不完整 %+v", w)
	}
	session, e := m.GetSession(ctx, w.SessionID)
	if e != nil || session.ActiveWorkflowID != "" {
		t.Fatal("终态未释放会话")
	}
	m = reopenOperationManager(t, m)
	time.Sleep(20 * time.Millisecond)
	if writes.Load() != 1 {
		t.Fatal("重启重放成功操作")
	}
}
func TestWorkflowExpiryRenewalAndDenial(t *testing.T) {
	ctx := context.Background()
	m, s := workflowTestManager(t, &operationCatalog{})
	w := workflowStepsTest(t, m, s, workflowOneOperation("test_write"))
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	a := waitingApproval(t, m, w.ActiveRunID)
	workflowIdle(t, m)
	m.mu.Lock()
	e := m.store.write(ctx, "expire-test", func(tx *sql.Tx) error {
		a.ExpiresAt = stamp(time.Now().Add(-time.Hour))
		return saveApproval(ctx, tx, a)
	})
	m.mu.Unlock()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = m.Approvals(ctx); e != nil {
		t.Fatal(e)
	}
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	input := WorkflowRecoveryInput{RequestID: "renew-1", ExpectedRevision: w.Revision, Action: "renew-approval", Evidence: "审批过期，操作尚未派发"}
	renewed, dup, e := m.RecoverWorkflow(ctx, w.ID, input)
	if e != nil || dup {
		t.Fatalf("续批失败：%v", e)
	}
	same, dup, e := m.RecoverWorkflow(ctx, w.ID, input)
	if e != nil || !dup || same.Revision != renewed.Revision {
		t.Fatal("恢复不幂等")
	}
	b := waitingApproval(t, m, w.ActiveRunID)
	if b.ID == a.ID || b.OperationID != a.OperationID {
		t.Fatal("续批没有保留原操作身份")
	}
	if _, e = m.Decide(ctx, a.ID, "approved"); e == nil {
		t.Fatal("旧审批恢复权限")
	}
	if _, e = m.Decide(ctx, b.ID, "denied"); e != nil {
		t.Fatal(e)
	}
	w = workflowWait(t, m, w.ID, StateFailed)
	_, _, e = m.RecoverWorkflow(ctx, w.ID, WorkflowRecoveryInput{RequestID: "undo-deny", ExpectedRevision: w.Revision, Action: "retry", Evidence: "试图覆盖拒绝"})
	runtimeErrorCode(t, e, "workflow-state")
}
func TestWorkflowRetryCreatesNewAttemptAndApproval(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	m, s := workflowTestManager(t, &operationCatalog{execute: func(_ context.Context, _ Operation) (CapabilityResult, error) {
		if calls.Add(1) == 1 {
			return CapabilityResult{BusinessError: &Failure{Code: "business-error", Message: "业务失败"}}, nil
		}
		return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
	}})
	w := workflowStepsTest(t, m, s, workflowOneOperation("test_write"))
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	first := waitingApproval(t, m, w.ActiveRunID)
	if _, e := m.Decide(ctx, first.ID, "approved"); e != nil {
		t.Fatal(e)
	}
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	workflowIdle(t, m)
	oldID := w.ActiveRunID
	_, _, e := m.RecoverWorkflow(ctx, w.ID, WorkflowRecoveryInput{RequestID: "retry-1", ExpectedRevision: w.Revision, Action: "retry", Evidence: "已核实第一次业务失败，明确再尝试一次"})
	if e != nil {
		t.Fatal(e)
	}
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	second := waitingApproval(t, m, w.ActiveRunID)
	if second.ID == first.ID || w.ActiveRunID == oldID || calls.Load() != 1 {
		t.Fatal("重试复用了授权或自动执行")
	}
	if _, e = m.Decide(ctx, second.ID, "approved"); e != nil {
		t.Fatal(e)
	}
	w = workflowWait(t, m, w.ID, StateSucceeded)
	old, e := m.Get(ctx, oldID)
	if e != nil || old.Status != StateFailed || w.Usage.Calls != 2 {
		t.Fatal("旧记录被改写或预算被重置")
	}
}
func TestWorkflowUnknownRequiresReconciliationAndSeparateReceipt(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	m, s := workflowTestManager(t, &operationCatalog{execute: func(_ context.Context, _ Operation) (CapabilityResult, error) {
		calls.Add(1)
		return CapabilityResult{Unknown: true}, nil
	}})
	w := workflowStepsTest(t, m, s, workflowOneOperation("test_write"))
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	a := waitingApproval(t, m, w.ActiveRunID)
	if _, e := m.Decide(ctx, a.ID, "approved"); e != nil {
		t.Fatal(e)
	}
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	workflowIdle(t, m)
	input := WorkflowRecoveryInput{RequestID: "accept-1", ExpectedRevision: w.Revision, Action: "accept-result", Evidence: "外部业务审计编号 123 确认完成", OutputJSON: `{"done":true}`}
	_, _, e := m.RecoverWorkflow(ctx, w.ID, input)
	runtimeErrorCode(t, e, "execution-barrier")
	barriers, e := m.Barriers(ctx)
	if e != nil || len(barriers) != 1 {
		t.Fatal("缺少执行屏障")
	}
	if _, e = m.Reconcile(ctx, barriers[0].ID, input.Evidence, "confirmed-completed"); e != nil {
		t.Fatal(e)
	}
	oldRun := w.ActiveRunID
	w, _, e = m.RecoverWorkflow(ctx, w.ID, input)
	if e != nil || w.Status != StateSucceeded {
		t.Fatalf("人工补录失败：%v %+v", e, w)
	}
	r, e := m.Get(ctx, oldRun)
	if e != nil || r.Status == StateSucceeded || calls.Load() != 1 {
		t.Fatal("人工凭据重写了执行事实")
	}
}
func TestWorkflowConcurrentIdempotencyAndHTTP(t *testing.T) {
	ctx := context.Background()
	m, s := workflowTestManager(t, &operationCatalog{})
	d, e := m.PutWorkflowDefinition(ctx, "", 0, WorkflowDefinition{Name: "幂等模板", Enabled: true, Goal: "检查", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: `{"type":"object"}`, Entry: "act", Steps: workflowOneOperation("test_write")})
	if e != nil {
		t.Fatal(e)
	}
	input := CreateWorkflowInput{RequestID: "same-accept", DefinitionID: d.ID, DefinitionRevision: d.Revision, SourceSessionID: s.ID, InputJSON: `{}`}
	var wg sync.WaitGroup
	var created atomic.Int32
	ids := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w, dup, e := m.CreateWorkflow(ctx, input)
			if e != nil {
				t.Error(e)
				return
			}
			if !dup {
				created.Add(1)
			}
			ids <- w.ID
		}()
	}
	wg.Wait()
	close(ids)
	var id string
	for got := range ids {
		if id != "" && id != got {
			t.Fatal("重复创建实例")
		}
		id = got
	}
	if created.Load() != 1 {
		t.Fatal("幂等接受不原子")
	}
	workflowWait(t, m, id, StateWaitingApproval)
	d.Enabled = false
	if _, e = m.PutWorkflowDefinition(ctx, d.ID, d.Revision, d); e != nil {
		t.Fatal(e)
	}
	if same, dup, e := m.CreateWorkflow(ctx, input); e != nil || !dup || same.ID != id {
		t.Fatal("停用优先于幂等")
	}
}
func TestWorkflowMaintenanceFenceRevokesApprovalAndSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	m, s := workflowTestManager(t, &operationCatalog{})
	w := workflowStepsTest(t, m, s, workflowOneOperation("test_write"))
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	a := waitingApproval(t, m, w.ActiveRunID)
	workflowIdle(t, m)
	path := filepath.Join(t.TempDir(), "fence.json")
	raw, _ := json.Marshal(map[string]any{"version": 1, "reason": "panel-rollback", "createdAt": stamp(time.Now())})
	if e := os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	m.deps.WorkflowRecoveryFence = path
	m = reopenOperationManager(t, m)
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	if _, e := m.Decide(ctx, a.ID, "approved"); e == nil {
		t.Fatal("恢复后的旧审批仍有效")
	}
	if _, e := os.Stat(path); !errors.Is(e, os.ErrNotExist) {
		t.Fatal("冻结标记未在事务后消费")
	}
	input := WorkflowRecoveryInput{RequestID: "after-restore", ExpectedRevision: w.Revision, Action: "renew-approval", Evidence: "已核对当前外部事实与固定操作"}
	if _, _, e := m.RecoverWorkflow(ctx, w.ID, input); e != nil {
		t.Fatal(e)
	}
	b := waitingApproval(t, m, w.ActiveRunID)
	if b.ID == a.ID {
		t.Fatal("恢复复用了旧授权")
	}
}
