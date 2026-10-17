package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

type discoveryTestCatalog struct{ operationCatalog }

func (c *discoveryTestCatalog) Snapshot(ctx context.Context, env Environment) (CapabilitySnapshot, error) {
	snapshot, err := c.operationCatalog.Snapshot(ctx, env)
	for i := 0; i < 20; i++ {
		snapshot.Tools = append(snapshot.Tools, Capability{Name: fmt.Sprintf("extra_%02d", i), Source: "mcp-tool", Description: "额外扩展查询", ReadOnly: true, Parameters: json.RawMessage(`{"type":"object"}`)})
	}
	return snapshot, err
}

func searchReply(query string) model.Response {
	response := toolReply(toolSearchName)
	response.ToolCalls[0].Arguments, _ = json.Marshal(map[string]string{"query": query})
	return response
}

func toolNames(request model.Request) []string {
	names := make([]string, 0, len(request.Tools))
	for _, tool := range request.Tools {
		names = append(names, tool.Name)
	}
	return names
}

func TestToolDiscoverySearchLoadsOnlyBoundedAuthorizedMatches(t *testing.T) {
	snapshot, _ := (&discoveryTestCatalog{}).Snapshot(context.Background(), Environment{})
	snapshot.Digest = "fixed-snapshot"
	snapshot.Tools = append(snapshot.Tools, toolSearchCapability(), Capability{Name: "database_list", Description: "读取数据库列表", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Domain: "database"}}, Capability{Name: "docker_containers_list", Description: "列出 Docker 容器", Source: "builtin", ReadOnly: true, Metadata: tools.Metadata{Domain: "docker"}})
	for _, test := range []struct {
		query string
		want  string
	}{
		{"test_read", "test_read"},
		{"请查看数据库列表", "database_list"},
		{"容器列表", "docker_containers_list"},
	} {
		raw, _ := json.Marshal(map[string]string{"query": test.query})
		response, err := searchTools(snapshot, raw)
		var result toolSearchResult
		if err != nil || json.Unmarshal(response.Value, &result) != nil || len(result.Matches) == 0 || result.Matches[0].Name != test.want {
			t.Fatalf("query=%s result=%s err=%v", test.query, response.Value, err)
		}
	}
	first, err := searchTools(snapshot, json.RawMessage(`{"query":"extra","limit":5}`))
	var page toolSearchResult
	if err != nil || json.Unmarshal(first.Value, &page) != nil || len(page.Matches) != 5 || page.Total != 20 || page.NextOffset == nil || *page.NextOffset != 5 {
		t.Fatalf("unbounded search: %s %v", first.Value, err)
	}
	if page.Note != "" {
		t.Fatalf("还有下一页时不得给停止提示：%s", first.Value)
	}
	second, _ := searchTools(snapshot, json.RawMessage(`{"query":"extra","limit":5,"offset":5}`))
	var next toolSearchResult
	_ = json.Unmarshal(second.Value, &next)
	if len(next.Matches) != 5 || page.Matches[0].Name == next.Matches[0].Name || strings.Contains(string(first.Value), "parameters") {
		t.Fatalf("search leaked definitions or repeated its page: %s", second.Value)
	}
	last, _ := searchTools(snapshot, json.RawMessage(`{"query":"extra","limit":5,"offset":15}`))
	var lastPage toolSearchResult
	_ = json.Unmarshal(last.Value, &lastPage)
	if lastPage.NextOffset != nil || !strings.Contains(lastPage.Note, "全部 20 项匹配") || !strings.Contains(lastPage.Note, "不要换关键词反复搜索") {
		t.Fatalf("穷尽页缺少停止提示：%s", last.Value)
	}
	empty, err := searchTools(snapshot, json.RawMessage(`{"query":"not_authorized_anywhere"}`))
	var noMatch toolSearchResult
	if err != nil || json.Unmarshal(empty.Value, &noMatch) != nil || len(noMatch.Matches) != 0 || noMatch.Total != 0 || !strings.Contains(noMatch.Note, "没有任何匹配") {
		t.Fatalf("no match exposed catalog: %s %v", empty.Value, err)
	}
	for _, raw := range []string{`{}`, `{"query":"  "}`, `{"query":"x","query":"y"}`, `{"query":"x","limit":0}`, `{"query":"x","limit":6}`, `{"query":"x","offset":-1}`, `{"query":"x","offset":1.5}`, `{"query":"x","names":["test_write"]}`} {
		if _, err := searchTools(snapshot, json.RawMessage(raw)); err == nil {
			t.Fatalf("accepted invalid search: %s", raw)
		}
	}
}

