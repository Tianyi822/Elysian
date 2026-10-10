package harness

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/skills"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/harness/workspace"
)

// 复用 extensions_docker_test.go 的 supervisor 入口。只有显式选择已有
// Python 镜像摘要才执行；模型、MCP、凭据、数据库和包均为本测试专用。
func TestWorkflowRealDockerAnalysisGateOperationsAndVerification(t *testing.T) {
	image := os.Getenv("ELYSIAN_EXECUTION_TEST_IMAGE")
	if image == "" {
		t.Skip("设置已有本地 Python 镜像完整摘要并使用 CGO_ENABLED=0 后运行工作流组合验收")
	}
	ctx := context.Background()
	f := newExtensionFixture(t)
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(filepath.Join(source, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{
		"SKILL.md": "---\nname: workflow-docker-skill\ndescription: 工作流真实容器组合验收\n---\nmarker-workflow-skill：按 MCP 证据生成报告，后续验证必须读取同一任务已提交的文件。\n",
		"scripts/report.py": `import os, pathlib, sys
assert os.getuid() == 65532
assert not pathlib.Path('/var/run/docker.sock').exists()
report = pathlib.Path('report.txt')
if sys.argv[1] == 'create':
    assert not report.exists(), '流程重复执行了创建阶段'
    assert sys.argv[2] == 'marker-resource:mcp-evidence'
    report.write_text(sys.argv[2] + '\n', encoding='utf-8')
    print('marker-workflow-created')
elif sys.argv[1] == 'verify':
    assert report.read_text(encoding='utf-8') == 'marker-resource:mcp-evidence\n'
    assert not pathlib.Path('verified.txt').exists(), '流程重复执行了验证阶段'
    pathlib.Path('verified.txt').write_text('verified from previous stage\n', encoding='utf-8')
    report.write_text(report.read_text(encoding='utf-8') + 'verified\n', encoding='utf-8')
    print('marker-workflow-verified')
else:
    raise AssertionError('未知验收阶段')
`,
	} {
		if err := os.WriteFile(filepath.Join(source, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	job, _, err := f.extensions.Skills.StartImport(ctx, skills.ImportInput{RequestID: "workflow-docker-import", Source: skills.Source{Kind: "directory", Path: source}, Enabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		job, err = f.extensions.Skills.GetImport(job.ID)
		return err == nil && job.State == skills.StateSucceeded
	})
	f.skill, err = f.extensions.Skills.Get(job.SkillID, job.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	f.extensions.Config, err = execconfig.Open(filepath.Join(root, "execution.json"), execconfig.Options{MountRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.extensions.Config.Close() })
	profile, err := f.extensions.Config.PutProfile(execconfig.ProfileInput{Name: "工作流验收 Python", Enabled: true, Image: image, Runtime: "python", TimeoutSeconds: 20})
	if err != nil {
		t.Fatal(err)
	}
	f.extensions.Workspaces, err = workspace.Open(filepath.Join(root, "workspaces"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.extensions.Workspaces.Close() })
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	f.extensions.Executor, err = execution.New(execution.Options{SocketPath: "/var/run/docker.sock", SupervisorPath: binary, MountRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := f.extensions.Executor.Close(closeCtx); err != nil {
			t.Error(err)
		}
	})
	toolAlias := capabilityAlias("mcp", f.server.ID, "inspect")
	resourceAlias := capabilityAlias("resource", f.server.ID, "fixture://guide")
	scriptAlias := capabilityAlias("script", f.skill.ID, "run")
	const analysisOutput = `{"evidence":"marker-resource:mcp-evidence","shouldExecute":true}`
	const finalOutput = `{"report":"report.txt","verified":true}`
	var inference, finishes, memories atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		raw, _ := json.Marshal(request.Messages)
		switch request.ToolChoice {
		case "store_working_memory":
			memories.Add(1)
			response := memoryReply(request)
			var proposal memoryProposal
			if err := json.Unmarshal(response.ToolCalls[0].Arguments, &proposal); err != nil {
				t.Error(err)
			}
			proposal.Summary = "marker-workflow-memory：阶段按 MCP 证据生成并验证报告"
			response.ToolCalls[0].Arguments, _ = json.Marshal(proposal)
			return response, nil
		case "workflow_finish":
			switch finishes.Add(1) {
			case 1:
				return workflowFinishReply(analysisOutput), nil
			case 2:
				if !strings.Contains(string(raw), "marker-workflow-verified") {
					t.Error("工作流最终结果没有真实容器验证证据")
				}
				return workflowFinishReply(finalOutput), nil
			default:
				t.Error("结构化结果请求被重复执行")
				return workflowFinishReply(finalOutput), nil
			}
		}
		if strings.Count(string(raw), "marker-workflow-skill") != 1 {
			t.Error("跨阶段上下文未恰好保留一份已加载的 SKILL.md")
		}
		switch inference.Add(1) {
		case 1:
			return toolReply(resourceAlias, toolAlias), nil
		case 2:
			if !strings.Contains(string(raw), "marker-resource") || !strings.Contains(string(raw), "mcp-evidence") {
				t.Error("分析阶段没有 MCP 资料与工具结果")
			}
			return finalReply("证据已核实，应按后续审批生成报告"), nil
		case 3:
			for _, marker := range []string{"marker-workflow-memory", "marker-workflow-created", "mcp-evidence", "9007199254740993"} {
				if !strings.Contains(string(raw), marker) {
					t.Errorf("验证阶段丢失前序记忆或精确结果：%s", marker)
				}
			}
			response := toolReply(scriptAlias)
			response.ToolCalls[0].Arguments, _ = json.Marshal(scriptArguments{Path: "scripts/report.py", ProfileID: profile.ID, Args: []string{"verify"}})
			return response, nil
		case 4:
			if !strings.Contains(string(raw), "marker-workflow-verified") {
				t.Error("验证阶段没有读取到真实容器结果")
			}
			return finalReply("同一工作区中的报告已由后续容器读取并验证"), nil
		default:
			t.Error("执行了未选分支或意外重放模型请求")
			return finalReply("异常额外请求"), nil
		}
	}, func(deps *Deps) {
		deps.Catalog, deps.Workspaces = f.extensions, f.extensions.Workspaces
		deps.Spawn = func(ctx context.Context) (worker.Process, error) {
			return worker.Spawn(ctx, worker.Options{Path: binary, Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
		}
	})
	env := f.environment()
	env.Resources = []ResourceRef{{ServerID: f.server.ID, URI: "fixture://guide"}}
	env.TrustedReadOnly = append(env.TrustedReadOnly, resourceAlias)
	env.ExecutionProfiles = []RevisionRef{{ID: profile.ID, Revision: profile.Revision}}
	env, err = m.PutEnvironment(ctx, session.ID, 0, env)
	if err != nil {
		t.Fatal(err)
	}
	analysisSchema := `{"type":"object","additionalProperties":false,"required":["shouldExecute","evidence"],"properties":{"shouldExecute":{"type":"boolean"},"evidence":{"type":"string"}}}`
	finalSchema := `{"type":"object","additionalProperties":false,"required":["verified","report"],"properties":{"verified":{"type":"boolean"},"report":{"type":"string"}}}`
	fromStep := func(id, pointer string) WorkflowBinding {
		return WorkflowBinding{Step: &WorkflowOutputBinding{StepID: id, Pointer: pointer}}
	}
	execute := fromStep("analyze", "/shouldExecute")
	yes := workflowLiteral("true")
	finish := fromStep("verify", "")
	skipped := workflowLiteral(`{"report":"","verified":false}`)
	profileIDJSON, _ := json.Marshal(profile.ID)
	definition, err := m.PutWorkflowDefinition(ctx, "", 0, WorkflowDefinition{
		Name: "真实容器顺序验收", Enabled: true, Goal: "先分析并确认，再创建报告和独立验证同一任务文件", InputSchemaJSON: `{"type":"object"}`, OutputSchemaJSON: finalSchema, Entry: "analyze",
		Steps: []WorkflowStepDefinition{
			{ID: "analyze", Kind: "agent", Instruction: "读取技能和 MCP 证据，判断是否执行后续步骤", Input: workflowLiteral("{}"), OutputSchemaJSON: analysisSchema, Next: "choose", Selection: &AgentInput{Skills: []RevisionRef{{ID: f.skill.ID, Revision: f.skill.Revision}}}},
			{ID: "choose", Kind: "condition", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Condition: &WorkflowCondition{Op: "eq", Left: &execute, Right: &yes}, Then: "confirm", Else: "skip"},
			{ID: "confirm", Kind: "approval", Instruction: "确认按已核实的证据创建报告", Input: fromStep("analyze", ""), OutputSchemaJSON: `{"type":"object"}`, Next: "create"},
			{ID: "create", Kind: "operation", Capability: scriptAlias, Input: WorkflowBinding{Object: map[string]WorkflowBinding{
				"path": workflowLiteral(`"scripts/report.py"`), "profileId": workflowLiteral(string(profileIDJSON)), "grantId": workflowLiteral(`""`),
				"argv": {Array: []WorkflowBinding{workflowLiteral(`"create"`), fromStep("analyze", "/evidence")}},
			}}, OutputSchemaJSON: `{"type":"object","required":["exitCode","stdout"],"properties":{"exitCode":{"const":0},"stdout":{"type":"string"}}}`, Next: "audit"},
			{ID: "audit", Kind: "operation", Capability: toolAlias, Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object","required":["structuredContent"],"properties":{"structuredContent":{"type":"object","required":["ok","large"],"properties":{"ok":{"const":true},"large":{"const":9007199254740993}}}}}`, Next: "verify"},
			{ID: "verify", Kind: "agent", Instruction: "使用技能 verify 参数读取前阶段文件并验证，确认产物后报告结果", Input: WorkflowBinding{Object: map[string]WorkflowBinding{"analysis": fromStep("analyze", ""), "creation": fromStep("create", ""), "audit": fromStep("audit", "")}}, OutputSchemaJSON: finalSchema, Finish: &finish},
			{ID: "skip", Kind: "approval", Instruction: "未选分支，不应到达", Input: workflowLiteral("{}"), OutputSchemaJSON: `{"type":"object"}`, Finish: &skipped},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	input := CreateWorkflowInput{RequestID: "workflow-docker-composed", DefinitionID: definition.ID, DefinitionRevision: definition.Revision, SourceSessionID: session.ID, InputJSON: "{}"}
	w, duplicate, err := m.CreateWorkflow(ctx, input)
	if err != nil || duplicate {
		t.Fatalf("工作流未被首次接受：duplicate=%v err=%v", duplicate, err)
	}
	w = waitWorkflowDockerStep(t, m, w.ID, "confirm", StateWaitingApproval)
	gate := waitingApproval(t, m, w.ActiveRunID)
	if gate.Kind != "workflow-gate" || gate.OperationID != "" || gate.WorkflowID != w.ID || gate.WorkflowStepID != "confirm" || w.SessionID == session.ID {
		t.Fatalf("工作流人工确认身份或会话隔离错误：%+v %+v", w, gate)
	}
	before, err := m.Workspace(ctx, w.TaskID, "")
	if err != nil || before.Version.Revision != 0 || len(before.Files) != 0 || f.calls.Load() != 1 {
		t.Fatalf("确认前出现脚本副作用或 MCP 重放：%+v calls=%d err=%v", before, f.calls.Load(), err)
	}
	_, err = m.WriteWorkspace(ctx, w.TaskID, 0, "forbidden.txt", strings.NewReader("busy"))
	runtimeErrorCode(t, err, "session-busy")
	// 已接受实例继续使用自己的环境和模板修订，不受来源会话后续修改影响。
	if _, err = m.PutEnvironment(ctx, session.ID, env.Revision, Environment{}); err != nil {
		t.Fatal(err)
	}
	definition.Enabled = false
	if _, err = m.PutWorkflowDefinition(ctx, definition.ID, definition.Revision, definition); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Decide(ctx, gate.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	w = waitWorkflowDockerStep(t, m, w.ID, "create", StateWaitingApproval)
	createApproval := waitingApproval(t, m, w.ActiveRunID)
	if createApproval.ID == gate.ID || createApproval.Kind != "operation" || createApproval.Operation.Source != "workflow" || createApproval.Operation.Capability.Source != "script" || createApproval.Operation.WorkspaceRevision != 0 || createApproval.Operation.Execution == nil || createApproval.Operation.Execution.Profile.Image != image || createApproval.Operation.Execution.ScriptDigest == "" {
		t.Fatalf("流程确认绕过写操作审批或审批未固定脚本：%+v", createApproval)
	}
	if _, err = m.Decide(ctx, createApproval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	w = waitWorkflowDockerStep(t, m, w.ID, "verify", StateWaitingApproval)
	verifyApproval := waitingApproval(t, m, w.ActiveRunID)
	first, err := m.Workspace(ctx, w.TaskID, "report.txt")
	if err != nil || string(first.Content) != "marker-resource:mcp-evidence\n" || first.Version.Revision < 1 || first.Version.BaseRevision != 0 || first.Version.TaskID != w.TaskID {
		t.Fatalf("静态脚本没有提交当前 Task 的文件：%+v %v", first, err)
	}
	if verifyApproval.ID == createApproval.ID || verifyApproval.Operation.Source != "model" || verifyApproval.Operation.TaskID != w.TaskID || verifyApproval.Operation.WorkspaceRevision != first.Version.Revision || f.calls.Load() != 2 {
		t.Fatalf("验证阶段未固定前序工作区或没有独立审批：%+v MCP=%d", verifyApproval, f.calls.Load())
	}
	if _, err = m.Decide(ctx, verifyApproval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	w = waitWorkflowDockerStep(t, m, w.ID, "", StateSucceeded)
	second, err := m.Workspace(ctx, w.TaskID, "report.txt")
	if err != nil || string(second.Content) != "marker-resource:mcp-evidence\nverified\n" || second.Version.BaseRevision != first.Version.Revision || second.Version.Revision <= first.Version.Revision {
		t.Fatalf("后续容器未读取并提交同一工作区：%+v %v", second, err)
	}
	verified, err := m.Workspace(ctx, w.TaskID, "verified.txt")
	if err != nil || string(verified.Content) != "verified from previous stage\n" || verified.Version != second.Version {
		t.Fatalf("验证阶段产物缺失：%+v %v", verified, err)
	}
	old, _, err := f.extensions.Workspaces.Read(ctx, w.TaskID, first.Version.Revision, "report.txt")
	if err != nil || string(old) != string(first.Content) {
		t.Fatalf("后续容器改写了先前不可变文件版本：%q %v", old, err)
	}
	runs := workflowAgentRuns(t, m, w.ID)
	wantSteps := []string{"analyze", "choose", "confirm", "create", "audit", "verify"}
	if len(runs) != len(wantSteps) {
		t.Fatalf("分支、阶段次数或顺序错误：%+v", runs)
	}
	for i, run := range runs {
		if run.WorkflowStepID != wantSteps[i] || run.Status != StateSucceeded || run.WorkflowAttempt != 1 || run.TaskID != w.TaskID || run.SessionID != w.SessionID || run.Snapshot == nil || run.Snapshot.Digest != w.Snapshot.Digest {
			t.Fatalf("阶段未保留实例固定上下文：%+v", run)
		}
	}
	if runs[0].MemoryStatus != "updated" || runs[5].InitialMemoryRevision < 1 || runs[5].MemoryStatus != "updated" {
		t.Fatalf("Agent 阶段未共享同 Task 记忆：%+v %+v", runs[0], runs[5])
	}
	for _, index := range []int{3, 5} {
		operations, err := m.Operations(ctx, runs[index].ID)
		if err != nil || len(operations) != 1 || operations[0].Capability.Source != "script" || operations[0].Status != "completed" || operations[0].ApprovalID == "" || operations[0].DispatchID == "" || operations[0].Error != nil {
			t.Fatalf("真实脚本执行事实不完整：%+v %v", operations, err)
		}
	}
	if w.OutputJSON != finalOutput || w.DefinitionRevision != input.DefinitionRevision || f.calls.Load() != 2 || inference.Load() != 4 || finishes.Load() != 2 || memories.Load() != 2 || w.Usage.Calls != 6 || w.Usage.ModelRequests != 8 {
		t.Fatalf("最终结果、调用次数或共享预算错误：%+v MCP=%d model=%d finish=%d memory=%d", w, f.calls.Load(), inference.Load(), finishes.Load(), memories.Load())
	}
	readBack, duplicate, err := m.CreateWorkflow(ctx, input)
	if err != nil || !duplicate || readBack.ID != w.ID || readBack.Status != StateSucceeded {
		t.Fatalf("模板停用后也必须幂等回读已完成实例：%+v duplicate=%v err=%v", readBack, duplicate, err)
	}
	storedSession, err := m.GetSession(ctx, w.SessionID)
	if err != nil || storedSession.ActiveWorkflowID != "" || storedSession.ActiveRunID != "" {
		t.Fatalf("工作流完成后专用会话仍忙碌：%+v %v", storedSession, err)
	}
}

func waitWorkflowDockerStep(t *testing.T, m *Manager, id, step, status string) WorkflowInstance {
	t.Helper()
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		w, err := m.GetWorkflow(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		if w.Status == status && (step == "" || w.CurrentStepID == step) {
			return w
		}
		if w.Status == StateRecoveryRequired || terminal(w.Status) || w.CurrentStepID == "skip" {
			t.Fatalf("工作流未到达预期阶段 %s/%s：%+v", step, status, w)
		}
		select {
		case <-deadline.C:
			t.Fatalf("等待真实容器工作流阶段 %s/%s 超时：%+v", step, status, w)
		case <-ticker.C:
		}
	}
}
