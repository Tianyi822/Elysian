package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/workspace"
)

func workflowV2LeafBody() WorkflowBody {
	finish := workflowTestOutput("read", "")
	return WorkflowBody{Entry: "read", OutputSchemaJSON: `{"type":"object"}`, Steps: []WorkflowStepDefinition{{ID: "read", Kind: "operation", Capability: "test_read", Input: workflowTestInput(""), OutputSchemaJSON: `{"type":"object"}`, Finish: &finish}}}
}

func workflowV2CompositeDefinition(kind string) WorkflowDefinition {
	finish := workflowTestOutput("compose", "")
	d := WorkflowDefinition{LanguageVersion: WorkflowV2LanguageVersion, Name: "复合流程", Enabled: true, Goal: "隔离分支并持久汇合", InputSchemaJSON: `true`, OutputSchemaJSON: `true`, Entry: "compose", Steps: []WorkflowStepDefinition{{ID: "compose", Kind: kind, Input: workflowTestInput(""), OutputSchemaJSON: `true`, Finish: &finish}}}
	switch kind {
	case "parallel":
		d.Steps[0].Parallel = &WorkflowParallel{Join: "all", Branches: []WorkflowBranch{
			{ID: "left", Input: workflowTestInput("/left"), Body: workflowV2LeafBody()},
			{ID: "right", Input: workflowTestInput("/right"), Body: workflowV2LeafBody()},
		}}
	case "foreach":
		d.Steps[0].Foreach = &WorkflowForeach{Items: workflowTestInput(""), Body: workflowV2LeafBody()}
	}
	return d
}

func createWorkflowV2Test(t *testing.T, m *Manager, source Session, d WorkflowDefinition, input string) WorkflowInstance {
	t.Helper()
	saved, err := m.PutWorkflowDefinition(context.Background(), "", 0, d)
	if err != nil {
		t.Fatal(err)
	}
	w, duplicate, err := m.CreateWorkflow(context.Background(), CreateWorkflowInput{RequestID: "v2:" + saved.ID, DefinitionID: saved.ID, DefinitionRevision: saved.Revision, SourceSessionID: source.ID, InputJSON: input})
	if err != nil || duplicate {
		t.Fatalf("创建 v2 失败 duplicate=%v err=%v", duplicate, err)
	}
	return w
}

func TestWorkflowV2ParallelForeachDurableResultsAndIsolation(t *testing.T) {
	for _, kind := range []string{"parallel", "foreach", "empty-foreach"} {
		t.Run(kind, func(t *testing.T) {
			var calls atomic.Int32
			m, source := workflowTestManager(t, &operationCatalog{execute: func(_ context.Context, op Operation) (CapabilityResult, error) {
				calls.Add(1)
				return CapabilityResult{Value: json.RawMessage(op.ArgumentsJSON)}, nil
			}})
			languageKind, input, expected := kind, `{"left":{"n":9007199254740993},"right":{"n":2}}`, `{"left":{"n":9007199254740993},"right":{"n":2}}`
			if kind == "foreach" {
				input, expected = `[{"n":9007199254740993},{"n":2}]`, `[{"n":9007199254740993},{"n":2}]`
			}
			if kind == "empty-foreach" {
				languageKind, input, expected = "foreach", `[]`, `[]`
			}
			w := createWorkflowV2Test(t, m, source, workflowV2CompositeDefinition(languageKind), input)
			w = workflowWait(t, m, w.ID, StateSucceeded)
			if w.OutputJSON != expected || w.ExecutionTree == nil {
				t.Fatalf("输出或执行树不正确：%+v", w)
			}
			wantCalls, wantScopes := int32(2), 3
			if kind == "empty-foreach" {
				wantCalls, wantScopes = 0, 1
			}
			if calls.Load() != wantCalls || len(w.ExecutionTree.Scopes) != wantScopes {
				t.Fatalf("派发或展开数量错误：calls=%d scopes=%d", calls.Load(), len(w.ExecutionTree.Scopes))
			}
			tasks := map[string]bool{}
			for _, scope := range w.ExecutionTree.Scopes {
				if scope.Status != StateSucceeded || tasks[scope.TaskID] {
					t.Fatalf("分支任务未隔离或未结束：%+v", scope)
				}
				tasks[scope.TaskID] = true
			}
			m = reopenOperationManager(t, m)
			restored, err := m.GetWorkflow(context.Background(), w.ID)
			if err != nil || restored.OutputJSON != expected || len(restored.ExecutionTree.Nodes) != len(w.ExecutionTree.Nodes) || calls.Load() != wantCalls {
				t.Fatalf("重启丢失结果或重放：%+v calls=%d err=%v", restored, calls.Load(), err)
			}
		})
	}
}

