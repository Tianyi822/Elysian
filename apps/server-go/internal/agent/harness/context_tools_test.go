package harness

import (
	"context"
	"encoding/json"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

type expandingContextTools struct {
	agentTestTools
	expanded atomic.Bool
}

func (c *expandingContextTools) Schemas() []tools.PublicSchema {
	schemas := c.agentTestTools.Schemas()
	if c.expanded.Load() {
		for _, schema := range (&sizedCatalogTools{count: 20}).Schemas() {
			schema.Metadata.Domain = "platform"
			schemas = append(schemas, schema)
		}
		schemas = append(schemas, tools.PublicSchema{Name: "database_list", Description: "读取数据库列表", Parameters: map[string]any{"type": "object"}, Metadata: tools.Metadata{Domain: "database", Exposure: "agent", ReadOnly: true}})
	}
	return schemas
}

func TestContextUsesCurrentToolInventoryAndLatestInputAfterLegacyConversation(t *testing.T) {
	const stale = "可用工具共 4 个，只有 Docker 查询工具，无文件或数据库工具"
	const question = "你有什么工具可以调用"
	var inferences atomic.Int32
	bridge := &expandingContextTools{}
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			response := memoryReply(request)
			var proposal memoryProposal
			_ = json.Unmarshal(response.ToolCalls[0].Arguments, &proposal)
			proposal.Summary = stale
			response.ToolCalls[0].Arguments, _ = json.Marshal(proposal)
			if strings.Contains(request.Messages[0].Content, "工具按需加载") {
				t.Error("memory-only request received discovery instructions")
			}
			return response, nil
		}
		switch inferences.Add(1) {
		case 1:
			return finalReply(stale), nil
		case 2:
			latest := request.Messages[len(request.Messages)-1]
			if latest.Role != "user" || !strings.Contains(latest.Content, question) || strings.Contains(latest.Content, "输入已列于任务头部") {
				t.Errorf("latest question replaced with a reference: %+v", latest)
			}
			if !strings.Contains(request.Messages[1].Content, stale) {
				t.Error("fixture did not preserve stale working memory")
			}
			system := request.Messages[0].Content
			if !strings.Contains(system, `"total":25`) || !strings.Contains(system, `"database":1`) || !strings.Contains(system, "可能已经过期") {
				t.Errorf("current inventory did not override historical limits: %s", system)
			}
			if names := toolNames(request); len(names) != 1 || names[0] != toolSearchName {
				t.Errorf("inventory summary eagerly injected definitions: %v", names)
			}
			return searchReply("database_list"), nil
		case 3:
			if !contains(toolNames(request), "database_list") {
				t.Error("non-Docker tool was not loaded")
			}
			return toolReply("database_list"), nil
		default:
			return finalReply("本轮支持按需加载数据库与平台工具"), nil
		}
	}, func(d *Deps) { d.Tools = bridge })
	first := submitAgentTest(t, m, session, "old-four-tools", "你好，你是什么模型")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatalf("legacy fixture failed: %+v", got)
	}
	bridge.expanded.Store(true)
	run, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "current-tool-question", Content: question})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
		t.Fatalf("expanded tool conversation failed: %+v", got)
	}
	calls, err := m.store.calls(context.Background(), run.ID, "", 50)
	if err != nil || len(calls.Items) != 2 || calls.Items[0].Tool != toolSearchName || calls.Items[1].Tool != "database_list" || calls.Items[1].Status != StateSucceeded {
		t.Fatalf("non-Docker discovery/execution failed: %+v %v", calls, err)
	}
}

func TestToolInventorySummaryIsBoundedToCurrentSnapshot(t *testing.T) {
	snapshot := CapabilitySnapshot{ToolLoading: onDemandTools, Tools: []Capability{
		toolSearchCapability(),
		{Name: "database_list", Description: "PRIVATE_DESCRIPTION", Source: "builtin", Metadata: tools.Metadata{Domain: "database"}},
		{Name: "selected_skill", Source: "skill-load"},
	}, Materials: []Capability{{Name: "user_selected_prompt", Source: "mcp-prompt"}}}
	inventory := snapshot.toolInventory()
	if inventory.Total != 2 || inventory.Domains["database"] != 1 || inventory.Domains["skill-load"] != 1 || len(inventory.Domains) != 2 {
		t.Fatalf("inventory counts include hidden material/search: %+v", inventory)
	}
	if inventory.Notes["database"] == "" || inventory.Notes["skill-load"] == "" || len(inventory.Notes) != 2 {
		t.Fatalf("inventory notes must cover present domains only: %+v", inventory)
	}
	a := &agentExecution{run: Run{DriverVersion: "v2", Snapshot: &snapshot, Task: &Task{}}}
	system := baseContext(a, WorkingMemory{}, agentSystem, nil)[0].Content
	for _, hidden := range []string{"database_list", "PRIVATE_DESCRIPTION", "selected_skill", "user_selected_prompt", "parameters"} {
		if strings.Contains(system, hidden) {
			t.Errorf("inventory exposed tool detail: %s", hidden)
		}
	}
	for _, fixedSystem := range []string{memorySystem, workflowFinishSystem} {
		if got := baseContext(a, WorkingMemory{}, fixedSystem, nil)[0].Content; got != fixedSystem {
			t.Errorf("fixed-function system was changed: %s", got)
		}
	}
}

func TestContextToolSearchDisciplineAndDomainBoundaries(t *testing.T) {
	snapshot := CapabilitySnapshot{ToolLoading: onDemandTools, Tools: []Capability{
		toolSearchCapability(),
		{Name: "platform_metrics", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Domain: "platform"}},
		{Name: "docker_containers_list", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Domain: "docker"}},
	}}
	a := &agentExecution{run: Run{DriverVersion: "v2", Snapshot: &snapshot, Task: &Task{}}}
	system := baseContext(a, WorkingMemory{}, agentSystem, nil)[0].Content
	for _, want := range []string{"同一子目标连续搜索不超过两次", `"notes"`, "不含逐容器资源统计", "该能力或数据不可得"} {
		if !strings.Contains(system, want) {
			t.Errorf("按需加载系统提示词缺少 %q：%s", want, system)
		}
	}
	if !strings.Contains(toolSearchCapability().Description, "最多连续搜索两次") || !strings.Contains(toolSearchCapability().Description, "notes") {
		t.Error("tool_search 描述缺少搜索纪律")
	}
}
