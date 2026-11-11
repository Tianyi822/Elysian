package harness

import (
	"context"
	"encoding/json"
	"reflect"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

func TestRetiredToolsUseExactRegisteredReplacements(t *testing.T) {
	for _, test := range []struct{ old, current string }{
		{"docker_container_start", "docker_container_power"},
		{"docker_container_stop", "docker_container_power"},
		{"docker_container_restart", "docker_container_power"},
		{"docker_policy_view", "docker_context_view"},
		{"docker_self_container", "docker_context_view"},
		{"website_start", "docker_container_power"},
		{"website_stop", "docker_container_power"},
		{"website_source_analysis", "website_source_get"},
		{"website_deployment_logs", "website_deployment_get"},
		{"docker_image_pull_logs", "docker_image_pull_get"},
		{"registry_host_check", "docker_registry_probe"},
		{"app_build_logs", "build_get"},
		{"app_directory", "app_lookup"},
		{"app_workspace_remove_file", "app_workspace_write"},
		{"platform_memory", "platform_sample"},
		{"platform_metrics", "platform_sample"},
	} {
		t.Run(test.old, func(t *testing.T) {
			m := &Manager{deps: Deps{Tools: &dockerSelectionTools{schemas: []tools.PublicSchema{
				{Name: test.current, Metadata: tools.Metadata{Exposure: "agent"}},
			}}}}
			env := Environment{Tools: []string{test.old}, TrustedReadOnly: []string{test.old}}
			got := m.withCurrentAgentTools(env)
			if !reflect.DeepEqual(got.Tools, []string{test.current}) || len(got.TrustedReadOnly) != 0 {
				t.Fatalf("退役工具未精确承接或继承了旧授权：%+v", got)
			}
			if env.Tools[0] != test.old || env.TrustedReadOnly[0] != test.old {
				t.Fatalf("派生改写了原环境：%+v", env)
			}
		})
	}
}

func TestRetiredToolReplacementRespectsRegistrationAndExistingSelections(t *testing.T) {
	for _, exposure := range []string{"", "human"} {
		m := &Manager{deps: Deps{Tools: &dockerSelectionTools{schemas: []tools.PublicSchema{
			{Name: "platform_sample", Metadata: tools.Metadata{Exposure: exposure}},
		}}}}
		got := m.withCurrentAgentTools(Environment{Tools: []string{"platform_memory", "app_directory"}})
		if len(got.Tools) != 0 {
			t.Fatalf("承接了未装配的 Agent 工具：%+v", got)
		}
	}
	m := &Manager{deps: Deps{Tools: &dockerSelectionTools{schemas: []tools.PublicSchema{
		{Name: "platform_sample", Metadata: tools.Metadata{Exposure: "agent"}},
	}}}}
	env := Environment{
		Tools:           []string{"platform_memory", "platform_metrics", "platform_sample", "unchanged", "unchanged", "docker_container_start_extra", "website_start_extra", "app_directory_extra", "database_list"},
		TrustedReadOnly: []string{"platform_memory", "platform_metrics", "database_list", "unchanged"},
	}
	got := m.withCurrentAgentTools(env)
	want := []string{"platform_sample", "unchanged", "unchanged", "docker_container_start_extra", "website_start_extra", "app_directory_extra"}
	if !reflect.DeepEqual(got.Tools, want) || !reflect.DeepEqual(got.TrustedReadOnly, []string{"unchanged"}) {
		t.Fatalf("承接合并改变了原选择或匹配了非精确名称：%+v", got)
	}
	merged := m.withCurrentAgentTools(Environment{Tools: []string{"platform_memory", "platform_metrics"}})
	if !reflect.DeepEqual(merged.Tools, []string{"platform_sample"}) {
		t.Fatalf("多个旧工具的承接应只选择一次：%v", merged.Tools)
	}
}

func TestRetiredToolsRemainUsableThroughNewContinuedAndEditedRuns(t *testing.T) {
	legacy := []string{"platform_memory", "platform_metrics", "app_directory", "app_build_logs", "website_source_analysis", "website_deployment_logs"}
	current := []string{"platform_sample", "app_lookup", "build_get", "website_source_get", "website_deployment_get"}
	var schemas []tools.PublicSchema
	for _, name := range append(append([]string{}, legacy...), current...) {
		schemas = append(schemas, tools.PublicSchema{
			Name: name, Description: "读取平台状态", Parameters: map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false},
			Metadata: tools.Metadata{Exposure: "agent", ReadOnly: true, Version: "1"},
		})
	}
	invoker := &dockerSelectionTools{schemas: schemas}
	var step atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		switch (step.Add(1) - 1) % 3 {
		case 0:
			return searchReply("platform_sample"), nil
		case 1:
			return toolReply("platform_sample"), nil
		default:
			return finalReply("已读取平台采样"), nil
		}
	}, func(d *Deps) { d.Tools = invoker })
	ctx := context.Background()
	env, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(env.Tools, current) {
		t.Fatalf("新环境应只选择现行工具：%v", env.Tools)
	}
	env.Tools, env.TrustedReadOnly = legacy, append([]string{}, legacy...)
	env, err = m.PutEnvironment(ctx, session.ID, env.Revision, env)
	if err != nil {
		t.Fatal(err)
	}
	oldSnapshot, err := m.snapshot(ctx, env)
	if err != nil {
		t.Fatal(err)
	}
	oldBytes, err := json.Marshal(oldSnapshot)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := m.ToolCatalog(ctx, session.ID, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	selected := map[string]bool{}
	for _, entry := range catalog.Items {
		if retiredFromNewChats(entry.Name) {
			t.Fatalf("目录仍包含退役工具：%s", entry.Name)
		}
		selected[entry.Name] = entry.Selected
	}
	for _, name := range current {
		if !selected[name] {
			t.Fatalf("目录未选择承接工具：%s", name)
		}
	}
	first := submitAgentTest(t, m, session, "replacement-new", "读取平台采样")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatalf("新运行无法使用承接工具：%+v", got)
	}
	continued, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "replacement-continue", Content: "再读取一次"})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, continued.ID); got.Status != StateSucceeded {
		t.Fatalf("续聊无法使用承接工具：%+v", got)
	}
	messages, err := m.Messages(ctx, session.ID, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	var lastUser string
	for _, message := range messages.Items {
		if message.Role == "user" {
			lastUser = message.ID
		}
	}
	edited, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "replacement-edit", Content: "检查平台采样", ReplaceMessageID: lastUser})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, edited.ID); got.Status != StateSucceeded {
		t.Fatalf("编辑重发无法使用承接工具：%+v", got)
	}
	for _, run := range []Run{first, continued, edited} {
		if !reflect.DeepEqual(run.Snapshot.Environment.Tools, current) || len(run.Snapshot.Environment.TrustedReadOnly) != 0 {
			t.Fatalf("运行承接选择或信任错误：%+v", run.Snapshot.Environment)
		}
		for _, name := range current {
			if _, ok := dockerSnapshotTool(*run.Snapshot, name); !ok {
				t.Fatalf("运行 %s 缺少承接工具 %s", run.ID, name)
			}
		}
	}
	if got := invoker.count.Load(); got != 3 {
		t.Fatalf("三类运行应各执行一次承接工具，实际 %d 次", got)
	}
	saved, err := m.GetEnvironment(ctx, session.ID)
	if err != nil || !reflect.DeepEqual(saved, env) {
		t.Fatalf("已保存环境被改写：%+v %v", saved, err)
	}
	stillOld, err := json.Marshal(oldSnapshot)
	if err != nil || string(stillOld) != string(oldBytes) {
		t.Fatalf("已接受的旧快照被改写：%v", err)
	}
}
