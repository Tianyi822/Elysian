package tui

import (
	"strings"
	"testing"

	"elysian/server/internal/cli/client"
)

// 聊天屏缺陷回归测试（改写自审查复现用例）：迟到的异步回填归属校验、发送在途锁定
// 切换、运行时授权开关随轮提交与幂等字段冻结、消息序号数值化推进、未确认提交跨
// 会话重进持久化与受理核对、最终答复去重、装配未完成禁止发送。

// regressionChatReady 就绪聊天屏（会话 s1，目录含带档位模型）。
func regressionChatReady(t *testing.T, api *fakeAPI) Model {
	t.Helper()
	return chatReady(t, api, []client.Session{{ID: "s1", Title: "回归", ModelProfileID: "p1", ModelRevision: 1}}, pickerModels())
}

// —— 问题 1：迟到的提交／轮询／取消／审批回填不得污染当前会话 ——

// 旧会话或 requestId 对不上的提交回填整体丢弃：不改当前会话的 runID/taskID，也
// 不解除发送态、不清 pending。
func TestChatStaleSubmitCannotAttachToCurrentSession(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.sessionID = "session-current"
	m.chat.pending = &pendingSend{requestID: "request-current", content: "current", permissionMode: "ask"}
	m.chat.sending = true
	m = feedMsg(t, m, submitMsg{
		sessionID: "session-old", requestID: "request-old",
		run: client.Run{ID: "run-old", TaskID: "task-old", SessionID: "session-old", Status: "running"},
	})
	if m.chat.runID == "run-old" || m.chat.taskID == "task-old" || !m.chat.sending {
		t.Fatalf("旧会话提交回填污染当前会话：session=%s run=%s task=%s sending=%v", m.chat.sessionID, m.chat.runID, m.chat.taskID, m.chat.sending)
	}
	if m.chat.pending == nil || m.chat.pending.requestID != "request-current" {
		t.Fatalf("旧回填不应清掉当前 pending：%+v", m.chat.pending)
	}
	// 同会话但 requestId 与原 pending 不匹配（迟到或未知回执）同样丢弃。
	m = feedMsg(t, m, submitMsg{
		sessionID: "session-current", requestID: "request-old",
		run: client.Run{ID: "run-old", TaskID: "task-old", SessionID: "session-current", Status: "running"},
	})
	if m.chat.runID == "run-old" || !m.chat.sending {
		t.Fatalf("requestId 不匹配的回填必须丢弃：run=%s sending=%v", m.chat.runID, m.chat.sending)
	}
}

// 旧会话或旧 Run 的轮询回填丢弃：不改当前运行状态、不停轮询链；匹配归属的轮询
// 正常收敛。
func TestChatStalePollCannotChangeCurrentRun(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.runID, m.chat.runStatus, m.chat.polling = "run-current", "running", true
	m = feedMsg(t, m, pollMsg{sessionID: "other-session", runID: "run-old", run: &client.Run{ID: "run-old", SessionID: "other-session", Status: "succeeded"}})
	if !m.chat.polling || m.chat.runStatus != "running" {
		t.Fatalf("旧会话轮询污染当前运行：status=%s polling=%v", m.chat.runStatus, m.chat.polling)
	}
	m = feedMsg(t, m, pollMsg{sessionID: "s1", runID: "run-old", run: &client.Run{ID: "run-old", Status: "succeeded"}})
	if !m.chat.polling || m.chat.runStatus != "running" {
		t.Fatalf("旧 Run 轮询污染当前运行：status=%s polling=%v", m.chat.runStatus, m.chat.polling)
	}
	// 归属匹配的终态回填正常收敛。
	m = feedMsg(t, m, pollMsg{sessionID: "s1", runID: "run-current", run: &client.Run{ID: "run-current", Status: "succeeded"}})
	if m.chat.polling || m.chat.runStatus != "succeeded" {
		t.Fatalf("匹配归属的轮询应收敛：status=%s polling=%v", m.chat.runStatus, m.chat.polling)
	}
}

// 旧 Run 的取消回填丢弃：「正在停止」与运行状态不被无关回执打断；匹配回执收敛。
func TestChatStaleCancelDroppedForOtherRun(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.runID, m.chat.runStatus, m.chat.stopping = "r", "running", true
	m = feedMsg(t, m, cancelMsg{runID: "other", run: client.Run{ID: "other", Status: "cancelled"}})
	if !m.chat.stopping || m.chat.runStatus != "running" {
		t.Fatalf("旧 Run 取消回填污染当前状态：status=%s stopping=%v", m.chat.runStatus, m.chat.stopping)
	}
	m = feedMsg(t, m, cancelMsg{runID: "r", run: client.Run{ID: "r", Status: "cancelled"}})
	if m.chat.stopping || m.chat.runStatus != "cancelled" {
		t.Fatalf("匹配 Run 的取消回填应收敛：status=%s stopping=%v", m.chat.runStatus, m.chat.stopping)
	}
}

