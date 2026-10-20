package harness

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

// allRequestText 汇总请求全部消息正文；缓存友好性断言按整段提示词而不是固定下标查找。
func allRequestText(request model.Request) string {
	var builder strings.Builder
	for _, message := range request.Messages {
		builder.WriteString(message.Content)
		builder.WriteString("\n")
	}
	return builder.String()
}

// isCurrentStateMessage 判定尾部“当前状态”消息：本轮输入与最新计划会随轮内进度变化，
// 不参与前缀复用断言；它之前的消息必须保持逐字节稳定。
func isCurrentStateMessage(message model.Message) bool {
	return message.Role == "user" && (strings.Contains(message.Content, "本轮当前状态（服务端") || strings.Contains(message.Content, "本轮最新任务计划（已保存的数据"))
}

// requireMessagePrefix 断言 prefix 是 messages 的逐条前缀；比较协议可序列化字段，
// 不比较本地估算元数据。
func requireMessagePrefix(t *testing.T, prefix, messages []model.Message) {
	t.Helper()
	if len(prefix) > len(messages) {
		t.Fatalf("消息数量回退：prefix=%d messages=%d", len(prefix), len(messages))
	}
	for index := range prefix {
		want, _ := json.Marshal(prefix[index])
		got, _ := json.Marshal(messages[index])
		if string(want) != string(got) {
			t.Fatalf("第 %d 条消息前缀变化：want=%s got=%s", index, want, got)
		}
	}
}

// requireRequestPrefix 去掉上一次请求的尾部当前状态后，断言其余消息是下一次请求的前缀。
func requireRequestPrefix(t *testing.T, previous, current model.Request) {
	t.Helper()
	prefix := previous.Messages
	if len(prefix) > 0 && isCurrentStateMessage(prefix[len(prefix)-1]) {
		prefix = prefix[:len(prefix)-1]
	}
	requireMessagePrefix(t, prefix, current.Messages)
}

// toolNamesOf 按顺序收集定义名称，用于断言稳定前缀与尾部追加。
func toolNamesOf(tools []model.Tool) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		names = append(names, tool.Name)
	}
	return names
}

// requireToolNamesPrefix 断言工具定义按顺序保留旧前缀，新加载定义只出现在尾部。
func requireToolNamesPrefix(t *testing.T, previous, current []model.Tool) {
	t.Helper()
	if len(current) < len(previous) {
		t.Fatalf("工具定义数量回退：previous=%d current=%d", len(previous), len(current))
	}
	for index := range previous {
		want, _ := json.Marshal(previous[index])
		got, _ := json.Marshal(current[index])
		if string(want) != string(got) {
			t.Fatalf("第 %d 个工具定义前缀变化：want=%s got=%s", index, want, got)
		}
	}
}

// 同一 Run 内 update_plan 更新只改尾部当前状态消息：system、工具定义、技能正文与既有事实组
// 仍构成稳定前缀，后续每次推理都复用同一段前缀。
func TestAgentPlanUpdatesKeepStableRequestPrefix(t *testing.T) {
	var inferences atomic.Int32
	var mu sync.Mutex
	var requests []model.Request
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		mu.Lock()
		requests = append(requests, request)
		mu.Unlock()
		switch inferences.Add(1) {
		case 1:
			return planReply(planFixture), nil
		case 2:
			return planReply(planUpdated), nil
		case 3:
			return toolReply("docker_images_list"), nil
		default:
			return finalReply("已检查并验证"), nil
		}
	}, nil)
	run := submitAgentTest(t, m, session, "cache-plan-prefix", "检查配置并验证结果")
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
		t.Fatalf("运行失败：%+v", got)
	}
	mu.Lock()
	captured := append([]model.Request(nil), requests...)
	mu.Unlock()
	if len(captured) != 4 {
		t.Fatalf("推理请求数量=%d", len(captured))
	}
	for index := 1; index < len(captured); index++ {
		if captured[index].Messages[0].Content != captured[0].Messages[0].Content {
			t.Fatalf("第 %d 次推理的 system 发生变化", index)
		}
		if !reflect.DeepEqual(toolNames(captured[index]), toolNames(captured[0])) {
			t.Fatalf("第 %d 次推理的工具集合发生变化：%v", index, toolNames(captured[index]))
		}
		if captured[index].Messages[1].Content != captured[0].Messages[1].Content {
			t.Fatalf("第 %d 次推理的稳定头部发生变化", index)
		}
		if strings.Contains(captured[index].Messages[1].Content, "本轮最新任务计划") {
			t.Fatalf("任务计划仍位于头部：%s", captured[index].Messages[1].Content)
		}
		requireRequestPrefix(t, captured[index-1], captured[index])
	}
	if strings.Contains(allRequestText(captured[0]), "本轮最新任务计划") {
		t.Fatal("首次推理尚未产生计划，却已注入计划")
	}
	for _, test := range []struct {
		index    int
		revision string
	}{{1, "revision\":1"}, {2, "revision\":2"}} {
		last := captured[test.index].Messages[len(captured[test.index].Messages)-1]
		if last.Role != "user" || !strings.Contains(last.Content, "本轮最新任务计划") || !strings.Contains(last.Content, test.revision) {
			t.Fatalf("第 %d 次推理的尾部计划不符合预期：%s", test.index, last.Content)
		}
	}
}

