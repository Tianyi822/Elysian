package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/skills"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/mcp"
)

func TestEnabledExtensionsLatestRevisionTrustAndIdempotency(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		for _, tool := range r.Tools {
			if strings.HasPrefix(tool.Name, "mcp_") || strings.HasPrefix(tool.Name, "skill_") {
				t.Error("未搜索的扩展定义进入请求")
			}
		}
		raw, _ := json.Marshal(r)
		if strings.Contains(string(raw), "marker-skill-raw") {
			t.Error("未读取技能正文进入请求")
		}
		return finalReply("仅检查目录"), nil
	}, func(d *Deps) { d.Catalog = f.extensions })
	env, err := m.PutEnvironment(ctx, session.ID, 0, f.environment())
	if err != nil {
		t.Fatal(err)
	}
	before := f.requests.Load()
	input := AgentInput{RequestID: "auto-first", Content: "检查工具", ExtensionMode: "enabled"}
	first, _, err := m.CreateTask(ctx, session.ID, input)
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatalf("first=%+v", got.Error)
	}
	if f.requests.Load() != before {
		t.Fatal("消息提交触发了 MCP 网络请求")
	}
	if first.Snapshot.Automatic == nil || len(first.Snapshot.Automatic.Servers) != 1 || len(first.Snapshot.Automatic.Skills) != 1 {
		t.Fatalf("missing automatic catalog: %+v", first.Snapshot)
	}
	if first.Snapshot.ToolLoading != onDemandToolsV2 {
		t.Fatal("not v2")
	}
	upgraded, err := f.extensions.Servers.Update(f.server.ID, f.server.Revision, mcp.Input{Name: "升级服务", Transport: f.server.Transport, URL: f.server.URL, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	catalog := f.catalog
	catalog.Tools[0].Description = "升级工具"
	catalog, err = f.extensions.Servers.SaveCatalog(upgraded.ID, upgraded.Revision, catalog)
	if err != nil {
		t.Fatal(err)
	}
	disabled, err := f.extensions.Skills.SetEnabled(f.skill.ID, f.skill.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	enabled, err := f.extensions.Skills.SetEnabled(f.skill.ID, disabled.Revision, true)
	if err != nil {
		t.Fatal(err)
	}
	second, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "auto-next", Content: "下一轮", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, second.ID); got.Status != StateSucceeded {
		t.Fatal(got.Error)
	}
	if second.Snapshot.SkillSummaries[0].Ref.Revision != enabled.Revision {
		t.Fatal("手选旧技能覆盖了最新修订")
	}
	for _, c := range second.Snapshot.Tools {
		if c.Source == "mcp-tool" && (c.Ref.Revision != upgraded.Revision || c.CatalogDigest != catalog.Digest || trusted(*second.Snapshot, c)) {
			t.Fatal("升级 MCP 继承了旧修订或信任")
		}
	}
	current, err := m.GetEnvironment(ctx, session.ID)
	if err != nil || digestJSON(current) != digestJSON(env) {
		t.Fatal("自动目录改写了会话环境")
	}
	retry, dup, err := m.CreateTask(ctx, session.ID, input)
	if err != nil || !dup || retry.Snapshot.Digest != first.Snapshot.Digest {
		t.Fatal("重试重算了目录", err)
	}
	input.ExtensionMode = ""
	if _, _, err = m.CreateTask(ctx, session.ID, input); err == nil {
		t.Fatal("extensionMode 未参与幂等校验")
	}
	if f.requests.Load() != before {
		t.Fatal("自动目录探测了服务")
	}
}

func TestEnabledExtensionsUnavailableAndAggregateLimits(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("ok"), nil
	}, func(d *Deps) { d.Catalog = f.extensions })
	secret := "never-expose-this-credential"
	unprobed, err := f.extensions.Servers.Create(mcp.Input{Name: "未探测", Transport: "streamable-http", URL: f.server.URL, Active: true, Credential: &secret})
	if err != nil {
		t.Fatal(err)
	}
	env, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	s, err := m.snapshotForAgent(ctx, env, "enabled")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Automatic.Servers) != 1 || len(s.Automatic.Unavailable) != 1 || s.Automatic.Unavailable[0].ID != unprobed.ID {
		t.Fatalf("unavailable=%+v", s.Automatic)
	}
	raw, _ := json.Marshal(s)
	if strings.Contains(string(raw), secret) || strings.Contains(string(raw), f.server.URL) {
		t.Fatal("快照泄露配置秘密")
	}
	if err = m.Revoke(ctx, "mcp", f.server.ID, f.server.Revision, "测试撤销"); err != nil {
		t.Fatal(err)
	}
	s, err = m.snapshotForAgent(ctx, env, "enabled")
	if err != nil || len(s.Automatic.Servers) != 0 || len(s.Automatic.Skills) != 1 {
		t.Fatalf("撤销过滤失败: %+v %v", s.Automatic, err)
	}
	// 大目录必须整体拒绝，而非只取前 128 项。
	catalog := mcp.Catalog{ProtocolVersion: mcp.ProtocolVersion, Capabilities: mcp.Capabilities{Tools: true}}
	for i := 0; i < 129; i++ {
		catalog.Tools = append(catalog.Tools, mcp.Tool{Name: fmt.Sprintf("tool_%d", i), InputSchema: json.RawMessage(`{"type":"object"}`)})
	}
	if _, err = f.extensions.Servers.SaveCatalog(unprobed.ID, unprobed.Revision, catalog); err != nil {
		t.Fatal(err)
	}
	if _, err = m.snapshotForAgent(ctx, env, "enabled"); err == nil {
		t.Fatal("自动汇总超限未拒绝")
	}
}