// 旧 Run 的审批列表回填丢弃：面板与徽标展示集不被污染；匹配回填正常落地。
func TestChatStaleApprovalsDroppedForOtherRun(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.runID = "r-2"
	m.chat.panel = newApprovalPanel(map[string]client.AccessDecisionInput{})
	m = feedMsg(t, m, approvalsMsg{runID: "r-old", items: []client.Approval{pendingApproval(false)}})
	if len(m.chat.panel.approvals) != 0 || len(m.chat.pendingApprovals) != 0 {
		t.Fatalf("旧 Run 审批回填污染面板：%+v / %+v", m.chat.panel.approvals, m.chat.pendingApprovals)
	}
	m = feedMsg(t, m, approvalsMsg{runID: "r-2", items: []client.Approval{pendingApproval(false)}})
	if len(m.chat.panel.approvals) != 1 || len(m.chat.pendingApprovals) != 1 {
		t.Fatalf("匹配 Run 的审批回填应落地：%+v / %+v", m.chat.panel.approvals, m.chat.pendingApprovals)
	}
}

// 发送在途锁定切换：sending 未收敛时 Esc 不得离开聊天屏；收敛后可正常离开。
func TestChatEscLockedWhileSending(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.editor.SetValue("在途消息")
	m.chat.sending = true
	m = pressKey(t, m, keyEsc)
	if m.phase != phaseSession {
		t.Fatalf("发送在途 Esc 不应离开聊天屏：phase=%d", m.phase)
	}
	if !strings.Contains(m.notice, "发送在途") {
		t.Fatalf("锁定离开应给出明确提示：%q", m.notice)
	}
	m.chat.sending = false
	m = pressKey(t, m, keyEsc)
	if m.phase != phaseSessions {
		t.Fatalf("发送收敛后应允许离开：phase=%d", m.phase)
	}
}

// —— 问题 2：TUI 与 Web 同口径启用运行时授权，且幂等字段随 pending 冻结 ——

// 新建与续聊提交都携带 authorizationMode:"on-demand"（后端以此加入 Bash 能力并进
// 入统一运行时授权路径）。
func TestChatSubmitEnablesOnDemandAuthorization(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.editor.SetValue("check files")
	_, cmd := m.sendCurrent()
	if cmd == nil {
		t.Fatal("应发起提交")
	}
	_ = cmd()
	if len(api.submittedInputs) != 1 {
		t.Fatalf("应提交一次：%+v", api.submittedInputs)
	}
	if got := api.submittedInputs[0].AuthorizationMode; got != client.AuthorizationOnDemand {
		t.Fatalf("TUI 请求未启用 Web 同口径运行时授权：%q", got)
	}
}

// 旧未确认 pending 重试保留首次提交的原字段集合：缺 authorizationMode 的旧 pending
// 重试不擅自补写，思考档等幂等字段也保持首次冻结值。
func TestChatPendingRetryKeepsOriginalFieldSet(t *testing.T) {
	api := &fakeAPI{}
	api.createTaskErr = &client.Error{Kind: client.KindUnreachable, Message: "连接失败"}
	m := regressionChatReady(t, api)
	m.levels["s1"] = "high"
	m.chat.editor.SetValue("结果未确认的重试")
	m = sendKey(t, m, keyEnter) // 首次提交失败：pending 冻结 high 与 on-demand。
	if m.chat.pending == nil {
		t.Fatal("失败应保留 pending")
	}
	m.levels["s1"] = "max" // 本地换档不改写已冻结载荷。
	api.createTaskErr = nil
	m = sendKey(t, m, keyEnter)
	if len(api.submittedInputs) != 2 {
		t.Fatalf("重试应再次提交：%+v", api.submittedInputs)
	}
	first, second := api.submittedInputs[0], api.submittedInputs[1]
	if second.RequestID != first.RequestID {
		t.Fatalf("重试应复用同 requestId：%q vs %q", first.RequestID, second.RequestID)
	}
	if first.AuthorizationMode != client.AuthorizationOnDemand || first.ReasoningLevel != "high" {
		t.Fatalf("首次提交应带运行时授权与所选思考档：%+v", first)
	}
	if second.ReasoningLevel != "high" || second.AuthorizationMode != client.AuthorizationOnDemand {
		t.Fatalf("重试应保持首次冻结的幂等字段：%+v", second)
	}
	// 旧版本持久化的 pending（无 authorizationMode）重试不补写新字段。
	m.chat.runStatus = "succeeded" // 上一轮已收敛，避免会话忙拦截。
	m.chat.pending = &pendingSend{requestID: "legacy-request", content: "旧格式重试", permissionMode: "ask"}
	m.chat.editor.SetValue("旧格式重试")
	m = sendKey(t, m, keyEnter)
	legacy := api.submittedInputs[len(api.submittedInputs)-1]
	if legacy.RequestID != "legacy-request" || legacy.AuthorizationMode != "" {
		t.Fatalf("旧 pending 重试不得擅自补写字段集：%+v", legacy)
	}
}

