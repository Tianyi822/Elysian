package harness

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestContextUsageTextEstimate(t *testing.T) {
	for _, tc := range []struct {
		text string
		want int
	}{{"", 0}, {"abcd", 1}, {"abcde", 2}, {"中文", 2}, {"abcd中文", 3}, {"😀", 1}} {
		if got := estimateContextText(tc.text); got != tc.want {
			t.Errorf("text=%q got=%d want=%d", tc.text, got, tc.want)
		}
	}
}

func TestContextUsageSixDisjointSourcesAndVisibleTools(t *testing.T) {
	request := model.Request{Messages: []model.Message{
		{Role: "system", Content: "系统"},
		{Role: "user", Content: "abcd"},
		skillContextMessage("user", "来源", "技能"),
		otherContextMessage("user", "记忆"),
	}, Tools: []model.Tool{
		{Name: "host", Description: "read", Parameters: json.RawMessage(`{}`)},
		{Name: "load", Description: "skill", Parameters: json.RawMessage(`{}`)},
		{Name: "mcp", Description: "read", Parameters: json.RawMessage(`{}`)},
	}}
	snapshot := &CapabilitySnapshot{Tools: []Capability{
		{Name: "host", Source: "builtin"}, {Name: "load", Source: "skill-load"}, {Name: "mcp", Source: "mcp-tool"},
		{Name: "hidden", Source: "mcp-tool", Description: strings.Repeat("不应计入", 100)},
	}}
	got := estimateFittedContext(request, snapshot)
	want := &model.ContextBreakdown{Messages: 1, SystemTools: 7, Other: 46, Skills: 2, SystemPrompt: 2, MCPTools: 3}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("分类发生重叠或隐藏工具被计入：got=%+v want=%+v", got, want)
	}
	raw, err := json.Marshal(got)
	var wire map[string]int
	if err != nil || json.Unmarshal(raw, &wire) != nil || len(wire) != 6 {
		t.Fatalf("六个数字字段不完整：%s %v", raw, err)
	}
	for key, value := range wire {
		if value < 0 {
			t.Errorf("negative category %s=%d", key, value)
		}
	}
}

func TestContextUsageHeaderSeparatesLabelsMemoryAndSkills(t *testing.T) {
	a := &agentExecution{run: Run{Task: &Task{Goal: "目标"}, Input: "abcd", Snapshot: &CapabilitySnapshot{SkillSummaries: []SkillSummary{{Name: "inspect", Description: "检查技能"}}}}}
	messages := baseContext(a, WorkingMemory{Summary: "记忆内容"}, agentSystem, nil)
	parts := messages[1].EstimatedBreakdown
	if parts == nil || parts.Messages != 3 || parts.Skills == 0 || parts.Other == 0 || parts.SystemPrompt != 0 || parts.SystemTools != 0 {
		t.Fatalf("header 来源未拆分：%+v", parts)
	}
	a.run.Snapshot.SkillSummaries = nil
	if parts = baseContext(a, WorkingMemory{}, agentSystem, nil)[1].EstimatedBreakdown; parts.Skills != 0 {
		t.Fatalf("没有技能时把 null/空数组算成了技能：%+v", parts)
	}
}

func TestContextUsageImagesAndNoWireOrBudgetChanges(t *testing.T) {
	plain := model.Request{Messages: []model.Message{{Role: "user", Content: "abcd"}}, MaxTokens: 128}
	before, _ := json.Marshal(plain)
	budget := estimateRequest(plain)
	marked := plain
	marked.Messages = append([]model.Message(nil), plain.Messages...)
	marked.Messages[0].EstimatedBreakdown = &model.ContextBreakdown{Messages: 1}
	marked.EstimatedBreakdown = estimateFittedContext(marked, nil)
	after, _ := json.Marshal(marked)
	if string(before) != string(after) || budget != estimateRequest(marked) {
		t.Fatalf("本地元数据改变了正文或准入估算：before=%s after=%s", before, after)
	}
	withoutImages := marked.EstimatedBreakdown.Messages
	marked.Messages[0].Images = []model.ImagePart{{MimeType: "image/png", Data: []byte("not-base64")}}
	if got := estimateFittedContext(marked, nil).Messages - withoutImages; got != 1024 {
		t.Fatalf("图片估算没有沿用每张1024：%d", got)
	}
}

