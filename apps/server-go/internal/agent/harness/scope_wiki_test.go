package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/workspace"
)

func workflowV2WikiDefinition() WorkflowDefinition {
	d := workflowV2CompositeDefinition("parallel")
	d.Entry = "prepare"
	d.Steps[0].Finish, d.Steps[0].Next = nil, "verify"
	d.Steps = append([]WorkflowStepDefinition{{ID: "prepare", Kind: "approval", Instruction: "确认输入", Input: workflowLiteral(`{}`), OutputSchemaJSON: `{"type":"object"}`, Next: "compose"}}, d.Steps...)
	finish := workflowTestOutput("verify", "")
	d.Steps = append(d.Steps, WorkflowStepDefinition{ID: "verify", Kind: "approval", Instruction: "核对分支产物", Input: workflowTestOutput("compose", ""), OutputSchemaJSON: `{"type":"object"}`, Finish: &finish})
	return d
}

func TestWorkflowV2WikiSourcesSurviveForkJoinAndFenceRecovery(t *testing.T) {
	ctx := context.Background()
	files, err := workspace.Open(filepath.Join(t.TempDir(), "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = files.Close() })
	m, source, _ := agentManager(t, operationClient(), func(d *Deps) {
		d.Workspaces = files
		d.Catalog = &operationCatalog{execute: func(ctx context.Context, op Operation) (CapabilityResult, error) {
			v, err := files.PrepareWrite(ctx, op.TaskID, op.WorkspaceRevision, "receipt.txt", strings.NewReader(op.ArgumentsJSON))
			return CapabilityResult{Value: json.RawMessage(op.ArgumentsJSON), Workspace: &v}, err
		}}
	})
	approveEnvironment(t, m, source)
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "origin", Title: "来源", Markdown: "固定输入的来源"})
	if err != nil {
		t.Fatal(err)
	}
	refs := []WikiRef{{page.ID, page.Revision, page.Digest}}
	d := workflowV2WikiDefinition()
	for i := range d.Steps[1].Parallel.Branches {
		d.Steps[1].Parallel.Branches[i].Body.Steps[0].Capability = "test_write"
	}
	w := createWorkflowV2Test(t, m, source, d, `{"left":{"n":1},"right":{"n":2}}`)
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	first := waitingApproval(t, m, w.ActiveRunID)
	base, err := files.PrepareWrite(ctx, w.TaskID, 0, "source.txt", strings.NewReader("来自知识页面"))
	if err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	err = m.store.write(ctx, "wiki-workflow-parent-fixture", func(tx *sql.Tx) error {
		if err := commitWorkspaceVersion(ctx, tx, base); err != nil {
			return err
		}
		if err := saveWorkingMemory(ctx, tx, WorkingMemory{TaskID: w.TaskID, Revision: 1}); err != nil {
			return err
		}
		for _, a := range []workflowWikiArtifact{{"workspace", w.TaskID + ":1"}, {"memory", w.TaskID + ":1"}} {
			if err := saveWorkflowWikiArtifact(ctx, tx, a.kind, a.id, w.TaskID, refs); err != nil {
				return err
			}
		}
		return nil
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Decide(ctx, first.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	var pending []Approval
	runtimeEventually(t, func() bool {
		all, e := m.Approvals(ctx)
		pending = nil
		for _, a := range all {
			if a.Status == "pending" {
				pending = append(pending, a)
			}
		}
		return e == nil && len(pending) == 2
	})
	for _, a := range pending {
		if _, err = m.Decide(ctx, a.ID, "approved"); err != nil {
			t.Fatal(err)
		}
	}
	runtimeEventually(t, func() bool {
		w, err = m.GetWorkflow(ctx, w.ID)
		if err != nil || w.Status != StateWaitingApproval {
			return false
		}
		for _, n := range w.ExecutionTree.Nodes {
			if n.ID == w.CurrentStepID {
				return n.StepID == "verify"
			}
		}
		return false
	})
	verify := waitingApproval(t, m, w.ActiveRunID)
	m.mu.Lock()
	var joined workspace.Version
	err = m.store.write(ctx, "wiki-workflow-assert", func(tx *sql.Tx) error {
		artifacts := []workflowWikiArtifact{{"run", w.ActiveRunID}}
		for _, scope := range w.ExecutionTree.Scopes {
			if scope.ParentNodeID == "" {
				continue
			}
			artifacts = append(artifacts, workflowWikiArtifact{"workflow-scope", scope.ID}, workflowWikiArtifact{"memory", scope.TaskID + ":1"})
			v, e := readWorkspaceVersion(ctx, tx, scope.TaskID)
			if e != nil {
				return e
			}
			artifacts = append(artifacts, workflowWikiArtifact{"workspace", scope.TaskID + ":" + strconv.Itoa(v.Revision)})
		}
		for _, node := range w.ExecutionTree.Nodes {
			if node.StepID == "prepare" || node.StepID == "verify" {
				continue
			}
			artifacts = append(artifacts, workflowWikiArtifact{"workflow-node", node.ID})
		}
		joined, err = readWorkspaceVersion(ctx, tx, w.TaskID)
		if err != nil {
			return err
		}
		artifacts = append(artifacts, workflowWikiArtifact{"workspace", w.TaskID + ":" + strconv.Itoa(joined.Revision)})
		for _, a := range artifacts {
			got, e := wikiArtifactRefs(ctx, tx, a.kind, a.id)
			if e != nil {
				return e
			}
			if len(got) != 1 || got[0] != refs[0] {
				t.Errorf("来源未传递到 %s/%s: %+v", a.kind, a.id, got)
			}
		}
		return nil
	})
	m.mu.Unlock()
	if err != nil || joined.Revision <= base.Revision {
		t.Fatalf("分支汇合未发布带来源的文件: %+v %v", joined, err)
	}
	if _, err = m.WithdrawWikiPage(ctx, page.ID, page.Revision); err != nil {
		t.Fatal(err)
	}
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	if !w.GateClosed || w.Error == nil || w.Error.Code != "wiki-context-invalidated" {
		t.Fatalf("撤回未阻断后继: %+v", w)
	}
	if _, err = m.Decide(ctx, verify.ID, "approved"); err == nil {
		t.Fatal("撤回后仍可批准原后继")
	}
	// 挂起在审批门口的执行 goroutine 会晚一拍结算活动时间、删除执行记录（合法
	// 并发写，会推进工作流版本）；先等执行清空，再按乐观并发契约重读新版本重试，
	// 最终仍必须因来源已撤回被拒。失败的尝试在校验阶段被拒，不落恢复记录，同
	// RequestID 换新版本重试不会触发 request-conflict。
	workflowIdle(t, m)
	runtimeEventually(t, func() bool {
		_, _, err = m.RecoverWorkflow(ctx, w.ID, WorkflowRecoveryInput{RequestID: "withdrawn-retry", ExpectedRevision: w.Revision, NodeID: w.CurrentStepID, Action: "retry", Evidence: "不能通过重试绕过已撤回资料"})
		if e, ok := err.(*Error); ok && (e.Code == "revision-conflict" || e.Code == "workflow-active") {
			if fresh, e2 := m.GetWorkflow(ctx, w.ID); e2 == nil && fresh.Status == StateRecoveryRequired {
				w = fresh
				return false
			}
		}
		return true
	})
	runtimeErrorCode(t, err, "wiki-context-invalidated")
	for _, node := range w.ExecutionTree.Nodes {
		if node.ID == w.CurrentStepID && len(node.AllowedActions) != 0 {
			t.Fatal("已撤回来源仍公开恢复动作")
		}
	}
}

func TestWorkflowV2WikiWithdrawalFencesReadyCompositeWithoutRun(t *testing.T) {
	ctx := context.Background()
	m, source := workflowTestManager(t, &operationCatalog{})
	space, err := m.CreateWikiSpace(ctx, "业务", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "gap", Title: "阶段输入", Markdown: "被撤回的阶段来源"})
	if err != nil {
		t.Fatal(err)
	}
	w := createWorkflowV2Test(t, m, source, workflowV2WikiDefinition(), `{"left":{},"right":{}}`)
	w = workflowWait(t, m, w.ID, StateWaitingApproval)
	m.mu.Lock()
	err = m.store.write(ctx, "wiki-workflow-gap-fixture", func(tx *sql.Tx) error {
		if err := saveWorkingMemory(ctx, tx, WorkingMemory{TaskID: w.TaskID, Revision: 1}); err != nil {
			return err
		}
		if err := saveWorkflowWikiArtifact(ctx, tx, "memory", w.TaskID+":1", w.TaskID, []WikiRef{{page.ID, page.Revision, page.Digest}}); err != nil {
			return err
		}
		r, err := readRun(ctx, tx, w.ActiveRunID)
		if err != nil {
			return err
		}
		r.Status, r.WorkflowOutputJSON, r.EndedAt = StateSucceeded, `{"approved":true}`, stamp(m.deps.Now())
		if err = saveRun(ctx, tx, &r); err != nil {
			return err
		}
		if err = m.store.finishWorkflowV2Run(ctx, tx, &r); err != nil {
			return err
		}
		return m.withdrawWikiSourcesTx(ctx, tx, page.ID)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	if !w.GateClosed {
		t.Fatal("阶段间没有 Run 时撤回未关闭推进")
	}
	for _, node := range w.ExecutionTree.Nodes {
		if node.StepID == "compose" && (node.Status != StateRecoveryRequired || node.RunID != "" || node.Expanded) {
			t.Fatalf("撤回后仍展开复合节点: %+v", node)
		}
	}
}
