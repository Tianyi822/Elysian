package tui

import (
	"strings"
	"testing"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

// 聊天屏状态机测试（第二步）：历史加载与分页、消息视觉区分、发送幂等链、流式
// 快照、停止收敛、断连提示、401 收敛与草稿。fake 的 StreamChatOutput 同步回放
// 预置帧；订阅 goroutine 与监听命令在测试内直接驱动。

// chatReady 进入聊天屏并完成装配（历史＋可选活跃 Run）。
func chatReady(t *testing.T, api *fakeAPI, sessions []client.Session, profiles []client.ModelProfile) Model {
	t.Helper()
	model := bootReady(t, api, sessions, profiles)
	model = pressKey(t, model, keyEnter)
	model = runCmd(t, model, loadChatCmd(api, model.chat.sessionID))
	return model
}

// sendKey 驱动按键并执行其返回的命令（Batch 会被 Update 忽略，关键命令显式驱动）。
func sendKey(t *testing.T, m Model, msg tea.KeyMsg) Model {
	t.Helper()
	next, cmd := m.Update(msg)
	model, ok := next.(Model)
	if !ok {
		t.Fatalf("模型应保持值语义：%T", next)
	}
	return runCmd(t, model, cmd)
}

// pressKey 驱动按键并取回值语义模型（不执行命令；命令由调用方按需驱动）。
func pressKey(t *testing.T, m Model, msg tea.KeyMsg) Model {
	t.Helper()
	next, _ := m.Update(msg)
	model, ok := next.(Model)
	if !ok {
		t.Fatalf("模型应保持值语义：%T", next)
	}
	return model
}

// listenFrames 驱动流监听取回指定数量的事件：只取事件与状态落地，不自动续听
// （updateStreamInterrupted 返回的续听命令在测试内会形成事件驱动循环，由本 helper
// 的循环显式控制节拍）。
func listenFrames(t *testing.T, m Model, want int) Model {
	t.Helper()
	for i := 0; i < want; i++ {
		if m.sub == nil {
			t.Fatalf("第 %d 帧时订阅已不存在", i)
		}
		msg := streamListenCmd(m.sub)()
		next, _ := m.Update(msg)
		var ok bool
		m, ok = next.(Model)
		if !ok {
			t.Fatalf("模型应保持值语义：%T", next)
		}
	}
	return m
}

func chatMessages() []client.Message {
	return []client.Message{
		{ID: "m1", SessionID: "s1", TaskID: "t1", RunID: "r1", Seq: "3", Role: "user", Content: "看看内存占用", CreatedAt: "2026-10-25T08:00:00.000Z"},
		{ID: "m2", SessionID: "s1", TaskID: "t1", RunID: "r1", Seq: "4", Role: "assistant", Content: "内存占用 **42%**，详见下表。", CreatedAt: "2026-10-25T08:00:05.000Z", RunStatus: "succeeded", RunConfig: &client.MessageRunConfig{ModelName: "glm", ModelProfileID: "p1", ModelRevision: 1, ReasoningLevel: "high"}},
	}
}

func TestChatLoadsHistoryAndDistinguishesRoles(t *testing.T) {
	api := &fakeAPI{messages: chatMessages()}
	api.messages[1].Seq = "4"
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "巡检", ModelProfileID: "p1", ModelRevision: 1}}, pickerModels())
	if len(model.chat.messages) != 2 {
		t.Fatalf("历史消息应装配：%+v", model.chat.messages)
	}
	if model.chat.lastSeq != "4" {
		t.Fatalf("增量游标应取最新 seq：%q", model.chat.lastSeq)
	}
	model.applyRender()
	view := model.View()
	// 用户与助手消息的视觉区分（「你」与「Ely」标记、模型与思考档前缀）。
	if !strings.Contains(view, "你 ·") || !strings.Contains(view, "看看内存占用") {
		t.Fatalf("用户消息应以「你」标记渲染：%q", view)
	}
	if !strings.Contains(view, "Ely · glm · 思考 高") {
		t.Fatalf("助手消息应带模型与思考档前缀：%q", view)
	}
	if !strings.Contains(view, "42%") {
		t.Fatalf("助手答复应经 Markdown 渲染保留内容：%q", view)
	}
}

