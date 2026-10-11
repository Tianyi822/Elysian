package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

// securityBranchBody 每个分支包含两个 agent 步骤：second 是同任务第 2 条 Run，
// 其上下文窗口（HistorySeq 已包含兄弟分支与根任务的公开消息、RunNumber 大于
// 兄弟分支已完成尝试）正是隔离过滤必须生效的位置。
func securityBranchBody(branch string) WorkflowBody {
	secondFinish := workflowTestOutput("second", "")
	return WorkflowBody{Entry: "first", OutputSchemaJSON: `{"type":"object"}`, Steps: []WorkflowStepDefinition{
		{ID: "first", Kind: "agent", Instruction: branch + "-branch-first：独立分析本分支输入", Input: workflowTestInput(""), OutputSchemaJSON: `{"type":"object"}`, Next: "second"},
		{ID: "second", Kind: "agent", Instruction: branch + "-branch-second：汇总本分支结论", Input: workflowTestOutput("first", ""), OutputSchemaJSON: `{"type":"object"}`, Finish: &secondFinish},
	}}
}

func TestWorkflowV2RunScopeIdentityIsolatesSiblingAndParentContext(t *testing.T) {
	m, source, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		header := ""
		if len(request.Messages) > 1 {
			header = request.Messages[1].Content
		}
		raw, _ := json.Marshal(request.Messages)
		joined := string(raw)
		switch request.ToolChoice {
		case "store_working_memory":
			return memoryReply(request), nil
		case "workflow_finish":
			switch {
			case strings.Contains(header, "root-plan："):
				return workflowFinishReply(`{"left":{"payload":"L"},"right":{"payload":"R"}}`), nil
			case strings.Contains(header, "left-branch-first："):
				return workflowFinishReply(`{"branch":"left-first-done"}`), nil
			case strings.Contains(header, "right-branch-first："):
				return workflowFinishReply(`{"branch":"right-first-done"}`), nil
			case strings.Contains(header, "left-branch-second："):
				return workflowFinishReply(`{"branch":"left-second-done"}`), nil
			case strings.Contains(header, "right-branch-second："):
				return workflowFinishReply(`{"branch":"right-second-done"}`), nil
			}
			return workflowFinishReply(`{"done":true}`), nil
		}
		branchFirst := strings.Contains(header, "left-branch-first：") || strings.Contains(header, "right-branch-first：")
		branchSecond := strings.Contains(header, "left-branch-second：") || strings.Contains(header, "right-branch-second：")
		rootFinal := strings.Contains(header, "root-final：")
		if branchFirst && strings.Contains(joined, "其他任务公开对话") {
			t.Error("分支首步骤读取了跨任务公开对话")
		}
		if branchSecond {
			self, other := "left", "right"
			if strings.Contains(header, "right-branch-second：") {
				self, other = "right", "left"
			}
			if strings.Contains(joined, "其他任务公开对话") {
				t.Errorf("%s 分支后续步骤读取了跨任务公开对话", self)
			}
			if strings.Contains(joined, "sibling-public-"+other) {
				t.Errorf("%s 分支后续步骤读取了兄弟分支公开答复", self)
			}
			if strings.Contains(joined, other+"-first-done") {
				t.Errorf("%s 分支后续步骤读取了兄弟分支步骤完成资料", self)
			}
			if !strings.Contains(joined, "流程步骤 first 完成资料") || !strings.Contains(joined, self+"-first-done") {
				t.Errorf("%s 分支后续步骤丢失本作用域前序完成资料", self)
			}
		}
		if rootFinal {
			if strings.Contains(joined, "其他任务公开对话") || strings.Contains(joined, "sibling-public-") {
				t.Error("join 后父作用域步骤读取了分支公开答复")
			}
			if strings.Contains(joined, "left-first-done") || strings.Contains(joined, "right-first-done") {
				t.Error("join 后父作用域步骤读取了分支内部步骤完成资料")
			}
			if !strings.Contains(joined, "流程步骤 plan 完成资料") {
				t.Error("join 后父作用域步骤丢失同作用域前序完成资料")
			}
			if !strings.Contains(header, "left-second-done") || !strings.Contains(header, "right-second-done") {
				t.Error("join 后父作用域步骤未经提升输出获取分支结果")
			}
		}
		switch {
		case strings.Contains(header, "left-branch"):
			return finalReply("sibling-public-left-answer：左分支独有公开答复"), nil
		case strings.Contains(header, "right-branch"):
			return finalReply("sibling-public-right-answer：右分支独有公开答复"), nil
		case strings.Contains(header, "root-plan："):
			return finalReply("root-plan-public-answer：根作用域固定输入"), nil
		}
		return finalReply("root-final-public-answer：只依据汇合输出"), nil
	}, func(d *Deps) { d.Catalog = &operationCatalog{} })
	approveEnvironment(t, m, source)
	finalFinish := workflowTestOutput("final", "")
	definition := WorkflowDefinition{LanguageVersion: WorkflowV2LanguageVersion, Name: "分支上下文隔离验收", Enabled: true, Goal: "并行分支与父作用域互不读取未提升输出", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: `{"type":"object"}`, Entry: "plan", Steps: []WorkflowStepDefinition{
		{ID: "plan", Kind: "agent", Instruction: "root-plan：固定两路分支输入", Input: workflowTestInput(""), OutputSchemaJSON: `{"type":"object"}`, Next: "parallel"},
		{ID: "parallel", Kind: "parallel", Input: workflowTestOutput("plan", ""), OutputSchemaJSON: `{"type":"object"}`, Parallel: &WorkflowParallel{Join: "all", Branches: []WorkflowBranch{{ID: "left", Input: workflowTestInput("/left"), Body: securityBranchBody("left")}, {ID: "right", Input: workflowTestInput("/right"), Body: securityBranchBody("right")}}}, Next: "final"},
		{ID: "final", Kind: "agent", Instruction: "root-final：只消费汇合后的分支输出", Input: workflowTestOutput("parallel", ""), OutputSchemaJSON: `{"type":"object"}`, Finish: &finalFinish},
	}}
	w := createWorkflowV2Test(t, m, source, definition, `{}`)
	w = workflowWait(t, m, w.ID, StateSucceeded)
	if w.OutputJSON != `{"done":true}` {
		t.Fatalf("流程输出不符合预期：%+v", w)
	}
	// 每条 v2 运行都必须携带自己的作用域与节点身份，隔离过滤才有生效前提。
	runs := workflowAgentRuns(t, m, w.ID)
	if len(runs) != 6 {
		t.Fatalf("预期 6 条叶节点运行（plan、两分支各两步、final）：%d", len(runs))
	}
	nodes := map[string]WorkflowNodeExecution{}
	for _, node := range w.ExecutionTree.Nodes {
		nodes[node.ID] = node
	}
	for _, run := range runs {
		if run.ScopeID == "" || run.NodeID == "" {
			t.Fatalf("v2 运行缺少作用域与节点身份：%+v", run)
		}
		node, ok := nodes[run.NodeID]
		if !ok || node.ScopeID != run.ScopeID || node.RunID != run.ID {
			t.Fatalf("v2 运行身份与执行树节点不一致：run=%+v", run)
		}
	}
}