func TestWorkflowV2SubworkflowUsesAcceptedDefinitionClosure(t *testing.T) {
	m, source := workflowTestManager(t, &operationCatalog{execute: func(_ context.Context, op Operation) (CapabilityResult, error) {
		return CapabilityResult{Value: json.RawMessage(op.ArgumentsJSON)}, nil
	}})
	body := workflowV2LeafBody()
	child, err := m.PutWorkflowDefinition(context.Background(), "", 0, WorkflowDefinition{LanguageVersion: WorkflowV2LanguageVersion, Name: "固定子流程", Enabled: true, Goal: "原样返回输入", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: body.OutputSchemaJSON, Entry: body.Entry, Steps: body.Steps})
	if err != nil {
		t.Fatal(err)
	}
	d := workflowV2CompositeDefinition("subworkflow")
	d.Steps[0].Subworkflow = &WorkflowSubworkflow{DefinitionID: child.ID, DefinitionRevision: child.Revision}
	w := createWorkflowV2Test(t, m, source, d, `{"n":9007199254740993}`)
	w = workflowWait(t, m, w.ID, StateSucceeded)
	if w.OutputJSON != `{"n":9007199254740993}` || len(w.Definitions) != 2 || len(w.ExecutionTree.Scopes) != 2 {
		t.Fatalf("子流程闭包未执行：%+v", w)
	}
}

func TestWorkflowV2PlainRootLeafCompletesAndReleasesSession(t *testing.T) {
	m, source := workflowTestManager(t, &operationCatalog{})
	body := workflowV2LeafBody()
	d := WorkflowDefinition{LanguageVersion: WorkflowV2LanguageVersion, Name: "叶节点流程", Enabled: true, Goal: "保存根作用域完成结果", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: body.OutputSchemaJSON, Entry: body.Entry, Steps: body.Steps}
	w := createWorkflowV2Test(t, m, source, d, `{}`)
	w = workflowWait(t, m, w.ID, StateSucceeded)
	session, err := m.GetSession(context.Background(), w.SessionID)
	if err != nil || session.ActiveRunID != "" || session.ActiveWorkflowID != "" || w.OutputJSON != `{"ok":true}` {
		t.Fatalf("根叶节点完成未释放会话或保存输出：w=%+v session=%+v err=%v", w, session, err)
	}
}

func TestWorkflowV2ExpansionLimitLeavesNoPartialChildren(t *testing.T) {
	m, source := workflowTestManager(t, &operationCatalog{})
	items := "[" + strings.TrimSuffix(strings.Repeat(`{},`, 33), ",") + "]"
	w := createWorkflowV2Test(t, m, source, workflowV2CompositeDefinition("foreach"), items)
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	if w.Error == nil || w.Error.Code != "workflow-foreach-limit" || !w.GateClosed || len(w.ExecutionTree.Scopes) != 1 || len(w.ExecutionTree.Nodes) != 1 {
		t.Fatalf("超限展开留下了部分子节点：%+v", w)
	}
	if w.ExecutionTree.Nodes[0].Expanded {
		t.Fatal("失败展开错误标记为已展开")
	}
}