func TestChatHistoryPaginatesUntilExhausted(t *testing.T) {
	// fakeAPI 的 ListMessages 为单页全量；分页续拉逻辑经真实分页桩验证：
	// 这里验证 hasMore 驱动的续拉聚合（两页合并）。
	api := &fakeAPI{}
	paged := &pagedMessages{pages: [][]client.Message{
		{{ID: "m1", SessionID: "s1", Seq: "1", Role: "user", Content: "一", CreatedAt: "2026-10-25T08:00:00.000Z"}},
		{{ID: "m2", SessionID: "s1", Seq: "2", Role: "assistant", Content: "二", CreatedAt: "2026-10-25T08:00:01.000Z"}},
	}}
	api.listMessagesOverride = paged.list
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "t", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	if len(model.chat.messages) != 2 || model.chat.lastSeq != "2" {
		t.Fatalf("分页续拉应聚合两页并推进游标：%+v last=%q", model.chat.messages, model.chat.lastSeq)
	}
}

func TestChatSendHappyPathSubmitsAndStreams(t *testing.T) {
	api := &fakeAPI{messages: chatMessages()}
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", SessionID: "s1", Status: "running"}
	api.streamFrames = []client.ChatOutput{
		{RunID: "r-2", Reasoning: "先看指标", Content: "", Done: false},
		{RunID: "r-2", Reasoning: "先看指标", Content: "内存占用 42%", Done: false, Timeline: &client.ChatTimeline{RunID: "r-2", Status: "running", Entries: []client.TimelineEntry{
			{ID: "x", Kind: "tool", Tool: "platform_metrics", Status: "succeeded", ArgumentsJSON: `{"scope":"host"}`},
		}}},
	}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "巡检", ModelProfileID: "p1", ModelRevision: 1}}, pickerModels())
	model.levels["s1"] = "high"
	// 输入内容并 Enter 发送。
	model = step(t, model, key("现在负载如何"))
	model = sendKey(t, model, keyEnter)
	if model.chat.sending {
		t.Fatal("提交回填应解除发送态")
	}
	if len(api.submittedInputs) != 1 {
		t.Fatalf("应提交一次：%+v", api.submittedInputs)
	}
	input := api.submittedInputs[0]
	if input.RequestID == "" || input.Content != "现在负载如何" {
		t.Fatalf("提交载荷不符：%+v", input)
	}
	if input.ExtensionMode != "enabled" || input.ReasoningLevel != "high" {
		t.Fatalf("提交应带扩展自动接入与本地思考档：%+v", input)
	}
	if model.chat.runID != "r-2" || model.chat.taskID != "t-1" {
		t.Fatalf("运行与任务应记录：%+v", model.chat)
	}
	if model.chat.editor.Value() != "" {
		t.Fatal("发送成功应清空输入")
	}
	// 流订阅启动并回放两帧。
	model = listenFrames(t, model, 2)
	if model.chat.stream == nil || model.chat.stream.Content != "内存占用 42%" {
		t.Fatalf("流快照应为最新全量帧：%+v", model.chat.stream)
	}
	if !model.chat.streamHealthy {
		t.Fatal("帧到达后连接应视为健康")
	}
	model.applyRender()
	view := model.View()
	if !strings.Contains(view, "正在回复") {
		t.Fatalf("流式期间应显示回复中提示：%q", view)
	}
	if !strings.Contains(view, "⚙ platform_metrics 成功") {
		t.Fatalf("工具条目应带名称与状态标签：%q", view)
	}
	if !strings.Contains(view, `{"scope":"host"}`) {
		t.Fatalf("工具条目应含参数摘要：%q", view)
	}
}

