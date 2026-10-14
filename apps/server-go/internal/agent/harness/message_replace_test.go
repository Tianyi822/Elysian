package harness

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func TestChatHTTPStopThenEdit(t *testing.T) {
	emitted := make(chan struct{})
	var calls atomic.Int32
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if calls.Add(1) == 1 {
			request.OnReasoning("尚未完成的思考")
			request.OnContent("尚未完成的回答")
			close(emitted)
			<-ctx.Done()
			return model.Response{}, ctx.Err()
		}
		return finalReply("重新生成的回答"), nil
	}, nil)
	router := m.Router()
	submit := func(path string, input AgentInput) Run {
		t.Helper()
		body, _ := json.Marshal(input)
		response := runtimeRouteRequest(router, http.MethodPost, path, string(body))
		if response.Code != http.StatusAccepted && response.Code != http.StatusOK {
			t.Fatalf("提交失败：%d %s", response.Code, response.Body.String())
		}
		var run Run
		if err := json.Unmarshal(response.Body.Bytes(), &run); err != nil {
			t.Fatal(err)
		}
		return run
	}
	history := func() Page[Message] {
		t.Helper()
		response := runtimeRouteRequest(router, http.MethodGet, "/sessions/"+session.ID+"/messages?after=0", "")
		var page Page[Message]
		if response.Code != 200 {
			t.Fatalf("回读失败：%s", response.Body.String())
		}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
			t.Fatal(err)
		}
		return page
	}
	first := submit("/sessions/"+session.ID+"/tasks", AgentInput{RequestID: "http-original", Content: "原问题"})
	select {
	case <-emitted:
	case <-time.After(5 * time.Second):
		t.Fatal("没有收到测试增量")
	}
	stop := runtimeRouteRequest(router, http.MethodPost, "/runs/"+first.ID+"/cancel", "")
	if stop.Code != 200 && stop.Code != 202 {
		t.Fatalf("停止失败：%s", stop.Body.String())
	}
	if run := runtimeFinished(t, m, first.ID); run.Status != StateCancelled {
		t.Fatalf("停止状态错误：%+v", run)
	}
	page := history()
	if len(page.Items) != 2 || page.Items[1].Content != "尚未完成的回答" || page.Items[1].RunStatus != StateCancelled {
		t.Fatalf("停止后的历史错误：%+v", page)
	}
	target := page.Items[0].ID
	second := submit("/tasks/"+first.TaskID+"/runs", AgentInput{RequestID: "http-edit", Content: "修改后的问题", ReplaceMessageID: target})
	runtimeFinished(t, m, second.ID)
	page = history()
	if len(page.Items) != 2 || page.Items[0].Content != "修改后的问题" || page.Items[1].Content != "重新生成的回答" || page.Items[0].ReplacesMessageID != target {
		t.Fatalf("重发后的历史错误：%+v", page)
	}
	again := runtimeRouteRequest(router, http.MethodPost, "/runs/"+second.ID+"/cancel", "")
	var completed Run
	if err := json.Unmarshal(again.Body.Bytes(), &completed); err != nil || completed.Status != StateSucceeded {
		t.Fatal("完成后取消覆盖了成功状态", err)
	}
}