// —— 问题 3：消息序号按十进制数值推进，跨十进制位数不丢增量 ——

func TestChatMessageSeqCrossesDecimalBoundary(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.lastSeq = "9"
	m = feedMsg(t, m, messagesAppendedMsg{sessionID: "s1", messages: []client.Message{
		{ID: "m10", Seq: "10", Role: "assistant", Content: "answer"},
	}})
	if m.chat.lastSeq != "10" || len(m.chat.messages) != 1 {
		t.Fatalf("游标 9 后 seq=10 的增量丢失：lastSeq=%s messages=%d", m.chat.lastSeq, len(m.chat.messages))
	}
	// 重复回读同 seq 不重复追加（去重兜底）。
	m = feedMsg(t, m, messagesAppendedMsg{sessionID: "s1", messages: []client.Message{
		{ID: "m10", Seq: "10", Role: "assistant", Content: "answer"},
	}})
	if len(m.chat.messages) != 1 {
		t.Fatalf("同 seq 重复回读不应重复追加：%d", len(m.chat.messages))
	}
}

// —— 问题 4：未确认提交按会话持久化，重进恢复并在服务端已受理时落定 ——

// 离开重进（同进程）不丢未确认提交：requestId 与冻结字段随草稿信封恢复。
func TestChatPendingRequestSurvivesSessionReentry(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.editor.SetValue("an operation whose response was lost")
	m.chat.pending = &pendingSend{requestID: "original-request", content: m.chat.editor.Value(), permissionMode: "ask"}
	m = pressKey(t, m, keyEsc) // 离开：草稿与未确认提交进信封。
	if m.phase != phaseSessions {
		t.Fatalf("Esc 应返回列表：phase=%d", m.phase)
	}
	m = pressKey(t, m, keyEnter)
	m = runCmd(t, m, loadChatCmd(api, "s1"))
	if m.chat.pending == nil || m.chat.pending.requestID != "original-request" {
		t.Fatalf("未确认提交及其幂等键在离开重进后丢失：%+v", m.chat.pending)
	}
	if m.chat.pending.permissionMode != "ask" || m.chat.pending.content != "an operation whose response was lost" {
		t.Fatalf("恢复的 pending 应保留首次冻结载荷：%+v", m.chat.pending)
	}
	if m.chat.editor.Value() != "an operation whose response was lost" {
		t.Fatalf("草稿应随信封恢复：%q", m.chat.editor.Value())
	}
}

// 未确认提交随本地状态持久化（StoredState.Drafts 同路径），重启 TUI 后同样恢复。
func TestChatPendingSurvivesRestartViaStoredState(t *testing.T) {
	api := &fakeAPI{}
	sessions := []client.Session{{ID: "s1", Title: "回归", ModelProfileID: "p1", ModelRevision: 1}}
	deps := &fakeDeps{api: api, discover: okDiscover}
	m := bootReadyWithDeps(t, deps, api, sessions, pickerModels())
	m = step(t, m, keyEnter)
	m = runCmd(t, m, loadChatCmd(api, "s1"))
	m.chat.editor.SetValue("crash before receipt")
	m.chat.pending = &pendingSend{requestID: "survives-restart", content: m.chat.editor.Value(), permissionMode: "ask"}
	m = sendKey(t, m, keyEsc) // 离开并执行持久化。
	if len(deps.savedStates) == 0 {
		t.Fatal("离开聊天屏应触发本地持久化")
	}
	saved := deps.savedStates[len(deps.savedStates)-1]
	if saved.Drafts["s1"] == "" {
		t.Fatalf("未确认提交信封应随 StoredState.Drafts 持久化：%+v", saved.Drafts)
	}
	restart := &fakeDeps{api: api, discover: okDiscover, loadState: func() StoredState { return saved }}
	m = bootReadyWithDeps(t, restart, api, sessions, pickerModels())
	m = step(t, m, keyEnter)
	m = runCmd(t, m, loadChatCmd(api, "s1"))
	if m.chat.pending == nil || m.chat.pending.requestID != "survives-restart" {
		t.Fatalf("重启后未确认提交应按信封恢复：%+v", m.chat.pending)
	}
}