func TestChatSendBusyKeepsInputForRetry(t *testing.T) {
	api := &fakeAPI{messages: chatMessages()}
	api.createTaskErr = &client.Error{Kind: client.KindServer, Status: 409, Message: "会话已有运行中的任务", Code: "session-busy"}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "t", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	model = step(t, model, key("第二轮"))
	model = sendKey(t, model, keyEnter)
	if !strings.Contains(model.notice, "会话已有运行中的任务") {
		t.Fatalf("409 应呈现服务端原因：%q", model.notice)
	}
	if model.chat.editor.Value() != "第二轮" {
		t.Fatal("失败后输入应保留")
	}
	// 同输入重试复用同 requestId（幂等）。
	first := model.chat.pending.requestID
	api.createTaskErr = nil
	api.nextRun = client.Run{ID: "r-3", TaskID: "t-9", Status: "running"}
	model = sendKey(t, model, keyEnter)
	if len(api.submittedInputs) != 2 || api.submittedInputs[1].RequestID != first {
		t.Fatalf("重试应复用同 requestId：%+v（首轮 %s）", api.submittedInputs, first)
	}
}

func TestChatSendEmptyAndOversizeBlocked(t *testing.T) {
	api := &fakeAPI{}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "t", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	// 仅空白：忽略（不提交）。
	model = step(t, model, key("   "))
	model = pressKey(t, model, keyEnter)
	if len(api.submittedInputs) != 0 {
		t.Fatal("空白输入不应提交")
	}
	// 超限：本地拦截并提示。
	model.chat.editor.SetValue(strings.Repeat("字", 11000))
	model = pressKey(t, model, keyEnter)
	if len(api.submittedInputs) != 0 || !strings.Contains(model.notice, "32768") {
		t.Fatalf("超限应本地拦截：%q", model.notice)
	}
}

func TestChatStreamDoneAppendsFinalMessage(t *testing.T) {
	api := &fakeAPI{}
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", Status: "succeeded"}
	api.streamFrames = []client.ChatOutput{{RunID: "r-2", Content: "最终答复", Done: true, Timeline: &client.ChatTimeline{RunID: "r-2", Status: "succeeded", Done: true}}}
	// 终态后的增量消息（最终公开答复）。
	api.messages = []client.Message{{ID: "m9", SessionID: "s1", TaskID: "t1", RunID: "r-2", Seq: "9", Role: "assistant", Content: "最终答复", CreatedAt: "2026-10-25T08:09:00.000Z"}}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "t", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	model = step(t, model, key("问"))
	model = sendKey(t, model, keyEnter)
	model = listenFrames(t, model, 1)
	if model.chat.stream == nil || !model.chat.stream.Done {
		t.Fatalf("done 帧应落地快照：%+v", model.chat.stream)
	}
	// done 触发增量回读：最终消息进历史。
	model = runCmd(t, model, appendMessagesCmd(api, "s1", model.chat.lastSeq))
	if len(model.chat.messages) != 1 || model.chat.messages[0].Content != "最终答复" {
		t.Fatalf("终态后应增量补最终消息：%+v", model.chat.messages)
	}
}

func TestChatStopRunConverges(t *testing.T) {
	api := &fakeAPI{}
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", Status: "running"}
	api.streamFrames = []client.ChatOutput{{RunID: "r-2", Content: "答到一半", Done: false}}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "t", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	model = step(t, model, key("问"))
	model = sendKey(t, model, keyEnter)
	model = listenFrames(t, model, 1)
	model.applyRender()
	if !strings.Contains(model.View(), "正在回复") {
		t.Fatalf("流式中应有回复提示：%q", model.View())
	}
	// Ctrl+S 停止：fake 取消即时回 cancelled 终态。
	model = sendKey(t, model, tea.KeyMsg{Type: tea.KeyCtrlS})
	if model.chat.stopping || model.chat.runStatus != "cancelled" {
		t.Fatalf("取消终态应收敛停止态：%+v", model.chat)
	}
	if model.chat.polling {
		t.Fatal("终态后应停轮询")
	}
	model.applyRender()
	if !strings.Contains(model.View(), "已停止") {
		t.Fatalf("头部应显示已停止：%q", model.View())
	}
	// 已接收内容保留。
	if model.chat.stream == nil || model.chat.stream.Content != "答到一半" {
		t.Fatal("停止后已接收内容应保留")
	}
}

