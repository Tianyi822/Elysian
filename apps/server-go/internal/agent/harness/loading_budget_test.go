package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func budgetTestSnapshot(t *testing.T, count, size int) CapabilitySnapshot {
	t.Helper()
	s := CapabilitySnapshot{Tools: []Capability{userInputCapability(), planCapability()}}
	for i := 0; i < count; i++ {
		schema, _ := json.Marshal(map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string", "description": strings.Repeat("x", size)}}})
		s.Tools = append(s.Tools, Capability{Name: fmt.Sprintf("mcp_tool_%02d", i), Source: "mcp-tool", Description: "诊断工具", OriginalName: fmt.Sprintf("original_%02d", i), SearchNames: []string{"示例服务", "sample-service"}, Parameters: schema})
	}
	r := Run{Model: &model.Profile{ContextTokens: 131072, OutputTokens: 4096}, Limits: DefaultAgentLimits()}
	if err := finalizeLoading(&s, r, "", Environment{}); err != nil {
		t.Fatal(err)
	}
	return s
}

func TestLoadingBudgetSearchSizeEvictionAndIndex(t *testing.T) {
	s := budgetTestSnapshot(t, 24, 4000)
	previous := []string{}
	for i := 0; i < 24; i++ {
		raw, err := searchToolsWithBudget(s, json.RawMessage(fmt.Sprintf(`{"query":"original_%02d"}`, i)), previous)
		var result toolSearchResult
		if err != nil || json.Unmarshal(raw.Value, &result) != nil {
			t.Fatal(err)
		}
		if len(result.Loaded) != 1 || result.Loaded[0] != fmt.Sprintf("mcp_tool_%02d", i) {
			t.Fatal("精确原名加载失败")
		}
		visible := map[string]bool{}
		for _, name := range result.Retained {
			visible[name] = true
		}
		if len(result.Retained) > 16 || modelDefinitionTokens(s.visibleModelTools(visible)) > s.LoadingBudget.ToolDefinitionTokens {
			t.Fatal("定义预算失效")
		}
		previous = result.Retained
	}
	if contains(previous, "mcp_tool_00") || !contains(previous, "mcp_tool_23") || len(previous) >= 16 {
		t.Fatal("未按大小淘汰旧定义", previous)
	}
	giant := budgetTestSnapshot(t, 1, 40000)
	raw, err := searchToolsWithBudget(giant, json.RawMessage(`{"query":"original_00"}`), nil)
	var result toolSearchResult
	if err != nil || json.Unmarshal(raw.Value, &result) != nil || len(result.Loaded) != 0 || len(result.Skipped) != 1 || len(result.Retained) != 0 {
		t.Fatalf("巨大定义被截断加载: %s %v", raw.Value, err)
	}
	raw, err = searchToolsWithBudget(s, json.RawMessage(`{"query":"示例服务","limit":5}`), nil)
	if err != nil || json.Unmarshal(raw.Value, &result) != nil || len(result.Matches) != 5 || result.Total != 24 {
		t.Fatal("服务名索引或分页失效")
	}
	for i := 0; i < 32; i++ {
		s.SkillSummaries = append(s.SkillSummaries, SkillSummary{Ref: RevisionRef{ID: fmt.Sprintf("skill-%02d", i), Revision: 1}, Name: fmt.Sprintf("技能-%02d", i), Description: strings.Repeat("中", 300)})
	}
	index := s.skillIndex("技能-31")
	if estimateContextText(string(index)) > s.LoadingBudget.SkillIndexTokens {
		t.Fatal("技能索引超限")
	}
	var entries []struct {
		Name        string
		Description string
	}
	if json.Unmarshal(index, &entries) != nil || len(entries) >= 32 || entries[0].Name != "技能-31" {
		t.Fatalf("索引未按相关性裁剪: %s", index)
	}
	for _, entry := range entries {
		if len([]rune(entry.Description)) > 160 {
			t.Fatal("说明未限长")
		}
	}
	if len(s.SkillSummaries) != 32 {
		t.Fatal("裁剪索引修改完整目录")
	}
}

func TestLoadingBudgetCapturedWireComparison(t *testing.T) {
	for _, tc := range []struct {
		name        string
		count, size int
	}{{"small", 4, 80}, {"many", 80, 80}, {"huge", 2, 40000}} {
		t.Run(tc.name, func(t *testing.T) {
			var wires []json.RawMessage
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var wire map[string]json.RawMessage
				if err := json.NewDecoder(r.Body).Decode(&wire); err != nil {
					t.Error(err)
				}
				wires = append(wires, wire["tools"])
				w.Header().Set("Content-Type", "application/json")
				io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"完成"},"finish_reason":"stop"}]}`)
			}))
			defer server.Close()
			profile := model.Profile{Provider: model.ProviderOpenAICompatible, APIFormat: model.FormatChatCompletions, BaseURL: server.URL, Model: "test", ContextTokens: 131072, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "test"}, Active: true, Credential: "test-only"}
			s := budgetTestSnapshot(t, tc.count, tc.size)
			eager := s
			eager.ToolLoading = ""
			send := func(definitions []model.Tool) {
				t.Helper()
				_, err := model.NewClient(server.Client()).Complete(context.Background(), profile, model.Request{Messages: []model.Message{{Role: "user", Content: "诊断"}}, Tools: definitions, MaxTokens: 4096})
				if err != nil {
					t.Fatal(err)
				}
			}
			send(eager.modelTools())
			send(s.visibleModelTools(nil))
			if strings.Contains(string(wires[1]), "original_") || strings.Contains(string(wires[1]), "mcp_tool_") {
				t.Fatal("未加载扩展发送完整定义")
			}
			hits := 0
			rounds := 0
			visible := map[string]bool{}
			for i := 0; i < tc.count; i++ {
				rounds++
				raw, err := searchToolsWithBudget(s, json.RawMessage(fmt.Sprintf(`{"query":"original_%02d"}`, i)), nil)
				if err != nil {
					t.Fatal(err)
				}
				var result toolSearchResult
				_ = json.Unmarshal(raw.Value, &result)
				if len(result.Loaded) == 1 {
					hits++
				}
				if i == 0 {
					for _, name := range result.Retained {
						visible[name] = true
					}
				}
			}
			send(s.visibleModelTools(visible))
			if tc.name == "huge" && hits != 0 || tc.name != "huge" && hits != tc.count {
				t.Fatal("固定精确查询命中率错误")
			}
			if modelDefinitionTokens(s.visibleModelTools(visible)) > s.LoadingBudget.ToolDefinitionTokens {
				t.Fatal("最终请求工具超预算")
			}
			t.Logf("本地估算（非供应商用量）：候选=%d，全量定义=%d bytes/%d tokens，首次按需=%d bytes/%d tokens，首次搜索后=%d bytes/%d tokens；固定精确查询命中=%d/%d，搜索轮次=%d", tc.count, len(wires[0]), estimateContextText(string(wires[0])), len(wires[1]), estimateContextText(string(wires[1])), len(wires[2]), estimateContextText(string(wires[2])), hits, tc.count, rounds)
		})
	}
}

// 用于测试最终可见定义的本地估算，与用量浮层保持相同算法。
func modelDefinitionTokens(tools []model.Tool) int {
	total := 0
	for _, tool := range tools {
		total += definitionTokens(Capability{Name: tool.Name, Description: tool.Description, Parameters: tool.Parameters})
	}
	return total
}

type budgetDiscoveryCatalog struct{ operationCatalog }

func (c *budgetDiscoveryCatalog) Snapshot(ctx context.Context, env Environment) (CapabilitySnapshot, error) {
	s, err := (&discoveryTestCatalog{c.operationCatalog}).Snapshot(ctx, env)
	for i := range s.Tools {
		if strings.HasPrefix(s.Tools[i].Name, "extra_") {
			s.Tools[i].Parameters, _ = json.Marshal(map[string]any{"type": "object", "description": strings.Repeat("x", 12000)})
		}
	}
	return s, err
}

func TestLoadingBudgetEvictedSetSurvivesApprovalRestart(t *testing.T) {
	ctx := context.Background()
	var requests int
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		if r.ToolChoice == "store_working_memory" {
			return memoryReply(r), nil
		}
		requests++
		switch {
		case requests <= 3:
			return searchReply(fmt.Sprintf("extra_%02d", requests-1)), nil
		case requests == 4:
			return searchReply("test_write"), nil
		case requests == 5:
			return toolReply("test_write"), nil
		default:
			names := toolNames(r)
			if contains(names, "extra_00") || !contains(names, "extra_02") || !contains(names, "test_write") {
				t.Errorf("重启重新拼接了淘汰定义: %v", names)
			}
			return finalReply("ok"), nil
		}
	}, func(d *Deps) { d.Catalog = &budgetDiscoveryCatalog{operationCatalog{}} })
	run := submitAgentTest(t, m, session, "budget-restart", "执行操作")
	t.Cleanup(func() {
		if t.Failed() {
			current, _ := m.store.get(ctx, run.ID)
			t.Logf("requests=%d state=%s error=%+v usage=%+v", requests, current.Status, current.Error, current.Usage)
		}
	})
	approval := waitingApproval(t, m, run.ID)
	before, err := m.loadedToolsV2(ctx, run.ID, *run.Snapshot)
	if err != nil || contains(before, "extra_00") || !contains(before, "extra_02") || len(before) >= 4 {
		t.Fatalf("没有按大小淘汰: %v %v", before, err)
	}
	runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.activeID == "" })
	m = reopenOperationManager(t, m)
	after, err := m.loadedToolsV2(ctx, run.ID, *run.Snapshot)
	if err != nil || digestJSON(before) != digestJSON(after) {
		t.Fatalf("恢复加载集合改变: %v %v", after, err)
	}
	if _, err = m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	if done := runtimeFinished(t, m, run.ID); done.Status != StateSucceeded {
		t.Fatalf("恢复失败: %+v", done.Error)
	}
}

func TestLoadingBudgetMCPTrustRequiresOriginalDigest(t *testing.T) {
	capability := Capability{Name: "mcp_read", Source: "mcp-tool", Ref: RevisionRef{ID: "service", Revision: 2}, CatalogDigest: "catalog"}
	env := Environment{Servers: []RevisionRef{{ID: "service", Revision: 2}}, TrustedReadOnly: []string{capability.Name}}
	if exactMCPTrust(env, capability) {
		t.Fatal("旧环境没有摘要时推断了信任")
	}
	env.Servers[0].Digest = "catalog"
	if !exactMCPTrust(env, capability) {
		t.Fatal("精确绑定没有采用")
	}
	env.Servers[0].Revision = 1
	if exactMCPTrust(env, capability) {
		t.Fatal("跨修订继承信任")
	}
	env.Servers[0].Revision = 2
	env.Servers[0].Digest = "changed"
	if exactMCPTrust(env, capability) {
		t.Fatal("跨目录继承信任")
	}
}
