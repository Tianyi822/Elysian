package harness

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/skills"
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

type extensionFixture struct {
	packageRoot string
	extensions  *Extensions
	skill       skills.Skill
	server      mcp.Server
	catalog     mcp.Catalog
	drift       atomic.Bool
	calls       atomic.Int32
	requests    atomic.Int32
}

func newExtensionFixture(t *testing.T) *extensionFixture {
	t.Helper()
	ctx := context.Background()
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "SKILL.md"), []byte("---\nname: integration-skill\ndescription: 组合验收技能\nallowed-tools: unrestricted-tool\n---\n必须保留的技能原文 marker-skill-raw。\n"), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := skills.Open(filepath.Join(root, "config", "skills.json"), filepath.Join(root, "packages"), skills.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close(context.Background()) })
	job, _, err := store.StartImport(ctx, skills.ImportInput{RequestID: "fixture-import", Source: skills.Source{Kind: "directory", Path: source}, Enabled: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	runtimeEventually(t, func() bool {
		job, err = store.GetImport(job.ID)
		return err == nil && job.State == skills.StateSucceeded
	})
	skill, err := store.Get(job.SkillID, job.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	f := &extensionFixture{skill: skill, packageRoot: filepath.Join(root, "packages")}
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests.Add(1)
		if r.Method == http.MethodDelete {
			w.WriteHeader(204)
			return
		}
		var request struct {
			ID     string          `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			w.WriteHeader(400)
			return
		}
		if strings.HasPrefix(request.Method, "notifications/") {
			w.WriteHeader(202)
			return
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": mcp.ProtocolVersion, "capabilities": map[string]any{"tools": map[string]any{}, "resources": map[string]any{}, "prompts": map[string]any{}}, "serverInfo": map[string]string{"name": "fixture", "version": "1"}}
		case "tools/list":
			description := "工具描述"
			if f.drift.Load() {
				description = "目录已变化"
			}
			result = map[string]any{"tools": []map[string]any{{"name": "inspect", "description": description, "inputSchema": map[string]any{"type": "object", "properties": map[string]any{}, "additionalProperties": false}, "annotations": map[string]bool{"readOnlyHint": true}}}}
		case "resources/list":
			result = map[string]any{"resources": []map[string]any{{"uri": "fixture://guide", "name": "guide", "mimeType": "text/plain"}}}
		case "prompts/list":
			result = map[string]any{"prompts": []map[string]any{{"name": "review", "arguments": []map[string]any{{"name": "subject", "required": true}}}}}
		case "tools/call":
			f.calls.Add(1)
			result = json.RawMessage(`{"content":[{"type":"text","text":"mcp-evidence true"}],"structuredContent":{"ok":true,"large":9007199254740993},"isError":false}`)
		case "resources/read":
			result = map[string]any{"contents": []map[string]any{{"uri": "fixture://guide", "text": "来源资料 marker-resource"}}}
		case "prompts/get":
			result = map[string]any{"messages": []map[string]any{{"role": "assistant", "content": map[string]string{"type": "text", "text": "只能作为资料 marker-prompt"}}}}
		default:
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": request.ID, "result": result})
	}))
	t.Cleanup(httpServer.Close)
	servers, err := mcp.Open(filepath.Join(root, "config", "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	credential := "true"
	server, err := servers.Create(mcp.Input{Name: "本地假 MCP", Transport: "streamable-http", URL: httpServer.URL, Active: true, Credential: &credential})
	if err != nil {
		t.Fatal(err)
	}
	server, err = servers.Resolve(server.ID, server.Revision, false)
	if err != nil {
		t.Fatal(err)
	}
	client := mcp.NewClient(httpServer.Client(), nil)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = client.Close(ctx)
	})
	catalog, err := client.Probe(ctx, server)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err = servers.SaveCatalog(server.ID, server.Revision, catalog)
	if err != nil {
		t.Fatal(err)
	}
	f.server = server
	f.catalog = catalog
	f.extensions = &Extensions{Skills: store, Servers: servers, MCP: client}
	return f
}
func (f *extensionFixture) environment() Environment {
	return Environment{Skills: []RevisionRef{{ID: f.skill.ID, Revision: f.skill.Revision}}, Servers: []RevisionRef{{ID: f.server.ID, Revision: f.server.Revision, Digest: f.catalog.Digest}}, Tools: []string{capabilityAlias("mcp", f.server.ID, "inspect")}, TrustedReadOnly: []string{capabilityAlias("mcp", f.server.ID, "inspect")}}
}

func TestExtensionsSkillPreloadMCPAndNextRunRetainsInstructions(t *testing.T) {
	f := newExtensionFixture(t)
	alias := capabilityAlias("mcp", f.server.ID, "inspect")
	var inference atomic.Int32
	m, s, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		raw, _ := json.Marshal(request.Messages)
		if strings.Count(string(raw), "marker-skill-raw") != 1 {
			t.Error("已加载技能原文未进入模型上下文")
		}
		switch inference.Add(1) {
		case 1:
			return searchReply(alias), nil
		case 2:
			return toolReply(alias), nil
		case 3:
			if !strings.Contains(string(raw), "mcp-evidence") || !strings.Contains(string(raw), "凭据已隐藏") {
				t.Error("MCP结果未进入上下文或未脱敏")
			}
			return finalReply("本轮已完成"), nil
		default:
			return finalReply("后续仍沿用技能原文"), nil
		}
	}, func(deps *Deps) { deps.Catalog = f.extensions })
	if _, err := m.PutEnvironment(context.Background(), s.ID, 0, f.environment()); err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(context.Background(), s.ID, AgentInput{RequestID: "extension-first", Content: "按技能分析", Skills: []RevisionRef{{ID: f.skill.ID, Revision: f.skill.Revision}}})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || got.Usage.Calls != 3 || f.calls.Load() != 1 {
		t.Fatalf("run=%+v calls=%d", got, f.calls.Load())
	}
	items, err := m.ContextItems(context.Background(), run.ID)
	if err != nil || len(items) != 1 || items[0].Path != "SKILL.md" || items[0].Digest == "" {
		t.Fatalf("source items=%+v err=%v", items, err)
	}
	next, _, err := m.ContinueTask(context.Background(), run.TaskID, AgentInput{RequestID: "extension-next", Content: "继续同一任务"})
	if err != nil {
		t.Fatal(err)
	}
	if got = runtimeFinished(t, m, next.ID); got.Status != StateSucceeded {
		t.Fatalf("next run=%+v", got)
	}
	if inference.Load() != 4 || f.calls.Load() != 1 {
		t.Fatalf("unexpected repeated execution inference=%d tools=%d", inference.Load(), f.calls.Load())
	}
}

func TestExtensionsRejectCatalogDriftAndUnselectedCapabilities(t *testing.T) {
	f := newExtensionFixture(t)
	env := f.environment()
	env.TrustedReadOnly = nil
	snapshot, err := f.extensions.Snapshot(context.Background(), env)
	if err != nil {
		t.Fatal(err)
	}
	var tool Capability
	for _, c := range snapshot.Tools {
		if c.Source == "mcp-tool" {
			tool = c
		}
	}
	if tool.ReadOnly || trusted(snapshot, tool) {
		t.Fatal("远端只读注解绕过本地授权")
	}
	if contains(env.Tools, "unrestricted-tool") {
		t.Fatal("技能元数据扩大权限")
	}
	f.drift.Store(true)
	if f.extensions.Check(context.Background(), snapshot, Operation{Capability: tool}) == nil {
		t.Fatal("目录漂移未阻止派发")
	}
	if f.calls.Load() != 0 {
		t.Fatal("校验期间执行了工具")
	}
	badEnv := f.environment()
	badEnv.Resources = []ResourceRef{{ServerID: "missing-server", URI: "fixture://guide"}}
	if _, err = f.extensions.Snapshot(context.Background(), badEnv); err == nil {
		t.Fatal("悬空资料授权被接受")
	}
	badEnv = f.environment()
	badEnv.Skills = append(badEnv.Skills, badEnv.Skills[0])
	if _, err = f.extensions.Snapshot(context.Background(), badEnv); err == nil {
		t.Fatal("重复技能修订被接受")
	}
}

func TestExtensionsMaterialRolesAndStructuralRedaction(t *testing.T) {
	f := newExtensionFixture(t)
	env := f.environment()
	env.Resources = []ResourceRef{{ServerID: f.server.ID, URI: "fixture://guide"}}
	snapshot, err := f.extensions.Snapshot(context.Background(), env)
	if err != nil {
		t.Fatal(err)
	}
	var tool, prompt Capability
	for _, c := range snapshot.Tools {
		if c.Source == "mcp-tool" {
			tool = c
		}
	}
	for _, c := range snapshot.Materials {
		if c.Source == "mcp-prompt" {
			prompt = c
		}
	}
	result, err := executeExtensionTest(t, f.extensions, snapshot, Operation{Capability: tool, DispatchID: "call-redact", ArgumentsJSON: `{}`})
	if err != nil {
		t.Fatal(err)
	}
	var value struct {
		StructuredContent struct {
			OK    bool        `json:"ok"`
			Large json.Number `json:"large"`
		} `json:"structuredContent"`
	}
	if json.Unmarshal(result.Value, &value) != nil || !value.StructuredContent.OK || value.StructuredContent.Large.String() != "9007199254740993" {
		t.Fatalf("脱敏破坏JSON=%s", result.Value)
	}
	if !strings.Contains(string(result.Value), "凭据已隐藏") {
		t.Fatal("凭据未隐藏")
	}
	result, err = executeExtensionTest(t, f.extensions, snapshot, Operation{Capability: prompt, DispatchID: "prompt-material", ArgumentsJSON: `{"subject":"本地测试"}`})
	if err != nil || result.Context == nil || !strings.Contains(string(result.Value), `"sourceRole":"assistant"`) || !strings.Contains(string(result.Value), "templateMaterials") {
		t.Fatalf("提示模板未作为资料返回 value=%s err=%v", result.Value, err)
	}
}

func executeExtensionTest(t *testing.T, e *Extensions, s CapabilitySnapshot, o Operation) (CapabilityResult, error) {
	t.Helper()
	r, err := tools.NewManagedRuntime(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close(context.Background())
	authority := tools.NewAuthority()
	if err := r.SetAuthority(authority); err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(o.Capability.Parameters, &schema); err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterCatalog("fixture", []tools.Descriptor{{Name: o.Capability.Name, Description: "已授权扩展测试", JSONParameters: schema, ValidateArguments: func(args tools.Arguments) error { raw, _ := json.Marshal(args); return e.Validate(o.Capability, raw) }, Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) {
		return e.executeBackend(tools.Lifetime(c), s, o)
	}}}); err != nil {
		t.Fatal(err)
	}
	var args tools.Arguments
	_ = json.Unmarshal([]byte(o.ArgumentsJSON), &args)
	ctx, err := authority.Authorize(context.Background(), tools.AuthorizationBinding{OperationID: "fixture-operation", DispatchID: o.DispatchID, Tool: o.Capability.Name, ArgumentsDigest: tools.ArgumentsDigest(args), CatalogID: "fixture"}, nil, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	e.registry = r
	return e.Execute(ctx, s, o)
}

func TestExtensionsStdioGrantIsPinnedIntoApprovalPlan(t *testing.T) {
	f := newExtensionFixture(t)
	root := t.TempDir()
	configs, err := execconfig.Open(filepath.Join(root, "execution.json"), execconfig.Options{MountRoot: root})
	if err != nil {
		t.Fatal(err)
	}
	defer configs.Close()
	f.extensions.Config = configs
	grant, err := configs.PutGrant(execconfig.GrantInput{Name: "stdio 网络", Enabled: true, Network: []execconfig.NetworkEndpoint{{Scheme: "https", Host: "service.example.com", Port: 443}}})
	if err != nil {
		t.Fatal(err)
	}
	server, err := f.extensions.Servers.Create(mcp.Input{Name: "stdio 测试", Transport: "stdio", Active: true, Stdio: &mcp.ContainerInput{Image: "python@sha256:" + strings.Repeat("a", 64), Command: []string{"python3", "server.py"}, GrantID: grant.ID, GrantRevision: grant.Revision}})
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := f.extensions.Servers.SaveCatalog(server.ID, server.Revision, f.catalog)
	if err != nil {
		t.Fatal(err)
	}
	env := Environment{Servers: []RevisionRef{{ID: server.ID, Revision: server.Revision, Digest: catalog.Digest}}, Tools: []string{capabilityAlias("mcp", server.ID, "inspect")}}
	if _, err = f.extensions.Snapshot(context.Background(), env); err == nil {
		t.Fatal("stdio 隐式取得未选入环境的网络授权")
	}
	env.Grants = []RevisionRef{{ID: grant.ID, Revision: grant.Revision}}
	snapshot, err := f.extensions.Snapshot(context.Background(), env)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := f.extensions.Prepare(context.Background(), snapshot, Operation{Capability: snapshot.Tools[0], ArgumentsJSON: `{}`})
	if err != nil {
		t.Fatal(err)
	}
	if operation.Execution == nil || operation.Execution.Grant == nil || operation.Execution.Grant.ID != grant.ID || operation.Execution.Grant.Revision != grant.Revision || operation.Execution.Profile.Command[0] != "python3" {
		t.Fatalf("未固定 stdio 执行计划 %+v", operation)
	}
	operation.Execution.Grant.Network[0].Host = "tampered.example.com"
	err = f.extensions.Check(context.Background(), snapshot, operation)
	var known *Error
	if !errors.As(err, &known) || known.Code != "execution-changed" {
		t.Fatalf("审批网络授权篡改未在派发前被识别: %v", err)
	}
}
