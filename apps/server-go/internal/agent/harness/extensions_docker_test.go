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

// 真实容器复用同一个受信测试二进制作为 supervisor，不依赖面板生产文件。
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "agent-exec-supervisor" {
		if execution.ServeSupervisor(context.Background(), os.Stdin, os.Stdout) != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// 仅显式指定已有本地 Python 镜像摘要时运行；CGO_ENABLED=0 使 supervisor
// 可在该镜像内启动。本测试不拉取镜像、不连接真实模型、不读取生产配置。
func TestExtensionsRealDockerSkillMCPApprovalAndWorkspaceContinuation(t *testing.T) {
	image := os.Getenv("ELYSIAN_EXECUTION_TEST_IMAGE")
	if image == "" {
		t.Skip("设置已有本地 Python 镜像完整摘要并使用 CGO_ENABLED=0 后运行组合验收")
	}
	ctx := context.Background()
	f := newExtensionFixture(t)
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(filepath.Join(source, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"SKILL.md": "---\nname: docker-integration-skill\ndescription: 真实容器组合验收\n---\nmarker-docker-skill：先读取 MCP 资料，再审批执行 scripts/report.py；后续轮次必须保留任务文件。\n",
		"scripts/report.py": `import os, pathlib, sys
assert os.getuid() == 65532
assert not pathlib.Path('/var/run/docker.sock').exists()
report = pathlib.Path('report.txt')
if sys.argv[1] == 'create':
    assert not report.exists(), '首轮脚本被重复执行'
    assert sys.argv[2] == 'marker-resource:mcp-evidence'
    report.write_text(sys.argv[2] + '\n', encoding='utf-8')
    print('marker-script-created')
elif sys.argv[1] == 'verify':
    assert report.read_text(encoding='utf-8') == 'marker-resource:mcp-evidence\n'
    report.write_text(report.read_text(encoding='utf-8') + 'second-run\n', encoding='utf-8')
    print('marker-script-retained')
else:
    raise AssertionError('未知验收阶段')
`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(source, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	job, _, err := f.extensions.Skills.StartImport(ctx, skills.ImportInput{RequestID: "docker-fixture-import", Source: skills.Source{Kind: "directory", Path: source}, Enabled: true}, nil)
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
	profile, err := f.extensions.Config.PutProfile(execconfig.ProfileInput{Name: "组合验收 Python", Enabled: true, Image: image, Runtime: "python", TimeoutSeconds: 20})
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
	scriptReply := func(args ...string) model.Response {
		response := toolReply(scriptAlias)
		response.ToolCalls[0].Arguments, _ = json.Marshal(scriptArguments{Path: "scripts/report.py", ProfileID: profile.ID, Args: args})
		return response
	}
	var inference atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		raw, _ := json.Marshal(request.Messages)
		if strings.Count(string(raw), "marker-docker-skill") != 1 {
			t.Error("当前轮上下文未恰好保留一份已加载的 SKILL.md 原文")
		}
		switch inference.Add(1) {
		case 1:
			return toolReply(resourceAlias, toolAlias), nil
		case 2:
			if !strings.Contains(string(raw), "marker-resource") || !strings.Contains(string(raw), "mcp-evidence") {
				t.Error("MCP 资料和工具结果未进入模型上下文")
			}
			return scriptReply("create", "marker-resource:mcp-evidence"), nil
		case 3:
			if !strings.Contains(string(raw), "marker-script-created") {
				t.Error("真实容器脚本结果未回到模型上下文")
			}
			return finalReply("报告已写入任务工作区"), nil
		case 4:
			return scriptReply("verify"), nil
		case 5:
			if !strings.Contains(string(raw), "marker-script-retained") {
				t.Error("续轮容器没有确认读取到前一轮文件")
			}
			return finalReply("续轮已验证并更新同一任务文件"), nil
		default:
			t.Error("模型请求被意外重放")
			return finalReply("异常的额外模型请求"), nil
		}
	}, func(deps *Deps) {
		deps.Catalog = f.extensions
		deps.Workspaces = f.extensions.Workspaces
		deps.Spawn = func(ctx context.Context) (worker.Process, error) {
			return worker.Spawn(ctx, worker.Options{Path: binary, Args: []string{"-test.run=^TestRuntimeWorkerHelper$"}, Env: []string{"HOME=/tmp", "ELYSIAN_RUNTIME_TEST_CHILD=1"}})
		}
	})
	env := f.environment()
	env.Resources = []ResourceRef{{ServerID: f.server.ID, URI: "fixture://guide"}}
	env.TrustedReadOnly = append(env.TrustedReadOnly, resourceAlias)
	env.ExecutionProfiles = []RevisionRef{{ID: profile.ID, Revision: profile.Revision}}
	if _, err = m.PutEnvironment(ctx, session.ID, 0, env); err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "docker-first", Content: "按技能读取 MCP 并生成报告", Skills: []RevisionRef{{ID: f.skill.ID, Revision: f.skill.Revision}}})
	if err != nil {
		t.Fatal(err)
	}
	approval := waitingApproval(t, m, run.ID)
	if approval.Operation.Capability.Source != "script" || approval.Operation.WorkspaceRevision != 0 || approval.Operation.Execution == nil || approval.Operation.Execution.Profile.ID != profile.ID || approval.Operation.Execution.Profile.Revision != profile.Revision || approval.Operation.Execution.ScriptDigest == "" {
		t.Fatalf("脚本审批未固定执行依据：%+v", approval)
	}
	before, err := m.Workspace(ctx, run.TaskID, "")
	if err != nil || before.Version.Revision != 0 || len(before.Files) != 0 || f.calls.Load() != 1 {
		t.Fatalf("审批前工作区变化或 MCP 次数错误：%+v calls=%d err=%v", before, f.calls.Load(), err)
	}
	_, err = m.WriteWorkspace(ctx, run.TaskID, 0, "forbidden.txt", strings.NewReader("busy"))
	runtimeErrorCode(t, err, "session-busy")
	if _, err = m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded || got.Usage.Calls != 4 {
		t.Fatalf("首轮组合执行失败：%+v", got)
	}
	first, err := m.Workspace(ctx, run.TaskID, "report.txt")
	if err != nil || string(first.Content) != "marker-resource:mcp-evidence\n" || first.Version.Revision < 1 || first.Version.BaseRevision != 0 || first.Version.TaskID != run.TaskID || first.Version.Digest == "" {
		t.Fatalf("首轮工作文件未原子提交：%+v err=%v", first, err)
	}
	next, _, err := m.ContinueTask(ctx, run.TaskID, AgentInput{RequestID: "docker-next", Content: "在下一轮验证并追加报告"})
	if err != nil {
		t.Fatal(err)
	}
	approval = waitingApproval(t, m, next.ID)
	if next.TaskID != run.TaskID || approval.Operation.WorkspaceRevision != first.Version.Revision {
		t.Fatalf("续轮审批没有固定同一任务的当前版本：%+v", approval)
	}
	pending, err := m.Workspace(ctx, run.TaskID, "report.txt")
	if err != nil || pending.Version != first.Version || string(pending.Content) != string(first.Content) {
		t.Fatalf("续轮审批前已有副作用：%+v err=%v", pending, err)
	}
	if _, err = m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, next.ID); got.Status != StateSucceeded || got.Usage.Calls != 1 {
		t.Fatalf("续轮组合执行失败：%+v", got)
	}
	second, err := m.Workspace(ctx, run.TaskID, "report.txt")
	if err != nil || string(second.Content) != "marker-resource:mcp-evidence\nsecond-run\n" || second.Version.Revision <= first.Version.Revision || second.Version.BaseRevision != first.Version.Revision {
		t.Fatalf("真实容器续轮未保留并更新文件：%+v err=%v", second, err)
	}
	_, err = m.WriteWorkspace(ctx, run.TaskID, first.Version.Revision, "stale.txt", strings.NewReader("stale"))
	runtimeErrorCode(t, err, "workspace-revision-conflict")
	old, _, err := f.extensions.Workspaces.Read(ctx, run.TaskID, first.Version.Revision, "report.txt")
	if err != nil || string(old) != string(first.Content) || f.calls.Load() != 1 || inference.Load() != 5 {
		t.Fatalf("历史版本被改写或调用被重放：old=%q MCP=%d inference=%d err=%v", old, f.calls.Load(), inference.Load(), err)
	}
	for _, id := range []string{run.ID, next.ID} {
		operations, err := m.Operations(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		var scripts int
		for _, operation := range operations {
			if operation.Capability.Source == "script" {
				scripts++
				if operation.Status != "completed" || operation.ApprovalID == "" || operation.DispatchID == "" || operation.Error != nil {
					t.Fatalf("脚本审批和执行事实未完整保存：%+v", operation)
				}
			}
		}
		if scripts != 1 {
			t.Fatalf("每轮应有且仅有一次脚本操作，实际 %d", scripts)
		}
	}
}