func TestChatStreamInterruptShowsReconnectNotice(t *testing.T) {
	api := &fakeAPI{}
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", Status: "running"}
	api.streamFrames = nil // 无帧：连接立即结束（interrupted 事件）。
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "t", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	model = step(t, model, key("问"))
	model = sendKey(t, model, keyEnter)
	model = listenFrames(t, model, 1) // interrupted 事件。
	if model.chat.streamHealthy {
		t.Fatal("断连后连接不应视为健康")
	}
	if !strings.Contains(model.View(), "实时连接暂时中断，正在重新连接；已接收的内容已保留") {
		t.Fatalf("断连应如实提示：%q", model.View())
	}
}

func TestChatStreamUnauthorizedFallsToLogin(t *testing.T) {
	api := &fakeAPI{}
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", Status: "running"}
	api.streamErr = &client.Error{Kind: client.KindUnauthorized, Status: 401, Message: "未登录"}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "t", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	model = step(t, model, key("问"))
	model = sendKey(t, model, keyEnter)
	model = listenFrames(t, model, 1)
	if model.phase != phaseLogin {
		t.Fatalf("流 401 应收敛登录屏：%d", model.phase)
	}
	if model.sub != nil {
		t.Fatal("收敛登录时应停订阅")
	}
}

func TestChatDraftPersistsAcrossScreens(t *testing.T) {
	api := &fakeAPI{messages: chatMessages()}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "巡检", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	model = step(t, model, key("没写完的草稿"))
	model = pressKey(t, model, keyEsc)
	if model.phase != phaseSessions {
		t.Fatalf("Esc 应返回列表：%d", model.phase)
	}
	if model.drafts["s1"] != "没写完的草稿" {
		t.Fatalf("草稿应存本地：%q", model.drafts["s1"])
	}
	// 重新进入：草稿回填输入框。
	model = pressKey(t, model, keyEnter)
	model = runCmd(t, model, loadChatCmd(api, "s1"))
	if model.chat.editor.Value() != "没写完的草稿" {
		t.Fatalf("重进应恢复草稿：%q", model.chat.editor.Value())
	}
}

func TestChatCtrlJInsertsNewline(t *testing.T) {
	api := &fakeAPI{}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "t", ModelProfileID: "p1", ModelRevision: 1}}, nil)
	model = step(t, model, key("第一行"))
	model = step(t, model, tea.KeyMsg{Type: tea.KeyCtrlJ})
	model = step(t, model, key("第二行"))
	if !strings.Contains(model.chat.editor.Value(), "第一行\n第二行") {
		t.Fatalf("Ctrl+J 应插入换行：%q", model.chat.editor.Value())
	}
}

// pagedMessages 分页桩：按调用次序回放预置页（最后一页 hasMore=false）。
type pagedMessages struct {
	pages [][]client.Message
	calls int
}

func (p *pagedMessages) list(_ string, after string) (client.Page[client.Message], error) {
	if after == "" {
		p.calls = 1
	} else {
		p.calls++
	}
	if p.calls > len(p.pages) {
		return client.Page[client.Message]{}, nil
	}
	page := p.pages[p.calls-1]
	hasMore := p.calls < len(p.pages)
	next := ""
	if len(page) > 0 {
		next = page[len(page)-1].Seq
	}
	return client.Page[client.Message]{Items: page, NextCursor: next, HasMore: hasMore}, nil
}