func TestSkillV2SearchReadDedupAndTaskRetention(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	alias := capabilityAlias("skill", f.skill.ID, "load")
	var count atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		n := count.Add(1)
		raw, _ := json.Marshal(r.Messages)
		if n >= 3 && strings.Count(string(raw), "marker-skill-raw") != 1 {
			t.Errorf("正文未恰好保留一份: %s", raw)
		}
		if n == 1 {
			return searchReply("integration-skill"), nil
		}
		if n == 2 || n == 3 {
			response := toolReply(alias)
			response.ToolCalls[0].Arguments = json.RawMessage(`{"action":"read","path":"SKILL.md"}`)
			return response, nil
		}
		return finalReply("已使用技能"), nil
	}, func(d *Deps) { d.Catalog = f.extensions })
	first, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "skill-v2", Content: "使用技能", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatalf("run: %+v", got.Error)
	}
	items, err := m.ContextItems(ctx, first.ID)
	if err != nil || len(items) != 1 {
		t.Fatalf("重复加载写入了正文记录: %+v %v", items, err)
	}
	next, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "skill-v2-next", Content: "继续", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, next.ID); got.Status != StateSucceeded {
		t.Fatal(got.Error)
	}
	// 提交前核算与实际组装使用同一个有效集合，不能静默裁剪。
	small := next
	copySnapshot := *next.Snapshot
	copyBudget := *copySnapshot.LoadingBudget
	copyBudget.SkillBodyTokens = 1
	copySnapshot.LoadingBudget = &copyBudget
	small.Snapshot = &copySnapshot
	if err = m.checkRetainedSkillBudget(ctx, small); err == nil {
		t.Fatal("跨轮正文预算未生效")
	}
}

func TestEnabledExtensionsStdioRequiresSelectedGrant(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	root := t.TempDir()
	configs, err := execconfig.Open(filepath.Join(root, "execution.json"), execconfig.Options{MountRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	defer configs.Close()
	f.extensions.Config = configs
	grant, err := configs.PutGrant(execconfig.GrantInput{Name: "固定网络", Enabled: true, Network: []execconfig.NetworkEndpoint{{Scheme: "https", Host: "service.example.com", Port: 443}}})
	if err != nil {
		t.Fatal(err)
	}
	server, err := f.extensions.Servers.Create(mcp.Input{Name: "stdio", Transport: "stdio", Active: true, Stdio: &mcp.ContainerInput{Image: "python@sha256:" + strings.Repeat("a", 64), Command: []string{"python3", "server.py"}, GrantID: grant.ID, GrantRevision: grant.Revision}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.extensions.Servers.SaveCatalog(server.ID, server.Revision, f.catalog); err != nil {
		t.Fatal(err)
	}
	m, session, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = f.extensions })
	env, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	before := f.requests.Load()
	for _, want := range []string{"execution-unavailable", "mcp-grant-denied"} {
		s, err := m.snapshotForAgent(ctx, env, "enabled")
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, reason := range s.Automatic.Unavailable {
			if reason.ID == server.ID && reason.Code == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("缺少脱敏原因 %s: %+v", want, s.Automatic)
		}
		f.extensions.Executor = &execution.Executor{}
	}
	env.Grants = []RevisionRef{{ID: grant.ID, Revision: grant.Revision}}
	s, err := m.snapshotForAgent(ctx, env, "enabled")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Automatic.Servers) != 2 || len(s.Environment.Grants) != 1 {
		t.Fatalf("已有授权未采用: %+v", s.Automatic)
	}
	if f.requests.Load() != before {
		t.Fatal("目录装配触发连接")
	}
	// 本测试只验证目录，不启动执行器；恢复原 fixture 的生命周期。
	f.extensions.Executor = nil
}

func TestEnabledExtensionsMaterialsKeepOriginalRevisionAndDisableNextRun(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		return finalReply("ok"), nil
	}, func(d *Deps) { d.Catalog = f.extensions })
	env := Environment{Servers: []RevisionRef{{ID: f.server.ID, Revision: f.server.Revision, Digest: f.catalog.Digest}}, Resources: []ResourceRef{{ServerID: f.server.ID, URI: "fixture://guide"}}}
	upgraded, err := f.extensions.Servers.Update(f.server.ID, f.server.Revision, mcp.Input{Name: "新版", Transport: f.server.Transport, URL: f.server.URL, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.extensions.Servers.SaveCatalog(upgraded.ID, upgraded.Revision, f.catalog); err != nil {
		t.Fatal(err)
	}
	snapshot, err := m.snapshotForAgent(ctx, env, "enabled")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range append(snapshot.Tools, snapshot.Materials...) {
		if c.Source == "mcp-tool" && c.Ref.Revision != upgraded.Revision {
			t.Fatal("工具没有采用最新修订")
		}
		if (c.Source == "mcp-resource" || c.Source == "mcp-prompt") && c.Ref.Revision != f.server.Revision {
			t.Fatal("显式资料被自动升级")
		}
	}
	first, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "before-disable", Content: "检查", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, first.ID)
	if _, err = f.extensions.Skills.SetEnabled(f.skill.ID, f.skill.Revision, false); err != nil {
		t.Fatal(err)
	}
	if _, err = f.extensions.Servers.Update(upgraded.ID, upgraded.Revision, mcp.Input{Name: "新版", Transport: upgraded.Transport, URL: upgraded.URL, Active: false}); err != nil {
		t.Fatal(err)
	}
	next, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "after-disable", Content: "继续", ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	runtimeFinished(t, m, next.ID)
	if len(next.Snapshot.Automatic.Skills) != 0 || len(next.Snapshot.Automatic.Servers) != 0 {
		t.Fatal("停用没有在下一轮生效")
	}
	original, err := m.Get(ctx, first.ID)
	if err != nil || len(original.Snapshot.Automatic.Skills) != 1 || original.Snapshot.Digest != first.Snapshot.Digest {
		t.Fatal("停用改变了已接受快照", err)
	}
	if _, err = m.snapshotForAgent(ctx, f.environment(), "enabled"); err == nil {
		t.Fatal("显式失效能力被静默跳过")
	}
}