func TestWorkflowV2WorkspaceJoinNamespacesChangesAndKeepsParent(t *testing.T) {
	ctx := context.Background()
	backend, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = backend.Close() })
	s, err := openStore(filepath.Join(t.TempDir(), "harness.sqlite"), time.Now)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.close() })
	m := &Manager{store: s, deps: Deps{Workspaces: backend, Now: time.Now, NewID: randomID}}
	w := WorkflowInstance{TaskID: "parent-task"}
	rootNode := WorkflowNodeExecution{ID: "composite-node"}
	children := []WorkflowScope{{TaskID: "child-left", Ordinal: 0}, {TaskID: "child-right", Ordinal: 1}}
	err = s.write(ctx, "tasks-fixture", func(tx *sql.Tx) error {
		for _, id := range []string{w.TaskID, children[0].TaskID, children[1].TaskID} {
			if _, e := tx.ExecContext(ctx, "INSERT INTO tasks(id,request_id,input,document,session_id) VALUES(?,?,?,?,?)", id, id, "{}", "{}", ""); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	parent, err := backend.PrepareWrite(ctx, w.TaskID, 0, "shared.txt", strings.NewReader("parent"))
	if err == nil {
		err = s.write(ctx, "workspace-fixture", func(tx *sql.Tx) error { return commitWorkspaceVersion(ctx, tx, parent) })
	}
	if err != nil {
		t.Fatal(err)
	}
	for _, child := range children {
		base, e := m.copyWorkflowWorkspace(ctx, parent, child.TaskID)
		if e == nil {
			e = s.write(ctx, "fork-workspace-fixture", func(tx *sql.Tx) error { return commitWorkspaceVersion(ctx, tx, base) })
		}
		if e != nil {
			t.Fatal(e)
		}
		version, e := backend.PrepareWrite(ctx, child.TaskID, base.Revision, "shared.txt", strings.NewReader(fmt.Sprintf("branch-%d", child.Ordinal)))
		if e == nil {
			e = m.store.write(ctx, "child-workspace-fixture", func(tx *sql.Tx) error { return commitWorkspaceVersion(ctx, tx, version) })
		}
		if e != nil {
			t.Fatal(e)
		}
	}
	prepared := []workspace.Version{}
	err = m.store.write(ctx, "join-fixture", func(tx *sql.Tx) error {
		return m.joinWorkflowWorkspaces(ctx, tx, parent, rootNode.ID, children, &prepared)
	})
	current, readErr := readWorkspaceVersion(ctx, m.store.db, w.TaskID)
	if err != nil || readErr != nil || current.Revision <= parent.Revision {
		t.Fatalf("join 未发布父版本：%+v %v %v", current, err, readErr)
	}
	content, _, err := backend.Read(ctx, w.TaskID, current.Revision, "shared.txt")
	if err != nil || string(content) != "parent" {
		t.Fatalf("父文件被覆盖：%s %v", content, err)
	}
	for ordinal := range children {
		path := fmt.Sprintf(".workflow/%s/%d/shared.txt", rootNode.ID, ordinal)
		content, _, err = backend.Read(ctx, w.TaskID, current.Revision, path)
		if err != nil || string(content) != fmt.Sprintf("branch-%d", ordinal) {
			t.Fatalf("分支文件丢失：%s %s %v", path, content, err)
		}
	}
}

func TestWorkflowV2FailureGateAndNodeRetryDoNotReplaySibling(t *testing.T) {
	var left, right atomic.Int32
	m, source := workflowTestManager(t, &operationCatalog{execute: func(_ context.Context, op Operation) (CapabilityResult, error) {
		if strings.Contains(op.ArgumentsJSON, `"left"`) {
			if left.Add(1) == 1 {
				return CapabilityResult{BusinessError: &Failure{Code: "fixture-failed", Message: "左分支失败"}}, nil
			}
		} else {
			right.Add(1)
		}
		return CapabilityResult{Value: json.RawMessage(op.ArgumentsJSON)}, nil
	}})
	w := createWorkflowV2Test(t, m, source, workflowV2CompositeDefinition("parallel"), `{"left":{"branch":"left"},"right":{"branch":"right"}}`)
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	workflowIdle(t, m)
	w, err := m.GetWorkflow(context.Background(), w.ID)
	if err != nil || left.Load() != 1 || right.Load() != 0 || !w.GateClosed {
		t.Fatalf("失败没有关闭后续派发：left=%d right=%d w=%+v err=%v", left.Load(), right.Load(), w, err)
	}
	nodeID := w.CurrentStepID
	input := WorkflowRecoveryInput{NodeID: nodeID, RequestID: "v2-retry-left", ExpectedRevision: w.Revision, Action: "retry", Evidence: "核实失败操作已停止，没有外部效果"}
	_, duplicate, err := m.RecoverWorkflow(context.Background(), w.ID, input)
	if err != nil || duplicate {
		t.Fatalf("节点重试失败：%v duplicate=%v", err, duplicate)
	}
	if _, duplicate, err = m.RecoverWorkflow(context.Background(), w.ID, input); err != nil || !duplicate {
		t.Fatalf("节点恢复未幂等：%v duplicate=%v", err, duplicate)
	}
	w = workflowWait(t, m, w.ID, StateSucceeded)
	if left.Load() != 2 || right.Load() != 1 || w.GateClosed {
		t.Fatalf("错误重放分支：left=%d right=%d w=%+v", left.Load(), right.Load(), w)
	}
	for _, node := range w.ExecutionTree.Nodes {
		if node.ID == nodeID && (node.Attempt != 2 || node.Status != StateSucceeded) {
			t.Fatalf("没有保留同一节点上的新尝试：%+v", node)
		}
	}
}

func TestWorkflowV2CancelRevokesEveryBranchApproval(t *testing.T) {
	var calls atomic.Int32
	m, source := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		calls.Add(1)
		return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
	}})
	d := workflowV2CompositeDefinition("parallel")
	for i := range d.Steps[0].Parallel.Branches {
		d.Steps[0].Parallel.Branches[i].Body.Steps[0].Capability = "test_write"
	}
	w := createWorkflowV2Test(t, m, source, d, `{"left":{},"right":{}}`)
	runtimeEventually(t, func() bool {
		approvals, err := m.Approvals(context.Background())
		return err == nil && len(approvals) == 2 && approvals[0].Status == "pending" && approvals[1].Status == "pending"
	})
	w, err := m.CancelWorkflow(context.Background(), w.ID)
	if err != nil || w.Status != StateCancelled || calls.Load() != 0 {
		t.Fatalf("取消未结束全部分支：%+v calls=%d err=%v", w, calls.Load(), err)
	}
	approvals, err := m.Approvals(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, approval := range approvals {
		if approval.Status != "revoked" {
			t.Fatalf("分支审批未撤销：%+v", approval)
		}
	}
	m = reopenOperationManager(t, m)
	w, err = m.GetWorkflow(context.Background(), w.ID)
	if err != nil || w.Status != StateCancelled || calls.Load() != 0 {
		t.Fatalf("取消在重启后复活：%+v %v", w, err)
	}
	for _, scope := range w.ExecutionTree.Scopes {
		if scope.Status != StateCancelled {
			t.Fatalf("取消遗漏作用域终态：%+v", scope)
		}
	}
}