func TestToolDiscoveryApprovalRestartRestoresVisibilityWithoutReplay(t *testing.T) {
	var inference, writes atomic.Int32
	cat := &discoveryTestCatalog{operationCatalog{execute: func(_ context.Context, o Operation) (CapabilityResult, error) {
		if o.Capability.Name != "test_write" {
			t.Errorf("unexpected backend call: %s", o.Capability.Name)
		}
		writes.Add(1)
		return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
	}}}
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		names := toolNames(request)
		switch inference.Add(1) {
		case 1, 4:
			if len(names) != 3 || !contains(names, toolSearchName) || !contains(names, userInputTool) || !contains(names, planTool) {
				t.Errorf("initial request injected full catalog: %v", names)
			}
			if inference.Load() == 4 {
				return finalReply("新任务未继承旧加载集"), nil
			}
			return searchReply("test_write"), nil
		case 2:
			if len(names) != 4 || !contains(names, "test_write") {
				t.Errorf("search did not load exact tool: %v", names)
			}
			return toolReply("test_write"), nil
		default:
			if len(names) != 4 || !contains(names, "test_write") {
				t.Errorf("restart lost loaded tools: %v", names)
			}
			return finalReply("操作完成"), nil
		}
	}, func(d *Deps) { d.Catalog = cat })
	run := submitAgentTest(t, m, session, "discover-approval", "执行已授权操作")
	approval := waitingApproval(t, m, run.ID)
	if writes.Load() != 0 || approval.Operation.Capability.Name != "test_write" {
		t.Fatalf("search bypassed approval: %+v writes=%d", approval, writes.Load())
	}
	runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.activeID == "" })
	m = reopenOperationManager(t, m)
	if _, err := m.Decide(context.Background(), approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, run.ID)
	if got.Status != StateSucceeded || writes.Load() != 1 || inference.Load() != 3 {
		t.Fatalf("discovery/approval resume failed: %+v writes=%d inferences=%d", got, writes.Load(), inference.Load())
	}
	calls, err := m.store.calls(context.Background(), run.ID, "", 50)
	if err != nil || len(calls.Items) != 2 || calls.Items[0].Tool != toolSearchName || calls.Items[1].Tool != "test_write" {
		t.Fatalf("search was replayed or not audited: %+v %v", calls, err)
	}
	records, err := m.ModelRequests(context.Background(), run.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range records.Items {
		if record.Purpose == "inference" && !contains(record.ToolNames, toolSearchName) {
			t.Fatalf("visible tool set not persisted: %+v", record)
		}
	}
	next := submitAgentTest(t, m, session, "discover-new-run", "直接回答")
	if got := runtimeFinished(t, m, next.ID); got.Status != StateSucceeded || inference.Load() != 4 {
		t.Fatalf("new run failed: %+v", got)
	}
}

func TestToolDiscoveryRejectsHiddenCallsBeforeDispatch(t *testing.T) {
	for _, together := range []bool{false, true} {
		t.Run(fmt.Sprint(together), func(t *testing.T) {
			var calls atomic.Int32
			cat := &discoveryTestCatalog{operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
				calls.Add(1)
				return CapabilityResult{}, nil
			}}}
			m, session, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
				if !together {
					return toolReply("test_read"), nil
				}
				response := searchReply("test_read")
				response.ToolCalls = append(response.ToolCalls, model.ToolCall{ID: "hidden", Name: "test_read", Arguments: json.RawMessage(`{}`)})
				return response, nil
			}, func(d *Deps) { d.Catalog = cat })
			run := submitAgentTest(t, m, session, "hidden-call", "读取")
			got := runtimeFinished(t, m, run.ID)
			if got.Status != StateFailed || got.EndReason != "tool-not-loaded" || calls.Load() != 0 {
				t.Fatalf("hidden tool accepted: %+v calls=%d", got, calls.Load())
			}
			operations, _ := m.Operations(context.Background(), run.ID)
			if len(operations) != 0 {
				t.Fatalf("partial batch executed before visibility check: %+v", operations)
			}
		})
	}
}