// 重进装配时核对服务端事实：提交游标之后出现同内容用户消息（与 Run 创建同事务
// 落库）即已受理——落定 pending 并清草稿，不重复提交；无受理证据（游标前的同文
// 本旧消息不算）则保留原请求。
func TestChatPendingSettledAgainstServerFacts(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.pending = &pendingSend{requestID: "req-accepted", content: "lost response", permissionMode: "ask", afterSeq: "4"}
	m = feedMsg(t, m, chatLoadedMsg{
		sessionID: "s1",
		session:   &client.Session{ID: "s1", ModelProfileID: "p1", ModelRevision: 1},
		messages:  []client.Message{{ID: "m5", SessionID: "s1", Seq: "5", Role: "user", Content: "lost response", CreatedAt: "2026-10-25T08:00:00.000Z"}},
		lastSeq:   "5",
	})
	if m.chat.pending == nil {
		t.Fatal("同文消息不能确认 pending")
	}
	m = feedMsg(t, m, pendingResolvedMsg{sessionID: "s1", requestID: "req-accepted", run: &client.Run{RequestID: "req-accepted", SessionID: "s1"}})
	if m.chat.pending != nil {
		t.Fatalf("服务端已受理应落定 pending：%+v", m.chat.pending)
	}
	if m.chat.editor.Value() != "" || m.drafts["s1"] != "" {
		t.Fatalf("落定应清草稿：%q %q", m.chat.editor.Value(), m.drafts["s1"])
	}
	// 游标前的同内容旧消息不构成受理证据：pending 保留。
	m.chat.pending = &pendingSend{requestID: "req-unsettled", content: "lost response", permissionMode: "ask", afterSeq: "4"}
	m = feedMsg(t, m, chatLoadedMsg{
		sessionID: "s1",
		session:   &client.Session{ID: "s1", ModelProfileID: "p1", ModelRevision: 1},
		messages:  []client.Message{{ID: "m3", SessionID: "s1", Seq: "3", Role: "user", Content: "lost response", CreatedAt: "2026-10-25T07:00:00.000Z"}},
		lastSeq:   "3",
	})
	if m.chat.pending == nil || m.chat.pending.requestID != "req-unsettled" {
		t.Fatalf("无受理证据应保留 pending 供原请求重试：%+v", m.chat.pending)
	}
}

// —— 问题 11：公开最终消息确认后隐藏对应流式正文，答复只显示一次 ——

func TestChatFinalAnswerNotDuplicated(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.messages = []client.Message{{ID: "final", Role: "assistant", RunID: "r", Content: "unique-final-answer"}}
	m.chat.stream = &client.ChatOutput{RunID: "r", Content: "unique-final-answer", Done: true}
	if n := strings.Count(m.chat.renderContent(m), "unique-final-answer"); n != 1 {
		t.Fatalf("已确认的最终答复渲染了 %d 次", n)
	}
	// 未确认（最终消息未进历史）时流式正文保留展示。
	m.chat.messages = nil
	if n := strings.Count(m.chat.renderContent(m), "unique-final-answer"); n != 1 {
		t.Fatalf("流式期间正文应保留展示，渲染了 %d 次", n)
	}
}

// —— 问题 13：装配未完成（读取中／读取失败）禁止发送，失败态给重试入口 ——

func TestChatLoadingSessionCannotSend(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.loading = true
	m.chat.editor.SetValue("draft waiting for load")
	next, cmd := m.sendCurrent()
	if cmd != nil {
		_ = cmd()
	}
	if len(api.submittedInputs) != 0 {
		t.Fatalf("读取中提交了新任务（taskID 与活跃 Run 尚未确认）：%+v", api.submittedInputs)
	}
	returned, ok := next.(Model)
	if !ok {
		t.Fatalf("模型应保持值语义：%T", next)
	}
	if !strings.Contains(returned.notice, "读取") {
		t.Fatalf("读取中发送应给出明确提示：%q", returned.notice)
	}
	// 读取失败同样禁止，r 提供明确重试入口。
	m.chat.loading = false
	m.chat.loadErr = "面板后端连接被拒绝"
	next, cmd = m.sendCurrent()
	if cmd != nil {
		_ = cmd()
	}
	returned = next.(Model)
	if len(api.submittedInputs) != 0 || !strings.Contains(returned.notice, "按 r") {
		t.Fatalf("读取失败应禁止发送并指引重试：%q", returned.notice)
	}
	m = pressKey(t, m, key("r"))
	if !m.chat.loading || m.chat.loadErr != "" {
		t.Fatalf("r 应重新装配会话：loading=%v loadErr=%q", m.chat.loading, m.chat.loadErr)
	}
	// 正常态 r 是普通字符，仍进编辑器。
	m.chat.loading = false
	m.chat.loadErr = ""
	m.chat.editor.SetValue("")
	m = pressKey(t, m, key("r"))
	if m.chat.editor.Value() != "r" {
		t.Fatalf("正常态 r 应落入编辑器：%q", m.chat.editor.Value())
	}
}