func TestWorkflowV2AcceptResultKeepsOriginalRunTerminal(t *testing.T) {
	var calls atomic.Int32
	m, source := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		calls.Add(1)
		return CapabilityResult{Unknown: true}, nil
	}})
	body := workflowV2LeafBody()
	body.Steps[0].Capability = "test_write"
	d := WorkflowDefinition{LanguageVersion: WorkflowV2LanguageVersion, Name: "核实补录", Enabled: true, Goal: "保留未知事实与新完成回执", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: body.OutputSchemaJSON, Entry: body.Entry, Steps: body.Steps}
	w := createWorkflowV2Test(t, m, source, d, `{}`)
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	approval := waitingApproval(t, m, w.ActiveRunID)
	if _, err := m.Decide(context.Background(), approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	workflowIdle(t, m)
	runID := w.ActiveRunID
	original, err := m.Get(context.Background(), runID)
	if err != nil {
		t.Fatal(err)
	}
	barriers, err := m.Barriers(context.Background())
	if err != nil || len(barriers) != 1 {
		t.Fatalf("未知写操作没有屏障：%+v %v", barriers, err)
	}
	if _, err = m.Reconcile(context.Background(), barriers[0].ID, "已核对系统结果与业务记录", "confirmed-completed"); err != nil {
		t.Fatal(err)
	}
	w, err = m.GetWorkflow(context.Background(), w.ID)
	if err != nil || !slices.Contains(w.AllowedActions, "accept-result") {
		t.Fatalf("核实后未开放补录：%+v %v", w, err)
	}
	result, _, err := m.RecoverWorkflow(context.Background(), w.ID, WorkflowRecoveryInput{NodeID: w.CurrentStepID, RequestID: "v2-result-recorded", ExpectedRevision: w.Revision, Action: "accept-result", Evidence: "外部记录确认已完成", OutputJSON: `{"confirmed":true}`})
	if err != nil || result.Status != StateSucceeded || result.OutputJSON != `{"confirmed":true}` || calls.Load() != 1 {
		t.Fatalf("补录未完成或重做了操作：%+v calls=%d err=%v", result, calls.Load(), err)
	}
	after, err := m.Get(context.Background(), runID)
	if err != nil || after.Status != original.Status || after.EndReason != original.EndReason {
		t.Fatalf("补录覆盖旧 Run 终态：before=%+v after=%+v err=%v", original, after, err)
	}
}