func TestToolDiscoveryRestoresOnlyConfirmedCurrentRunLoadsAndCapsDefinitions(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		return finalReply("只建立临时测试运行"), nil
	}, func(d *Deps) { d.Catalog = &discoveryTestCatalog{} })
	run := submitAgentTest(t, m, session, "restore-tools", "无需调用")
	run = runtimeFinished(t, m, run.ID)
	a := &agentExecution{manager: m, run: run}
	ctx := context.Background()
	writeLoad := func(index int, names []string, change func(*Call, *Operation, *toolSearchResult)) {
		t.Helper()
		result := toolSearchResult{Version: onDemandTools, SnapshotDigest: run.Snapshot.Digest}
		for _, name := range names {
			result.Matches = append(result.Matches, toolSearchMatch{Name: name})
		}
		op := Operation{ID: fmt.Sprintf("discovery-op-%d", index), RunID: run.ID, TaskID: run.TaskID, CallIndex: index, Status: "completed", SnapshotDigest: run.Snapshot.Digest, Capability: toolSearchCapability()}
		call := Call{ID: fmt.Sprintf("discovery-call-%d", index), RunID: run.ID, OperationID: op.ID, StepIndex: index, Tool: toolSearchName, Status: StateSucceeded}
		if change != nil {
			change(&call, &op, &result)
		}
		call.Result, _ = json.Marshal(result)
		if err := m.store.write(ctx, "discovery-test", func(tx *sql.Tx) error {
			if err := saveOperation(ctx, tx, op); err != nil {
				return err
			}
			return saveCall(ctx, tx, call)
		}); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 20; i++ {
		writeLoad(i, []string{fmt.Sprintf("extra_%02d", i)}, nil)
	}
	// Untrusted, failed, truncated or foreign-snapshot results never unlock tools.
	writeLoad(20, []string{"test_read"}, func(c *Call, _ *Operation, _ *toolSearchResult) { c.Status = StateFailed })
	writeLoad(21, []string{"test_read"}, func(c *Call, _ *Operation, _ *toolSearchResult) { c.Truncated = true })
	writeLoad(22, []string{"test_read"}, func(_ *Call, o *Operation, _ *toolSearchResult) { o.Capability.Source = "mcp-tool" })
	writeLoad(23, []string{"test_read"}, func(_ *Call, _ *Operation, r *toolSearchResult) { r.SnapshotDigest = "foreign" })
	writeLoad(24, []string{"not_in_snapshot"}, nil)
	loaded, err := a.loadedToolNames(ctx)
	if err != nil || len(loaded) != maxLoadedTools || loaded["test_read"] || loaded["extra_00"] || !loaded["extra_19"] {
		t.Fatalf("restored unconfirmed or unbounded tools: %v %v", loaded, err)
	}
	visible, err := a.tools(ctx)
	if err != nil || len(visible) != maxLoadedTools+3 {
		t.Fatalf("definition cap failed: %v %v", toolNames(model.Request{Tools: visible}), err)
	}
	// A successful new search can reload a definition evicted by newer searches.
	writeLoad(25, []string{"extra_00"}, nil)
	loaded, err = a.loadedToolNames(ctx)
	if err != nil || !loaded["extra_00"] || loaded["extra_04"] || len(loaded) != maxLoadedTools {
		t.Fatalf("reload did not refresh visibility: %v %v", loaded, err)
	}
	otherRun := *a
	otherRun.run.ID = "different-run"
	loaded, err = otherRun.loadedToolNames(ctx)
	if err != nil || len(loaded) != 0 {
		t.Fatalf("loaded names crossed run boundary: %v %v", loaded, err)
	}
	legacy := *run.Snapshot
	legacy.ToolLoading = ""
	if len(legacy.modelTools()) != len(legacy.Tools) {
		t.Fatal("legacy snapshot no longer exposes its fixed eager definitions")
	}
}