func TestAgentReplaceRewindsContextAndKeepsEarlierTurns(t *testing.T) {
	ctx := context.Background()
	var stage atomic.Int32
	prompts := make(chan string, 8)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			reply := memoryReply(request)
			var proposal memoryProposal
			json.Unmarshal(reply.ToolCalls[0].Arguments, &proposal)
			proposal.Summary = "记忆-" + string(rune('A'+stage.Load()))
			reply.ToolCalls[0].Arguments, _ = json.Marshal(proposal)
			return reply, nil
		}
		raw, _ := json.Marshal(request.Messages)
		prompts <- string(raw)
		return finalReply("回答-" + string(rune('A'+stage.Load()))), nil
	}, nil)
	first := submitAgentTest(t, m, session, "original", "原始输入-A")
	runtimeFinished(t, m, first.ID)
	<-prompts
	taskID := first.TaskID
	lastInput := "原始输入-A"
	for index, content := range []string{"更正输入-B", "再次更正-C", "继续输入-D", "更正续轮-E"} {
		stage.Store(int32(index + 1))
		page, err := m.Messages(ctx, session.ID, "0", 100)
		if err != nil {
			t.Fatal(err)
		}
		target := page.Items[len(page.Items)-2]
		input := AgentInput{RequestID: "edit-" + string(rune('B'+index)), Content: content}
		if index != 2 {
			input.ReplaceMessageID = target.ID
		}
		run, duplicate, err := m.ContinueTask(ctx, taskID, input)
		if err != nil || duplicate {
			t.Fatalf("编辑提交失败：%v", err)
		}
		runtimeFinished(t, m, run.ID)
		prompt := <-prompts
		if !strings.Contains(prompt, content) {
			t.Fatal("新输入没有进入上下文")
		}
		if index != 2 && (strings.Contains(prompt, lastInput) || strings.Contains(prompt, "回答-"+string(rune('A'+index))) || strings.Contains(prompt, "记忆-"+string(rune('A'+index)))) {
			t.Fatalf("旧轮污染替换上下文：%s", prompt)
		}
		if index >= 2 && !strings.Contains(prompt, "记忆-C") {
			t.Fatalf("丢失更早的记忆：%s", prompt)
		}
		again, dup, err := m.ContinueTask(ctx, taskID, input)
		if err != nil || !dup || again.ID != run.ID {
			t.Fatalf("重试没有复用运行：%+v %v", again, err)
		}
		changed := input
		changed.ReplaceMessageID = "different-message"
		if _, _, err = m.ContinueTask(ctx, taskID, changed); err == nil {
			t.Fatal("请求幂等未包含替换目标")
		}
		page, err = m.Messages(ctx, session.ID, "0", 100)
		want := 2
		if index >= 2 {
			want = 4
		}
		if err != nil || len(page.Items) != want {
			t.Fatalf("公开历史不正确：%+v %v", page, err)
		}
		originalID := target.ReplacesMessageID
		if originalID == "" {
			originalID = target.ID
		}
		if input.ReplaceMessageID != "" && page.Items[len(page.Items)-2].ReplacesMessageID != originalID {
			t.Fatal("缺少替换指针")
		}
		lastInput = content
	}
	old, err := m.Get(ctx, first.ID)
	if err != nil || old.Input != "原始输入-A" || old.SupersededByRunID == "" {
		t.Fatalf("原始记录丢失：%+v %v", old, err)
	}
	m.mu.Lock()
	readRecordLines(t, m.store, recordOwner{"session", session.ID})
	m.mu.Unlock()
}

func TestMessageReplacementIsAtomicAndRejectsStaleTarget(t *testing.T) {
	s, _ := openRuntimeTestStore(t)
	ctx := context.Background()
	session, task, input := sessionStoreFixture(t, s, "replace-atomic", runtimeStoreTestTime)
	first := acceptSessionTestRun(t, s, task, input, true)
	finishSessionTestRun(t, s, first.ID, "原回复", &WorkingMemory{Revision: 1, Coverage: MemoryCursor{RunNumber: 1, EventSeq: "1"}, Summary: "原记忆"})
	next := input
	next.ID, next.RequestID, next.Input = "replacement", "replacement-request", "新问题"
	next.Selection = &AgentInput{ReplaceMessageID: "message-" + first.ID}
	if _, err := s.db.Exec("CREATE TRIGGER fail_replacement BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'injected-failure'); END"); err != nil {
		t.Fatal(err)
	}
	before := runtimeStoreCount(t, s, "agent_record_outbox")
	if _, _, err := s.acceptAgent(ctx, task, next, "replacement-input", "new-message", false); err == nil {
		t.Fatal("事务应失败")
	}
	old, _ := readRun(ctx, s.db, first.ID)
	memory, _ := s.memory(ctx, task.ID, 0)
	storedTask, _ := readTask(ctx, s.db, task.ID)
	if old.SupersededByRunID != "" || memory.Revision != 1 || storedTask.Goal != task.Goal || runtimeStoreCount(t, s, "agent_record_outbox") != before {
		t.Fatal("失败留下半次替换")
	}
	if _, err := s.db.Exec("DROP TRIGGER fail_replacement"); err != nil {
		t.Fatal(err)
	}
	next.Selection.ReplaceMessageID = "wrong-message"
	if _, _, err := s.acceptAgent(ctx, task, next, "replacement-input", "new-message", false); err == nil {
		t.Fatal("允许编辑过期目标")
	}
	page, _ := s.messages(ctx, session.ID, "0", 100)
	if len(page.Items) != 2 || page.Items[1].Content != "原回复" {
		t.Fatal("拒绝编辑后改变历史")
	}
}