func TestWorkflowV2NestedScopesHaveLocalInputsAndOutputNamespaces(t *testing.T) {
	m, source := workflowTestManager(t, &operationCatalog{execute: func(_ context.Context, op Operation) (CapabilityResult, error) {
		return CapabilityResult{Value: json.RawMessage(op.ArgumentsJSON)}, nil
	}})
	d := workflowV2CompositeDefinition("parallel")
	nested := workflowV2CompositeDefinition("foreach")
	d.Steps[0].Parallel.Branches[0].Body = workflowBody(nested)
	input := `{"left":[{"n":9007199254740993},{"n":2}],"right":{"n":3}}`
	w := createWorkflowV2Test(t, m, source, d, input)
	w = workflowWait(t, m, w.ID, StateSucceeded)
	if w.OutputJSON != input || len(w.ExecutionTree.Scopes) != 5 || len(w.ExecutionTree.Nodes) != 5 {
		t.Fatalf("嵌套输入或输出命名空间错误：%+v", w)
	}
}

func TestWorkflowV2MaintenanceFreezesAndRenewsAllNodes(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	m, source := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		calls.Add(1)
		return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
	}})
	d := workflowV2CompositeDefinition("parallel")
	for i := range d.Steps[0].Parallel.Branches {
		d.Steps[0].Parallel.Branches[i].Body.Steps[0].Capability = "test_write"
	}
	w := createWorkflowV2Test(t, m, source, d, `{"left":{},"right":{}}`)
	runtimeEventually(t, func() bool {
		approvals, err := m.Approvals(ctx)
		return err == nil && len(approvals) == 2 && approvals[0].Status == "pending" && approvals[1].Status == "pending"
	})
	workflowIdle(t, m)
	fence := filepath.Join(t.TempDir(), "agent-workflow-recovery.json")
	m.mu.Lock()
	m.deps.WorkflowRecoveryFence = fence
	m.mu.Unlock()
	if err := os.WriteFile(fence, []byte(`{"version":1,"reason":"panel-rollback","createdAt":"2026-10-10T00:00:00Z"}`), 0600); err != nil {
		t.Fatal(err)
	}
	m = reopenOperationManager(t, m)
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	if !w.GateClosed || calls.Load() != 0 {
		t.Fatalf("维护恢复没有关闭派发：%+v calls=%d", w, calls.Load())
	}
	if _, err := os.Stat(fence); !os.IsNotExist(err) {
		t.Fatalf("维护冻结事务成功后未消费标记：%v", err)
	}
	for _, node := range w.ExecutionTree.Nodes {
		if node.Status != StateRecoveryRequired {
			t.Fatalf("维护恢复遗漏节点：%+v", node)
		}
		fresh, err := m.GetWorkflow(ctx, w.ID)
		if err != nil {
			t.Fatal(err)
		}
		action := "renew-approval"
		if node.Kind == "parallel" {
			action = "continue"
		}
		_, _, err = m.RecoverWorkflow(ctx, w.ID, WorkflowRecoveryInput{NodeID: node.ID, RequestID: "maint:" + node.ID, ExpectedRevision: fresh.Revision, Action: action, Evidence: "核对节点尚未派发，重新建立执行边界"})
		if err != nil {
			t.Fatalf("维护恢复节点失败：%+v %v", node, err)
		}
	}
	approvals, err := m.Approvals(ctx)
	if err != nil || len(approvals) != 4 {
		t.Fatalf("没有保存旧撤销审批和新审批：%+v %v", approvals, err)
	}
	pending, revoked := 0, 0
	for _, approval := range approvals {
		if approval.Status == "pending" {
			pending++
			if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
				t.Fatal(err)
			}
		} else if approval.Status == "revoked" {
			revoked++
		}
	}
	w = workflowWait(t, m, w.ID, StateSucceeded)
	if pending != 2 || revoked != 2 || calls.Load() != 2 {
		t.Fatalf("审批或执行数错误：pending=%d revoked=%d calls=%d w=%+v", pending, revoked, calls.Load(), w)
	}
}