func TestSkillV2ContinuationBudgetRejectsAndEditExcludesReplacedBody(t *testing.T) {
	ctx := context.Background()
	f := newExtensionFixture(t)
	root := t.TempDir()
	body := "---\nname: integration-skill\ndescription: 长正文预算\n---\n" + strings.Repeat("完整正文", 3000)
	if err := os.WriteFile(filepath.Join(root, "SKILL.md"), []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	job, _, err := f.extensions.Skills.StartImport(ctx, skills.ImportInput{RequestID: "large-skill", SkillID: f.skill.ID, ExpectedRevision: f.skill.Revision, Enabled: true, Source: skills.Source{Kind: "directory", Path: root}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		job, err = f.extensions.Skills.GetImport(job.ID)
		return err == nil && job.State == skills.StateSucceeded
	})
	var inference atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		n := inference.Add(1)
		raw, _ := json.Marshal(r.Messages)
		if n == 1 && !strings.Contains(string(raw), "完整正文") {
			t.Error("未加载显式技能正文")
		}
		if n > 1 && strings.Contains(string(raw), "完整正文") {
			t.Error("编辑重发仍注入被替换正文")
		}
		return finalReply("ok"), nil
	}, func(d *Deps) { d.Catalog = f.extensions })
	first, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "large-body", Content: "读取技能", ExtensionMode: "enabled", Skills: []RevisionRef{{ID: f.skill.ID, Revision: job.Revision}}})
	if err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, first.ID); done.Status != StateSucceeded {
		t.Fatalf("加载失败: %+v", done.Error)
	}
	profile, err := m.UpdateModelProfile(session.ModelProfileID, session.ModelRevision, model.Input{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: "http://127.0.0.1:9/v1", Model: "small", ContextTokens: 18000, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.SwitchSessionModel(ctx, session.ID, SwitchModelInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "body-over-budget", Content: "继续", ExtensionMode: "enabled"}); err == nil || err.(*Error).Code != "skill-body-budget" {
		t.Fatalf("续轮未在提交阶段拒绝: %v", err)
	}
	messages, err := m.Messages(ctx, session.ID, "", 100)
	if err != nil {
		t.Fatal(err)
	}
	target := ""
	for _, message := range messages.Items {
		if message.Role == "user" {
			target = message.ID
		}
	}
	edited, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "body-edit", Content: "改为直接回答", ReplaceMessageID: target, ExtensionMode: "enabled"})
	if err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, edited.ID); done.Status != StateSucceeded {
		t.Fatalf("编辑重发失败: %+v", done.Error)
	}
	active, err := m.effectiveSkills(ctx, edited)
	if err != nil || len(active) != 0 {
		t.Fatal("编辑后的脚本身份仍包含旧正文", err)
	}
}