// tool_search 新加载定义只追加到工具列表尾部：已加载定义与更早的 system、头部保持稳定，
// 工具集合变化不再打断整段工具前缀。
func TestAgentToolDiscoveryAppendsDefinitionsToStableToolPrefix(t *testing.T) {
	var inferences atomic.Int32
	var mu sync.Mutex
	var requests []model.Request
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		mu.Lock()
		requests = append(requests, request)
		mu.Unlock()
		switch inferences.Add(1) {
		case 1:
			return searchReply("test_read"), nil
		case 2:
			return searchReply("extra_00"), nil
		default:
			return finalReply("已按需加载"), nil
		}
	}, func(deps *Deps) { deps.Catalog = &discoveryTestCatalog{} })
	run := submitAgentTest(t, m, session, "cache-tool-append", "读取测试状态")
	if got := runtimeFinished(t, m, run.ID); got.Status != StateSucceeded {
		t.Fatalf("运行失败：%+v", got)
	}
	mu.Lock()
	captured := append([]model.Request(nil), requests...)
	mu.Unlock()
	if len(captured) != 3 {
		t.Fatalf("推理请求数量=%d", len(captured))
	}
	if len(captured[0].Tools) != 7 || !contains(toolNames(captured[0]), toolSearchName) {
		t.Fatalf("首次推理工具定义=%v", toolNames(captured[0]))
	}
	if names := toolNames(captured[1]); len(names) != 8 || names[7] != "test_read" {
		t.Fatalf("首个动态定义未追加在尾部：%v", names)
	}
	if names := toolNames(captured[2]); len(names) != 9 || names[8] != "extra_00" {
		t.Fatalf("后续动态定义未追加在尾部：%v", names)
	}
	for index := 1; index < len(captured); index++ {
		requireToolNamesPrefix(t, captured[index-1].Tools, captured[index].Tools)
		if captured[index].Messages[0].Content != captured[0].Messages[0].Content {
			t.Fatalf("第 %d 次推理的 system 随工具加载变化", index)
		}
		if captured[index].Messages[1].Content != captured[0].Messages[1].Content {
			t.Fatalf("第 %d 次推理的稳定头部随工具加载变化", index)
		}
		requireRequestPrefix(t, captured[index-1], captured[index])
	}
}

// 跨轮续聊：最终整理失败（memory stale）时工作记忆不变，system、工具定义与完整头部可跨 Run
// 复用；本轮输入只出现在尾部当前状态消息，不再打断头部之后的前缀。
func TestAgentContinuationKeepsStableSystemHeaderAndTailInput(t *testing.T) {
	var mu sync.Mutex
	var requests []model.Request
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return model.Response{}, errors.New("整理服务不可用")
		}
		mu.Lock()
		requests = append(requests, request)
		mu.Unlock()
		return finalReply("公开答复"), nil
	}, nil)
	first := submitAgentTest(t, m, session, "cache-continuation-first", "记录共享背景")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded || got.MemoryStatus != "stale" {
		t.Fatalf("首轮状态不符合 fixture：%+v", got)
	}
	second, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "cache-continuation-second", Content: "继续分析缓存"})
	if err != nil {
		t.Fatal(err)
	}
	if got := runtimeFinished(t, m, second.ID); got.Status != StateSucceeded {
		t.Fatalf("续轮失败：%+v", got)
	}
	mu.Lock()
	captured := append([]model.Request(nil), requests...)
	mu.Unlock()
	if len(captured) != 2 {
		t.Fatalf("推理请求数量=%d", len(captured))
	}
	if captured[0].Messages[0].Content != captured[1].Messages[0].Content {
		t.Fatal("跨轮 system 前缀发生变化")
	}
	if !reflect.DeepEqual(toolNames(captured[0]), toolNames(captured[1])) {
		t.Fatalf("跨轮工具定义发生变化：%v -> %v", toolNames(captured[0]), toolNames(captured[1]))
	}
	if captured[0].Messages[1].Content != captured[1].Messages[1].Content {
		t.Fatal("跨轮稳定头部发生变化")
	}
	if strings.Contains(captured[1].Messages[1].Content, "本轮用户输入") {
		t.Fatal("本轮输入仍位于头部")
	}
	last := captured[1].Messages[len(captured[1].Messages)-1]
	if last.Role != "user" || !strings.Contains(last.Content, "继续分析缓存") {
		t.Fatalf("本轮输入未移到尾部当前状态：%+v", last)
	}
	// 跨轮历史会被记忆覆盖改写（首轮当前输入在续轮转为“原始目标已列于任务头部”），
	// 因此可复用边界是 system 与稳定头部，而不是逐条消息前缀。
	requireMessagePrefix(t, captured[0].Messages[:2], captured[1].Messages)
}