func TestWorkflowV2BudgetEndsEveryWaitingBranch(t *testing.T) {
	ctx := context.Background()
	m, source := workflowTestManager(t, &operationCatalog{})
	d := workflowV2CompositeDefinition("parallel")
	for i := range d.Steps[0].Parallel.Branches {
		d.Steps[0].Parallel.Branches[i].Body.Steps[0].Capability = "test_write"
	}
	w := createWorkflowV2Test(t, m, source, d, `{"left":{},"right":{}}`)
	runtimeEventually(t, func() bool {
		approvals, err := m.Approvals(ctx)
		return err == nil && len(approvals) == 2 && approvals[0].Status == "pending" && approvals[1].Status == "pending"
	})
	workflowIdle(t, m)
	m.mu.Lock()
	err := m.store.write(ctx, "exhaust-workflow-time", func(tx *sql.Tx) error {
		fresh, err := readWorkflow(ctx, tx, w.ID)
		if err != nil {
			return err
		}
		fresh.Usage.ActiveMilliseconds = fresh.Limits.ActiveMilliseconds
		return m.store.failWorkflowActiveBudget(ctx, tx, &fresh, nil)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	w = workflowWait(t, m, w.ID, StateFailed)
	for _, node := range w.ExecutionTree.Nodes {
		if node.Status != StateFailed {
			t.Fatalf("预算耗尽遗漏节点：%+v", node)
		}
	}
	approvals, err := m.Approvals(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, approval := range approvals {
		if approval.Status != "revoked" {
			t.Fatalf("预算耗尽保留有效审批：%+v", approval)
		}
		run, err := m.Get(ctx, approval.RunID)
		if err != nil || run.Status != StateFailed || run.EndReason != "workflow-budget" {
			t.Fatalf("预算耗尽保留非终态 Run：%+v %v", run, err)
		}
	}
	session, err := m.GetSession(ctx, w.SessionID)
	if err != nil || session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		t.Fatalf("预算失败未释放会话：%+v %v", session, err)
	}
}

func TestWorkflowV2RetentionDeletesScopesBeforeTheirTasks(t *testing.T) {
	ctx := context.Background()
	m, source := workflowTestManager(t, &operationCatalog{})
	w := createWorkflowV2Test(t, m, source, workflowV2CompositeDefinition("parallel"), `{"left":{},"right":{}}`)
	w = workflowWait(t, m, w.ID, StateSucceeded)
	workflowIdle(t, m)
	m.mu.Lock()
	err := m.store.write(ctx, "v2-retention-fixture", func(tx *sql.Tx) error {
		return m.store.sweepSessions(ctx, tx, stamp(time.Now().Add(time.Hour)))
	})
	var scopes, tasks int
	if err == nil {
		err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_scopes WHERE workflow_id=?", w.ID).Scan(&scopes)
	}
	if err == nil {
		err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM tasks WHERE session_id=?", w.SessionID).Scan(&tasks)
	}
	m.mu.Unlock()
	if err != nil || scopes != 0 || tasks != 0 {
		t.Fatalf("作用域外键阻止整会话清理：scopes=%d tasks=%d err=%v", scopes, tasks, err)
	}
}

func TestWorkflowV2RejectsNestedDeniedCapabilityAndDisabledChild(t *testing.T) {
	ctx := context.Background()
	m, source := workflowTestManager(t, &operationCatalog{})
	d := workflowV2CompositeDefinition("parallel")
	d.Steps[0].Parallel.Branches[0].Body.Steps[0].Capability = "not-in-environment"
	definition, err := m.PutWorkflowDefinition(ctx, "", 0, d)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = m.CreateWorkflow(ctx, CreateWorkflowInput{RequestID: "v2-denied-nested", DefinitionID: definition.ID, DefinitionRevision: definition.Revision, SourceSessionID: source.ID, InputJSON: `{"left":{},"right":{}}`})
	runtimeErrorCode(t, err, "tool-denied")
	body := workflowV2LeafBody()
	child, err := m.PutWorkflowDefinition(ctx, "", 0, WorkflowDefinition{LanguageVersion: WorkflowV2LanguageVersion, Name: "将要停用的子模板", Enabled: true, Goal: "测试闭包停用", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: body.OutputSchemaJSON, Entry: body.Entry, Steps: body.Steps})
	if err != nil {
		t.Fatal(err)
	}
	d = workflowV2CompositeDefinition("subworkflow")
	d.Steps[0].Subworkflow = &WorkflowSubworkflow{DefinitionID: child.ID, DefinitionRevision: child.Revision}
	definition, err = m.PutWorkflowDefinition(ctx, "", 0, d)
	if err != nil {
		t.Fatal(err)
	}
	child.Enabled = false
	if _, err = m.PutWorkflowDefinition(ctx, child.ID, child.Revision, child); err != nil {
		t.Fatal(err)
	}
	_, _, err = m.CreateWorkflow(ctx, CreateWorkflowInput{RequestID: "v2-disabled-child", DefinitionID: definition.ID, DefinitionRevision: definition.Revision, SourceSessionID: source.ID, InputJSON: `{}`})
	runtimeErrorCode(t, err, "workflow-disabled")
	legacy := testWorkflowDefinition()
	legacy.Steps[0].Parallel = &WorkflowParallel{}
	if err := validateWorkflowDefinition(legacy); err == nil {
		t.Fatal("v1 模板静默接受了复合步骤字段")
	}
}
