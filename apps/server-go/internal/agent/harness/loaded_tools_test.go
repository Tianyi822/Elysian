package harness

import (
	"encoding/json"
	"reflect"
	"testing"
)

func retainedToolsCall(t *testing.T, s CapabilitySnapshot, names ...string) Call {
	t.Helper()
	result, err := json.Marshal(toolSearchResult{Version: onDemandToolsV2, SnapshotDigest: s.Digest, Retained: append([]string{}, names...)})
	if err != nil {
		t.Fatal(err)
	}
	return Call{Tool: toolSearchName, Result: result}
}

func TestLoadedToolsProjectionKeepsDefinitionOrderAcrossEvictionAndReload(t *testing.T) {
	s := budgetTestSnapshot(t, 3, 80)
	a, b, c := "mcp_tool_00", "mcp_tool_01", "mcp_tool_02"
	var calls []Call
	for _, step := range []struct {
		retained, order []string
	}{
		{[]string{a}, []string{a}},
		{[]string{b, a}, []string{a, b}},
		{[]string{c, b}, []string{b, c}},
		{[]string{a, c, b}, []string{b, c, a}},
		{[]string{b, a, c}, []string{b, c, a}},
		{[]string{}, []string{}},
	} {
		calls = append(calls, retainedToolsCall(t, s, step.retained...))
		state := projectLoadedTools(s, calls)
		if !reflect.DeepEqual(state.Retained, step.retained) || !reflect.DeepEqual(state.Order, step.order) {
			t.Fatalf("保留集合 %v 的加载状态不符：%+v，预期顺序 %v", step.retained, state, step.order)
		}
	}
}

func TestLoadedToolsProjectionIgnoresInvalidPersistedReceiptsForBothViews(t *testing.T) {
	s := budgetTestSnapshot(t, 3, 80)
	a, b := "mcp_tool_00", "mcp_tool_01"
	s.EagerTools = []string{b}
	baseline := retainedToolsCall(t, s, a)
	want := projectLoadedTools(s, []Call{baseline})
	for _, tc := range []struct {
		name   string
		change func(*Call)
	}{
		{"其他工具", func(c *Call) { c.Tool = "mcp_search" }},
		{"截断", func(c *Call) { c.Truncated = true }},
		{"失败", func(c *Call) { c.Error = &Failure{Code: "failed"} }},
		{"损坏 JSON", func(c *Call) { c.Result = json.RawMessage(`{`) }},
		{"其他快照", func(c *Call) {
			var result toolSearchResult
			_ = json.Unmarshal(c.Result, &result)
			result.SnapshotDigest = "other-snapshot"
			c.Result, _ = json.Marshal(result)
		}},
		{"旧回执", func(c *Call) {
			var result toolSearchResult
			_ = json.Unmarshal(c.Result, &result)
			result.Version = onDemandTools
			c.Result, _ = json.Marshal(result)
		}},
		{"未知定义", func(c *Call) { *c = retainedToolsCall(t, s, "not_in_snapshot") }},
		{"重复定义", func(c *Call) { *c = retainedToolsCall(t, s, a, a) }},
		{"常驻定义", func(c *Call) { *c = retainedToolsCall(t, s, toolSearchName) }},
		{"eager 定义", func(c *Call) { *c = retainedToolsCall(t, s, b) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			invalid := retainedToolsCall(t, s, "mcp_tool_02", a)
			tc.change(&invalid)
			if got := projectLoadedTools(s, []Call{baseline, invalid}); !reflect.DeepEqual(got, want) {
				t.Fatalf("无效回执改变了可见集合或加载顺序：%+v，预期 %+v", got, want)
			}
		})
	}
	limited := s
	budget := *s.LoadingBudget
	budget.ToolDefinitionTokens = s.residentDefinitionTokens() + definitionTokens(s.Tools[2])
	limited.LoadingBudget = &budget
	if got := projectLoadedTools(limited, []Call{baseline, retainedToolsCall(t, s, "mcp_tool_02", a)}); !reflect.DeepEqual(got, want) {
		t.Fatalf("超预算回执改变了可见集合或加载顺序：%+v", got)
	}
}