func TestWorkflowV1AcceptResultChargesInstanceResultBudget(t *testing.T) {
	ctx := context.Background()
	m, session := workflowTestManager(t, &operationCatalog{})
	steps := workflowOneOperation("test_write")
	steps[0].Input = workflowTestInput("/missing")
	w := workflowStepsTest(t, m, session, steps)
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	if !slices.Contains(w.AllowedActions, "accept-result") {
		t.Fatalf("绑定失败未保留可补录尝试：%+v", w)
	}
	// 预算余量只剩 8 字节：单次上限（256 KiB）仍宽裕，累计上限应先拒绝补录。
	m.mu.Lock()
	err := m.store.write(ctx, "workflow-result-budget-fixture", func(tx *sql.Tx) error {
		fresh, e := readWorkflow(ctx, tx, w.ID)
		if e != nil {
			return e
		}
		fresh.Usage.ResultBytes = fresh.Limits.ResultBytes - 8
		return saveWorkflow(ctx, tx, &fresh)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if w, err = m.GetWorkflow(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	_, _, err = m.RecoverWorkflow(ctx, w.ID, WorkflowRecoveryInput{RequestID: "v1-budget-overflow", ExpectedRevision: w.Revision, Action: "accept-result", Evidence: "外部系统核对完成，证据编号 456", OutputJSON: `{"ok":true}`})
	runtimeErrorCode(t, err, "output-too-large")
	// 拒绝的事务整体回滚：预算与可恢复状态都不变。
	if w, err = m.GetWorkflow(ctx, w.ID); err != nil || w.Status != StateRecoveryRequired || w.Usage.ResultBytes != w.Limits.ResultBytes-8 {
		t.Fatalf("超额补录改变了实例状态或预算：%+v %v", w, err)
	}
	// 恢复预算余量后补录成功，补录字节计入实例累计预算。
	m.mu.Lock()
	err = m.store.write(ctx, "workflow-result-budget-reset", func(tx *sql.Tx) error {
		fresh, e := readWorkflow(ctx, tx, w.ID)
		if e != nil {
			return e
		}
		fresh.Usage.ResultBytes = 0
		return saveWorkflow(ctx, tx, &fresh)
	})
	m.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if w, err = m.GetWorkflow(ctx, w.ID); err != nil {
		t.Fatal(err)
	}
	const accepted = `{"ok":true}`
	w, _, err = m.RecoverWorkflow(ctx, w.ID, WorkflowRecoveryInput{RequestID: "v1-budget-record", ExpectedRevision: w.Revision, Action: "accept-result", Evidence: "外部系统核对完成，证据编号 456", OutputJSON: accepted})
	if err != nil || w.Status != StateSucceeded || w.OutputJSON != accepted {
		t.Fatalf("合法补录未完成：%+v %v", w, err)
	}
	final, err := m.GetWorkflow(ctx, w.ID)
	if err != nil || final.Usage.ResultBytes != len(accepted) {
		t.Fatalf("补录字节未计入实例累计预算：usage=%d err=%v", final.Usage.ResultBytes, err)
	}
}