func TestContextUsageProjectionKeepsUnknownZeroAndLocalOutput(t *testing.T) {
	if projectContextBreakdown(ModelRequestRecord{Response: &model.Response{Content: "旧记录"}}) != nil {
		t.Fatal("旧记录被伪造成已记录的分类")
	}
	zero := ModelRequestRecord{EstimatedBreakdown: &model.ContextBreakdown{}, Response: &model.Response{}}
	if got := projectContextBreakdown(zero); got == nil || *got != (model.ContextBreakdown{}) {
		t.Fatalf("明确零丢失：%+v", got)
	}
	largeReported := 9000
	record := ModelRequestRecord{EstimatedBreakdown: &model.ContextBreakdown{Messages: 5, Skills: 2}, Response: &model.Response{Content: "回答", Reasoning: "思考", Usage: model.Usage{CompletionTokens: &largeReported}}}
	if got := projectContextBreakdown(record); got == nil || got.Messages != 9 || got.Skills != 2 || record.EstimatedBreakdown.Messages != 5 {
		t.Fatalf("输出未以本地算法计入消息，或修改了已存输入：%+v", got)
	}
	record.Response.ToolCalls = []model.ToolCall{{ID: "call", Name: "test", Arguments: json.RawMessage(`{}`)}}
	if got := projectContextBreakdown(record); got.Messages <= 9 {
		t.Fatalf("输出工具调用未计入：%+v", got)
	}
	record.EstimatedBreakdown.Other = -1
	if got := projectContextBreakdown(record); got != nil {
		t.Fatalf("无效分类没有按未知处理：%+v", got)
	}
	limit := int(1<<53 - 1)
	for _, record := range []ModelRequestRecord{
		{EstimatedBreakdown: &model.ContextBreakdown{Messages: limit, Other: 1}},
		{EstimatedBreakdown: &model.ContextBreakdown{Other: limit}, Response: &model.Response{Content: "溢出"}},
	} {
		if got := projectContextBreakdown(record); got != nil {
			t.Fatalf("分类总和超出浏览器安全整数：%+v", got)
		}
	}
}

func TestContextUsagePersistsNumbersAndAppearsInTimeline(t *testing.T) {
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if request.EstimatedBreakdown == nil {
			t.Error("最终推理请求没有本地组成")
		}
		return finalReply("回答"), nil
	}, nil)
	run := runtimeFinished(t, m, submitAgentTest(t, m, session, "context-usage-record", "本轮私有输入标记").ID)
	if run.Status != StateSucceeded {
		t.Fatalf("run=%+v", run.Error)
	}
	page, err := m.store.modelRequests(context.Background(), run.ID, "", 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range page.Items {
		if record.Purpose != "inference" {
			if record.EstimatedBreakdown != nil {
				t.Errorf("内部整理请求不应保存聊天分类：%+v", record)
			}
			continue
		}
		if record.EstimatedBreakdown == nil || record.EstimatedBreakdown.Messages == 0 || record.EstimatedBreakdown.SystemPrompt == 0 {
			t.Fatalf("数字来源未持久化：%+v", record.EstimatedBreakdown)
		}
		raw, _ := json.Marshal(record)
		if strings.Contains(string(raw), "本轮私有输入标记") || strings.Contains(string(raw), agentSystem) {
			t.Fatalf("分类记录额外保存了原始提示词：%s", raw)
		}
	}
	output, err := m.ChatSnapshot(context.Background(), run.ID)
	if err != nil || output.Timeline == nil || output.Timeline.ContextUsage == nil || output.Timeline.ContextUsage.EstimatedBreakdown == nil {
		t.Fatalf("timeline未投影分类：%+v %v", output.Timeline, err)
	}
}

func TestContextUsageClippedSharedConversationDoesNotLeaveWeights(t *testing.T) {
	const marker = "discarded-shared-context"
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		return finalReply("完成"), nil
	}, nil)
	first := runtimeFinished(t, m, submitAgentTest(t, m, session, "context-usage-first", strings.Repeat(marker, 300)).ID)
	if first.Status != StateSucceeded {
		t.Fatalf("first=%+v", first.Error)
	}
	run := runtimeFinished(t, m, submitAgentTest(t, m, session, "context-usage-second", "本轮").ID)
	if run.Status != StateSucceeded {
		t.Fatalf("second=%+v", run.Error)
	}
	a := &agentExecution{manager: m, run: run}
	a.run.Limits.OutputTokens = 128
	a.run.Model.ContextTokens = 4000
	request, _, _, err := a.buildContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range request.Messages {
		if strings.Contains(message.Content, marker) {
			t.Fatal("fixture did not clip oversized shared history")
		}
	}
	if request.EstimatedBreakdown == nil || request.EstimatedBreakdown.Messages >= 100 {
		t.Fatalf("已裁剪消息留下分类权重：%+v", request.EstimatedBreakdown)
	}
}

func TestContextUsageSkillTextProvenanceSurvivesMemoryConsolidation(t *testing.T) {
	f := newExtensionFixture(t)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		found := 0
		for _, message := range request.Messages {
			if strings.Contains(message.Content, "marker-skill-raw") {
				found++
				if message.EstimatedBreakdown == nil || message.EstimatedBreakdown.Skills == 0 || message.EstimatedBreakdown.Messages != 0 {
					t.Errorf("技能正文被当成普通消息：%+v", message.EstimatedBreakdown)
				}
			}
		}
		if found != 1 {
			t.Errorf("技能原文缺失或重复：%d", found)
		}
		return finalReply("完成"), nil
	}, func(deps *Deps) { deps.Catalog = f.extensions })
	if _, err := m.PutEnvironment(context.Background(), session.ID, 0, f.environment()); err != nil {
		t.Fatal(err)
	}
	first, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "context-usage-skill", Content: "检查技能", Skills: []RevisionRef{{ID: f.skill.ID, Revision: f.skill.Revision}}})
	if err != nil {
		t.Fatal(err)
	}
	if run := runtimeFinished(t, m, first.ID); run.Status != StateSucceeded {
		t.Fatalf("first=%+v", run.Error)
	}
	next, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "context-usage-skill-continued", Content: "继续"})
	if err != nil {
		t.Fatal(err)
	}
	if run := runtimeFinished(t, m, next.ID); run.Status != StateSucceeded {
		t.Fatalf("continued=%+v", run.Error)
	}
}
