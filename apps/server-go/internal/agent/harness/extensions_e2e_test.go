package harness

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/mcp"
)

// 自动接入的真实端到端链路：extensionMode=enabled 时快照只从本地已启用目录与
// 已保存探测目录固定能力，未搜索的 MCP／技能定义不进入模型请求；tool_search
// 成功加载后才可调用；MCP 调用落到假 HTTP 服务并把结果带回下一轮模型请求；
// SKILL.md 完整读取一份原文、工具事实替换为引用；重启后已接受快照不回算。
func TestEnabledExtensionsEndToEndSearchLoadMCPCallAndSkillBody(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	toolAlias := capabilityAlias("mcp", f.server.ID, "inspect")
	skillAlias := capabilityAlias("skill", f.skill.ID, "load")
	var inference atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		names := toolNames(request)
		raw, _ := json.Marshal(request)
		text := string(raw)
		switch inference.Add(1) {
		case 1:
			if !contains(names, toolSearchName) || !contains(names, userInputTool) || !contains(names, planTool) {
				t.Errorf("初始请求缺少常驻入口: %v", names)
			}
			for _, name := range names {
				if strings.HasPrefix(name, "mcp_") || strings.HasPrefix(name, "skill_") {
					t.Errorf("未搜索的扩展定义进入初始请求: %s", name)
				}
			}
			if !strings.Contains(text, "integration-skill") {
				t.Error("技能索引未进入初始请求")
			}
			if strings.Contains(text, "marker-skill-raw") {
				t.Error("未读取的 SKILL.md 正文进入初始请求")
			}
			response := searchReply("integration-skill")
			response.ToolCalls = append(response.ToolCalls, model.ToolCall{ID: "call_search_mcp", Name: toolSearchName, Arguments: json.RawMessage(`{"query":"inspect"}`)})
			return response, nil
		case 2:
			if !contains(names, skillAlias) || !contains(names, toolAlias) {
				t.Errorf("成功搜索后定义未加载: %v", names)
			}
			response := model.Response{FinishReason: "tool_calls"}
			response.ToolCalls = append(response.ToolCalls,
				model.ToolCall{ID: "call_skill", Name: skillAlias, Arguments: json.RawMessage(`{"action":"read","path":"SKILL.md"}`)},
				model.ToolCall{ID: "call_mcp", Name: toolAlias, Arguments: json.RawMessage(`{}`)})
			return response, nil
		case 3:
			if f.calls.Load() != 1 {
				t.Errorf("MCP tools/call 未落到假服务: %d", f.calls.Load())
			}
			if !strings.Contains(text, "mcp-evidence") {
				t.Error("MCP 结果未回到模型请求")
			}
			if strings.Count(text, "marker-skill-raw") != 1 {
				t.Errorf("技能正文应只保留一份原文: %d", strings.Count(text, "marker-skill-raw"))
			}
			if !strings.Contains(text, "skill-instruction-recorded") {
				t.Error("已加载技能的工具事实未替换为引用")
			}
			return finalReply("端到端完成"), nil
		default:
			return finalReply("后续轮次直接回答"), nil
		}
	}, func(d *Deps) { d.Catalog = f.extensions })
	// 只固定修订与目录摘要、声明别名只读；自动工具仍须搜索后才可见，调用才免审批。
	env := Environment{
		Servers:         []RevisionRef{{ID: f.server.ID, Revision: f.server.Revision, Digest: f.catalog.Digest}},
		Tools:           []string{toolAlias},
		TrustedReadOnly: []string{toolAlias},
	}
	if _, err := m.PutEnvironment(ctx, session.ID, 0, env); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "auto-invalid", Content: "无效模式", ExtensionMode: "auto"}); err == nil {
		t.Fatal("无效 extensionMode 未拒绝")
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "auto-e2e", Content: "使用技能并调用 MCP 工具", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.Usage.Calls != 4 || f.calls.Load() != 1 {
		t.Fatalf("run=%+v calls=%d", got, f.calls.Load())
	}
	if got.Snapshot == nil || got.Snapshot.Automatic == nil || got.Snapshot.ToolLoading != onDemandToolsV2 || got.Snapshot.LoadingBudget == nil {
		t.Fatalf("快照未固定 v2 自动目录: %+v", got.Snapshot)
	}
	if len(got.Snapshot.Automatic.Skills) != 1 || got.Snapshot.Automatic.Skills[0].Digest == "" || len(got.Snapshot.Automatic.Servers) != 1 || got.Snapshot.Automatic.Servers[0].Digest != f.catalog.Digest || len(got.Snapshot.Automatic.Unavailable) != 0 {
		t.Fatalf("自动目录不完整: %+v", got.Snapshot.Automatic)
	}
	trustedTool := false
	for _, c := range got.Snapshot.Tools {
		if c.Source == "mcp-tool" && c.Name == toolAlias {
			trustedTool = c.ReadOnly && c.Ref.Revision == f.server.Revision && c.CatalogDigest == f.catalog.Digest
		}
	}
	if !trustedTool {
		t.Fatal("自动目录未按精确修订与目录摘要继承只读信任")
	}
	items, err := m.ContextItems(ctx, run.ID)
	if err != nil || len(items) != 1 || items[0].Path != "SKILL.md" || items[0].Digest == "" || items[0].Source != "skill-load" {
		t.Fatalf("技能读取未生成固定加载身份: %+v %v", items, err)
	}
	calls, err := m.store.calls(ctx, run.ID, "", 50)
	if err != nil || len(calls.Items) != 4 {
		t.Fatalf("调用记录不完整: %+v %v", calls, err)
	}
	wantTools := []string{toolSearchName, toolSearchName, skillAlias, toolAlias}
	for i, want := range wantTools {
		if calls.Items[i].Tool != want || calls.Items[i].Status != StateSucceeded {
			t.Fatalf("第 %d 次调用=%+v", i, calls.Items[i])
		}
	}
	records, err := m.ModelRequests(ctx, run.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	var toolNamesByIndex [][]string
	for _, record := range records.Items {
		if record.Purpose != "inference" {
			continue
		}
		toolNamesByIndex = append(toolNamesByIndex, record.ToolNames)
	}
	if len(toolNamesByIndex) != 3 {
		t.Fatalf("推理请求数量=%d", len(toolNamesByIndex))
	}
	if contains(toolNamesByIndex[0], toolAlias) || contains(toolNamesByIndex[0], skillAlias) || !contains(toolNamesByIndex[0], toolSearchName) {
		t.Fatalf("首个请求的实际工具名单=%v", toolNamesByIndex[0])
	}
	if !contains(toolNamesByIndex[1], toolAlias) || !contains(toolNamesByIndex[1], skillAlias) || !contains(toolNamesByIndex[2], toolAlias) {
		t.Fatalf("搜索后实际工具名单=%v / %v", toolNamesByIndex[1], toolNamesByIndex[2])
	}
	// 面板重启：已接受 Run 的快照、自动目录与技能加载身份都按原事实恢复。
	m = reopenOperationManager(t, m)
	recovered, err := m.Get(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Snapshot.Digest != got.Snapshot.Digest || recovered.Snapshot.Automatic == nil || len(recovered.Snapshot.Automatic.Servers) != 1 || recovered.Snapshot.Automatic.Servers[0].Digest != f.catalog.Digest {
		t.Fatalf("重启改变了已接受快照: %+v", recovered.Snapshot)
	}
	if items, err = m.ContextItems(ctx, run.ID); err != nil || len(items) != 1 || items[0].Digest == "" {
		t.Fatalf("重启丢失技能加载身份: %+v %v", items, err)
	}
}

// 自动接入只覆盖工具目录：显式选择的 MCP 资料与提示保持提交时固定的服务修订，
// 即使同一服务已升级；两者作为父端资料组在首次推理前加载并进入请求。
func TestEnabledExtensionsExplicitMaterialsKeepPinnedRevision(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	resourceAlias := capabilityAlias("resource", f.server.ID, "fixture://guide")
	promptAlias := capabilityAlias("prompt", f.server.ID, "review")
	env := Environment{
		Servers:         []RevisionRef{{ID: f.server.ID, Revision: f.server.Revision, Digest: f.catalog.Digest}},
		Resources:       []ResourceRef{{ServerID: f.server.ID, URI: "fixture://guide"}},
		TrustedReadOnly: []string{resourceAlias, promptAlias},
	}
	var inference atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		inference.Add(1)
		raw, _ := json.Marshal(request)
		text := string(raw)
		if !strings.Contains(text, "marker-resource") || !strings.Contains(text, "marker-prompt") {
			t.Error("显式资料或提示未在首次推理前进入请求")
		}
		for _, name := range toolNames(request) {
			if strings.HasPrefix(name, "mcp_") {
				t.Errorf("显式资料隐式提供了可调用定义: %s", name)
			}
		}
		return finalReply("资料已读取"), nil
	}, func(d *Deps) { d.Catalog = f.extensions })
	if _, err := m.PutEnvironment(ctx, session.ID, 0, env); err != nil {
		t.Fatal(err)
	}
	upgraded, err := f.extensions.Servers.Update(f.server.ID, f.server.Revision, mcp.Input{Name: "升级服务", Transport: f.server.Transport, URL: f.server.URL, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.extensions.Servers.SaveCatalog(upgraded.ID, upgraded.Revision, f.catalog); err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{
		RequestID:     "auto-materials",
		Content:       "读取显式选择的资料与提示",
		ExtensionMode: "enabled",
		Resources:     env.Resources,
		Prompts:       []PromptRef{{ServerID: f.server.ID, Name: "review", Arguments: json.RawMessage(`{"subject":"固定资料"}`)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || f.calls.Load() != 0 || inference.Load() != 1 {
		t.Fatalf("run=%+v calls=%d inferences=%d", got, f.calls.Load(), inference.Load())
	}
	items, err := m.ContextItems(ctx, run.ID)
	if err != nil || len(items) != 2 {
		t.Fatalf("显式资料加载身份=%+v %v", items, err)
	}
	sources := map[string]RevisionRef{}
	for _, item := range items {
		sources[item.Source] = item.Ref
	}
	if sources["mcp-resource"].Revision != f.server.Revision || sources["mcp-prompt"].Revision != f.server.Revision {
		t.Fatalf("显式资料被自动升级: %+v", sources)
	}
	// 资料组由父端生成，不经模型提议；以固定操作记录核实两条读取都发生过。
	operations, err := m.Operations(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	materialSources := map[string]int{}
	for _, operation := range operations {
		materialSources[operation.Capability.Source]++
	}
	if materialSources["mcp-resource"] != 1 || materialSources["mcp-prompt"] != 1 {
		t.Fatalf("资料组调用=%+v", materialSources)
	}
	// 自动工具采用最新修订；显式资料与提示保持原修订且只读信任精确绑定。
	autoToolRevision, resourceRevision, promptRevision := 0, 0, 0
	for _, c := range got.Snapshot.Tools {
		if c.Source == "mcp-tool" && c.Ref.ID == f.server.ID {
			autoToolRevision = c.Ref.Revision
		}
		if c.Source == "mcp-resource" && c.Ref.ID == f.server.ID {
			resourceRevision = c.Ref.Revision
			if !c.ReadOnly {
				t.Error("显式资料丢失精确只读信任")
			}
		}
	}
	for _, c := range got.Snapshot.Materials {
		if c.Source == "mcp-prompt" && c.Ref.ID == f.server.ID {
			promptRevision = c.Ref.Revision
			if !c.ReadOnly {
				t.Error("显式提示丢失精确只读信任")
			}
		}
	}
	if autoToolRevision != upgraded.Revision || resourceRevision != f.server.Revision || promptRevision != f.server.Revision {
		t.Fatalf("自动工具=%d 显式资料=%d 提示=%d，期望 %d／%d／%d", autoToolRevision, resourceRevision, promptRevision, upgraded.Revision, f.server.Revision, f.server.Revision)
	}
}

// 自动接入不增加只读信任：同一 MCP 工具在没有精确别名＋修订＋目录摘要的环境里
// 仍须逐调用审批；审批恢复后只执行原提议一次，结果进入下一轮模型请求。
func TestEnabledExtensionsAutoMCPCallRequiresApprovalAndResumes(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	toolAlias := capabilityAlias("mcp", f.server.ID, "inspect")
	var inference atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		names := toolNames(request)
		raw, _ := json.Marshal(request)
		text := string(raw)
		switch inference.Add(1) {
		case 1:
			for _, name := range names {
				if strings.HasPrefix(name, "mcp_") {
					t.Errorf("未搜索的 MCP 定义进入初始请求: %s", name)
				}
			}
			return searchReply("inspect"), nil
		case 2:
			if !contains(names, toolAlias) {
				t.Fatalf("搜索后未加载 MCP 定义: %v", names)
			}
			return toolReply(toolAlias), nil
		case 3:
			if f.calls.Load() != 1 || !strings.Contains(text, "mcp-evidence") {
				t.Errorf("审批后 MCP 结果未回到模型: calls=%d", f.calls.Load())
			}
			return finalReply("审批后完成"), nil
		default:
			return finalReply("后续直接回答"), nil
		}
	}, func(d *Deps) { d.Catalog = f.extensions })
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "auto-approval", Content: "调用需要审批的 MCP 工具", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	approval := waitingApproval(t, m, run.ID)
	if approval.Operation.Capability.Name != toolAlias || approval.Operation.Capability.Source != "mcp-tool" || approval.Operation.Capability.ReadOnly || approval.Operation.Policy != "approval-required" || approval.Operation.Capability.CatalogDigest != f.catalog.Digest {
		t.Fatalf("自动目录未按既有审批边界固定操作: %+v", approval.Operation)
	}
	if f.calls.Load() != 0 {
		t.Fatalf("审批前已执行 MCP 调用: %d", f.calls.Load())
	}
	if _, err = m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || f.calls.Load() != 1 || inference.Load() != 3 {
		t.Fatalf("审批恢复失败: %+v calls=%d inferences=%d", got, f.calls.Load(), inference.Load())
	}
	operations, err := m.Operations(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	var executed int
	for _, operation := range operations {
		if operation.Capability.Source == "mcp-tool" {
			executed++
			if operation.Status != "completed" || operation.ApprovalID != approval.ID || operation.DispatchID == "" || operation.Error != nil {
				t.Fatalf("审批执行事实不完整: %+v", operation)
			}
		}
	}
	if executed != 1 {
		t.Fatalf("MCP 操作数=%d", executed)
	}
}