func TestToolDiscoveryDoesNotGrantWriteScopeOrTrustExternalTools(t *testing.T) {
	search := toolSearchCapability()
	if direct, _ := operationDecision(CapabilitySnapshot{}, Operation{Capability: search}); !direct || externalOperation(Operation{Capability: search}) {
		t.Fatal("internal discovery became an external or approval-gated operation")
	}
	claims, _ := operationResourceClaims(CapabilitySnapshot{}, Operation{Capability: search, ArgumentsJSON: `{"query":"database"}`})
	for _, claim := range claims {
		if claim.Kind == "global" {
			t.Fatal("immutable catalog search took the global infrastructure lock")
		}
	}
	write := Capability{Name: "database_remove", Source: "builtin", Metadata: tools.Metadata{Exposure: "agent", ResourceType: "database", ResourceKeyArgument: "id"}}
	snapshot := CapabilitySnapshot{ToolLoading: onDemandTools, PermissionMode: PermissionFull, Tools: []Capability{search, write}}
	if err := authorizeOperationScope(snapshot, Operation{Capability: write, ArgumentsJSON: `{"id":"ungranted"}`}); err == nil {
		t.Fatal("discovered tool enlarged its resource grant")
	}
	if direct, _ := operationDecision(snapshot, Operation{Capability: Capability{Name: "external", Source: "mcp-tool", ReadOnly: true}}); direct {
		t.Fatal("discovery trusted an external read without explicit opt-in")
	}
}

type discoveryMaterialsCatalog struct{ discoveryTestCatalog }

func (c *discoveryMaterialsCatalog) Snapshot(ctx context.Context, env Environment) (CapabilitySnapshot, error) {
	snapshot, err := c.discoveryTestCatalog.Snapshot(ctx, env)
	snapshot.Tools = append(snapshot.Tools,
		Capability{Name: "selected_skill", Source: "skill-load", Ref: RevisionRef{ID: "skill-one", Revision: 1}, ReadOnly: true, Parameters: json.RawMessage(`{"type":"object"}`)},
		Capability{Name: "selected_resource", Source: "mcp-resource", Ref: RevisionRef{ID: "server-one", Revision: 1}, OriginalName: "resource://selected", ReadOnly: true, Parameters: json.RawMessage(`{"type":"object"}`)},
	)
	snapshot.Materials = []Capability{{Name: "selected_prompt", Source: "mcp-prompt", Ref: RevisionRef{ID: "server-one", Revision: 1}, OriginalName: "selected", ReadOnly: true, Parameters: json.RawMessage(`{"type":"object"}`)}}
	return snapshot, err
}

func TestToolDiscoveryPreservesExplicitSelectedMaterials(t *testing.T) {
	var reads atomic.Int32
	cat := &discoveryMaterialsCatalog{discoveryTestCatalog{operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		reads.Add(1)
		return CapabilityResult{Value: json.RawMessage(`{"text":"显式选取的资料"}`)}, nil
	}}}}
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if reads.Load() != 3 {
			t.Errorf("inference started before explicit material loading: %d", reads.Load())
		}
		names := toolNames(request)
		if len(names) != 3 || !contains(names, toolSearchName) || !contains(names, userInputTool) || !contains(names, planTool) {
			t.Errorf("selected materials implicitly loaded callable schemas: %v", names)
		}
		return finalReply("读取完毕"), nil
	}, func(d *Deps) { d.Catalog = cat })
	ctx := context.Background()
	env, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	env.Skills = []RevisionRef{{ID: "skill-one", Revision: 1}}
	env.Servers = []RevisionRef{{ID: "server-one", Revision: 1}}
	env.Resources = []ResourceRef{{ServerID: "server-one", URI: "resource://selected"}}
	env.TrustedReadOnly = []string{"selected_resource", "selected_prompt"}
	if _, err = m.PutEnvironment(ctx, session.ID, env.Revision, env); err != nil {
		t.Fatal(err)
	}
	run, _, err := m.CreateTask(ctx, session.ID, AgentInput{RequestID: "selected-discovery", Content: "读取选定资料", Skills: env.Skills, Resources: env.Resources, Prompts: []PromptRef{{ServerID: "server-one", Name: "selected", Arguments: json.RawMessage(`{}`)}}})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded || reads.Load() != 3 {
		t.Fatalf("explicit materials were blocked by discovery: %+v reads=%d", got, reads.Load())
	}
}