// 可见定义排序：常驻与 eager 定义保持目录顺序，动态定义按加载顺序追加在尾部；
// 新增定义只改尾部，没有加载顺序记录时按目录顺序兜底。
func TestVisibleModelToolsKeepStablePrefixAndLoadOrder(t *testing.T) {
	snapshot := CapabilitySnapshot{ToolLoading: onDemandToolsV2, EagerTools: []string{"eager_a", "eager_b"}, Tools: []Capability{
		{Name: "mcp_a", Source: "mcp-tool"}, {Name: "eager_a", Source: "builtin"},
		{Name: "mcp_b", Source: "mcp-tool"}, {Name: "eager_b", Source: "builtin"},
		userInputCapability(), planCapability(), toolSearchCapability(),
	}}
	loaded := map[string]bool{"mcp_a": true}
	first := snapshot.visibleModelToolsInOrder(loaded, []string{"mcp_a"})
	loaded["mcp_b"] = true
	second := snapshot.visibleModelToolsInOrder(loaded, []string{"mcp_a", "mcp_b"})
	if len(first) != 6 || len(second) != 7 {
		t.Fatalf("可见定义数量异常：%v / %v", toolNamesOf(first), toolNamesOf(second))
	}
	requireToolNamesPrefix(t, first, second)
	if toolNamesOf(second)[6] != "mcp_b" {
		t.Fatalf("动态定义未追加在尾部：%v", toolNamesOf(second))
	}
	fallback := snapshot.visibleModelTools(loaded)
	if !reflect.DeepEqual(toolNamesOf(fallback), toolNamesOf(second)) {
		t.Fatalf("无加载顺序时兜底排序不稳定：%v vs %v", toolNamesOf(fallback), toolNamesOf(second))
	}
	hidden := map[string]bool{}
	for _, tool := range snapshot.visibleModelTools(hidden) {
		if tool.Name == "mcp_a" || tool.Name == "mcp_b" {
			t.Fatalf("未加载定义泄漏：%s", tool.Name)
		}
	}
}

// 压缩回退路径直接返回压缩前已验证的请求对象：内容、引用、记忆修订与资料订阅一致，
// 供应商自动前缀缓存仍按压缩前的提示词前缀命中，不会因回退被重建改写。
func TestContextFallbackReusesExactPreCompactionRequest(t *testing.T) {
	saved := model.Request{Messages: []model.Message{{Role: "user", Content: "压缩前请求"}, {Role: "assistant", Content: "已完成"}}, Tools: []model.Tool{{Name: "docker_images_list"}}, MaxTokens: 512}
	fallback := &contextFallback{
		request: saved, refs: []EvidenceRef{{RunID: "run", EventSeq: "7"}}, revision: 3,
		wikiRefs: []WikiRef{{PageID: "page", Revision: 1}}, contextItemIDs: []string{"item"},
	}
	a := &agentExecution{inferenceWikiRefs: []WikiRef{{PageID: "other", Revision: 2}}}
	request, refs, revision, err := a.restoreContextFallback(fallback)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(request, saved) || revision != 3 || !reflect.DeepEqual(refs, fallback.refs) {
		t.Fatalf("回退请求被重建：request=%+v refs=%v revision=%d", request, refs, revision)
	}
	if !reflect.DeepEqual(a.inferenceWikiRefs, fallback.wikiRefs) || !reflect.DeepEqual(a.contextItemIDs, fallback.contextItemIDs) {
		t.Fatalf("回退未恢复资料引用：%v %v", a.inferenceWikiRefs, a.contextItemIDs)
	}
}
