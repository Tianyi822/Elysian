package tui

import (
	"strings"
	"testing"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

// 第三步状态机测试：计划折叠条、等待输入向导（含幂等重试与取消＝停止）、审批
// 面板（普通审批／运行时授权／会话授权撤回）、工具详情（calls 按需加载）与状态栏
// 徽标。审批轮询与向导均经流帧驱动（fake 的 streamFrames 预置含等待态的 timeline）。

// wizardFrame 构造一帧等待用户输入的 timeline。
func wizardFrame() client.ChatOutput {
	return client.ChatOutput{RunID: "r-2", Done: false, Timeline: &client.ChatTimeline{
		RunID: "r-2", Status: "waiting-input",
		Entries: []client.TimelineEntry{{
			ID: "q", Kind: "user-input", Status: "waiting",
			UserInput: &client.UserInputRequest{
				ID: "ui-1", RunID: "r-2", Status: "waiting",
				Questions: []client.UserInputQuestion{
					{ID: "q1", Header: "处置方式", Question: "发现磁盘占用过高，如何处理？", RecommendedOptionID: "opt-clean",
						Options: []client.UserInputOption{
							{ID: "opt-clean", Label: "清理临时文件", Description: "只删除 /tmp 下的临时产物"},
							{ID: "opt-report", Label: "仅生成报告"},
						}},
					{ID: "q2", Header: "执行时机", Question: "何时执行？",
						Options: []client.UserInputOption{
							{ID: "opt-now", Label: "立即"},
							{ID: "opt-later", Label: "稍后"},
						}},
				},
			},
		}},
	}}
}

// approvalFrame 构造一帧等待审批的 timeline（plan 一并携带）。
func approvalFrame() client.ChatOutput {
	return client.ChatOutput{RunID: "r-2", Done: false, Timeline: &client.ChatTimeline{
		RunID: "r-2", Status: "waiting-approval",
		Plan: &client.RunPlan{Revision: 2, Steps: []client.PlanStep{
			{ID: "s1", Title: "检查磁盘占用", Status: "completed"},
			{ID: "s2", Title: "清理临时文件", Status: "in_progress"},
			{ID: "s3", Title: "复核占用", Status: "pending"},
		}},
		Entries: []client.TimelineEntry{},
	}}
}

func pendingApproval(access bool) client.Approval {
	approval := client.Approval{ID: "ap-1", RunID: "r-2", Status: "pending", Kind: "operation",
		Operation: client.Operation{ID: "op-1", Status: "waiting-approval", ArgumentsJSON: `{"path":"/tmp","force":true}`,
			Capability: client.Capability{Name: "file_write", Source: "builtin"}}}
	if access {
		approval.Access = &client.AccessReq{Revision: 3, Digest: "d-abc", Kind: "script",
			Reason: "运行清理脚本", Directories: []client.AccessDirectory{{Path: "/srv/app", Access: "rw"}}}
	}
	return approval
}

// feedMsg 喂入一条消息但不执行其返回的命令（审批轮询等自续链路由调用方控制节拍，
// 与 listenFrames 同理）。
func feedMsg(t *testing.T, m Model, msg tea.Msg) Model {
	t.Helper()
	next, _ := m.Update(msg)
	model, ok := next.(Model)
	if !ok {
		t.Fatalf("模型应保持值语义：%T", next)
	}
	return model
}

// pollApprovalsOnce 手动执行一拍审批轮询（不续排）。
func pollApprovalsOnce(t *testing.T, api *fakeAPI, m Model) Model {
	t.Helper()
	items, err := api.ListApprovalsByRun(nil, "r-2")
	return feedMsg(t, m, approvalsMsg{items: items, err: err})
}

// driveToWaiting 发送并回放到指定等待帧（向导或审批）。
func driveToWaiting(t *testing.T, api *fakeAPI, frame client.ChatOutput) Model {
	t.Helper()
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", Status: "running"}
	api.streamFrames = []client.ChatOutput{frame}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "巡检", ModelProfileID: "p1", ModelRevision: 1}}, pickerModels())
	model = pressKey(t, model, key("开始"))
	model = sendKey(t, model, keyEnter)
	model = listenFrames(t, model, 1)
	return model
}

func TestPlanBarRendersAndExpands(t *testing.T) {
	api := &fakeAPI{}
	model := driveToWaiting(t, api, approvalFrame())
	if model.chat.plan == nil || len(model.chat.plan.Steps) != 3 {
		t.Fatalf("计划快照应随 timeline 落地：%+v", model.chat.plan)
	}
	if view := model.View(); !strings.Contains(view, "计划 1/3") || !strings.Contains(view, "清理临时文件") {
		t.Fatalf("折叠条应显示完成数与当前步骤：%q", view)
	}
	// Ctrl+P 展开：步骤全列。
	model = pressKey(t, model, tea.KeyMsg{Type: tea.KeyCtrlP})
	if view := model.View(); !strings.Contains(view, "✓ 检查磁盘占用") || !strings.Contains(view, "○ 复核占用") {
		t.Fatalf("展开应列出全部步骤：%q", view)
	}
}

func TestWaitingApprovalPollsAndShowsBadge(t *testing.T) {
	api := &fakeAPI{}
	api.approvals = []client.Approval{pendingApproval(false)}
	model := driveToWaiting(t, api, approvalFrame())
	if !model.chat.approvalPolling {
		t.Fatal("waiting-approval 应启动审批轮询")
	}
	// 手动执行首次审批拉取（面板未开时也预热徽标）。
	model = pollApprovalsOnce(t, api, model)
	if len(model.chat.pendingApprovals) != 1 {
		t.Fatalf("审批轮询应预热展示集：%+v", model.chat.pendingApprovals)
	}
	if view := model.View(); !strings.Contains(view, "1 项待审批") {
		t.Fatalf("状态栏应有待审批徽标：%q", view)
	}
}

func TestApprovalPanelDecideAndCancel(t *testing.T) {
	api := &fakeAPI{}
	api.approvals = []client.Approval{pendingApproval(false)}
	model := driveToWaiting(t, api, approvalFrame())
	model = pollApprovalsOnce(t, api, model)
	model = pressKey(t, model, tea.KeyMsg{Type: tea.KeyCtrlA})
	if model.chat.panel == nil || len(model.chat.panel.approvals) != 1 {
		t.Fatal("Ctrl+A 应打开审批面板并展示审批")
	}
	// 详情：完整参数与危险提示（builtin 非只读）。
	model = pressKey(t, model, keyEnter)
	view := model.View()
	if !strings.Contains(view, "完整参数") || !strings.Contains(view, `{"path":"/tmp","force":true}`) {
		t.Fatalf("详情应展示完整参数：%q", view)
	}
	if !strings.Contains(view, "不可回滚") {
		t.Fatalf("危险操作应有红色提示：%q", view)
	}
	// y 批准（按键 + 手动执行决定并喂回执，断续排链路由生产异步执行）。
	model = pressKey(t, model, key("y"))
	if model.chat.panel == nil || model.chat.panel.busy != true {
		t.Fatal("y 应进入决定在途")
	}
	decided, err := api.DecideApproval(nil, "ap-1", "approved")
	model = feedMsg(t, model, approvalDecisionMsg{approval: decided, err: err})
	if len(api.decided) != 1 || api.decided[0] != "ap-1:approved" {
		t.Fatalf("y 应提交批准：%v", api.decided)
	}
	if !strings.Contains(model.notice, "已批准") {
		t.Fatalf("批准后应有反馈：%q", model.notice)
	}
	// 取消本轮（x）：对运行发停止。
	model = pressKey(t, model, key("x"))
	model = runCmd(t, model, cancelRunCmd(api, "r-2"))
	if model.chat.runStatus != "cancelled" {
		t.Fatalf("取消本轮应停止运行：%s", model.chat.runStatus)
	}
}

func TestApprovalPanelAccessDecisionIdempotentRetry(t *testing.T) {
	api := &fakeAPI{}
	approval := pendingApproval(true)
	api.approvals = []client.Approval{approval}
	model := driveToWaiting(t, api, approvalFrame())
	model = pollApprovalsOnce(t, api, model)
	model = pressKey(t, model, tea.KeyMsg{Type: tea.KeyCtrlA})
	// 授权卡：详情展示范围。
	model = pressKey(t, model, keyEnter)
	if view := model.View(); !strings.Contains(view, "运行时授权") || !strings.Contains(view, "/srv/app") || !strings.Contains(view, "rw") {
		t.Fatalf("授权卡应展示目录与访问级别：%q", view)
	}
	// 首次决定失败（网络错误）：保留未确认决定。
	api.accessErr = &client.Error{Kind: client.KindUnreachable, Message: "连接失败"}
	model = pressKey(t, model, key("1"))
	first := model.chat.panel.pendingAccess["ap-1"]
	decidedAccess, err := api.DecideAccess(nil, "ap-1", first)
	model = feedMsg(t, model, approvalDecisionMsg{approval: decidedAccess, err: err})
	if len(api.accessDecided) != 1 || api.accessDecided[0].Decision != "once" {
		t.Fatalf("1 应提交仅本次授权：%+v", api.accessDecided)
	}
	firstRequestID := api.accessDecided[0].RequestID
	if api.accessDecided[0].ExpectedRevision != 3 || api.accessDecided[0].ExpectedDigest != "d-abc" {
		t.Fatalf("授权决定应带修订与摘要幂等键：%+v", api.accessDecided[0])
	}
	if model.chat.panel.pendingAccess["ap-1"].RequestID != firstRequestID {
		t.Fatalf("失败应保留未确认决定供重试：%+v", model.chat.panel.pendingAccess)
	}
	// 重试同卡：复用同 requestId 与原选择（2 修改为 session）。
	api.accessErr = nil
	model = pressKey(t, model, key("2"))
	retry := model.chat.panel.pendingAccess["ap-1"]
	decidedRetry, err := api.DecideAccess(nil, "ap-1", retry)
	model = feedMsg(t, model, approvalDecisionMsg{approval: decidedRetry, err: err})
	if len(api.accessDecided) != 2 {
		t.Fatal("重试应再次提交")
	}
	if got := api.accessDecided[1]; got.RequestID != firstRequestID || got.Decision != "session" {
		t.Fatalf("重试应复用幂等键并应用新选择：%+v", got)
	}
	if _, kept := model.chat.panel.pendingAccess["ap-1"]; kept {
		t.Fatal("成功后应清理未确认决定")
	}
}

func TestAuthorizationListAndRevoke(t *testing.T) {
	api := &fakeAPI{}
	api.approvals = []client.Approval{pendingApproval(false)}
	api.authorizations = []client.SessionAuthorization{{
		ID: "auth-1", SessionID: "s1", Revision: 5, Status: "allowed", Tool: "bash", CreatedAt: "2026-10-25T09:00:00.000Z",
		Access: client.AccessReq{Revision: 2, Digest: "d", Kind: "script"},
	}}
	model := driveToWaiting(t, api, approvalFrame())
	model = pressKey(t, model, tea.KeyMsg{Type: tea.KeyCtrlA})
	model = pressKey(t, model, tea.KeyMsg{Type: tea.KeyTab})
	model = runCmd(t, model, loadAuthorizationsCmd(api, "s1"))
	if view := model.View(); !strings.Contains(view, "bash") || !strings.Contains(view, "allowed") {
		t.Fatalf("授权列表应展示允许项：%q", view)
	}
	// r 撤回（幂等键与修订随请求提交）。
	model = sendKey(t, model, key("r"))
	if len(api.revoked) != 1 || api.revoked[0] != "auth-1" {
		t.Fatalf("r 应撤回光标授权：%v", api.revoked)
	}
	if len(model.chat.panel.auths) != 0 {
		t.Fatal("撤回成功应从列表移除")
	}
}

func TestInputWizardAnswerFlowIdempotent(t *testing.T) {
	api := &fakeAPI{}
	model := driveToWaiting(t, api, wizardFrame())
	if model.chat.wizard == nil {
		t.Fatal("waiting-input 应自动接管输入区")
	}
	view := model.View()
	if !strings.Contains(view, "第 1/2 题") || !strings.Contains(view, "★ 清理临时文件") {
		t.Fatalf("向导应展示题目与推荐标记（不预选）：%q", view)
	}
	if strings.Contains(view, "Placeholder") && strings.Contains(view, "输入消息") {
		t.Fatal("向导期间应隐藏消息输入框")
	}
	// 第一题选推荐项（★ 不预选：光标在第 0 项，Enter 即选）→ 第二题。
	model = pressKey(t, model, keyEnter)
	if model.chat.wizard.questionIdx != 1 {
		t.Fatalf("确认后应进入下一题：%d", model.chat.wizard.questionIdx)
	}
	// 第二题自定义文本。
	model = pressKey(t, model, key("t"))
	model = pressKey(t, model, key("十分钟后"))
	model = sendKey(t, model, keyEnter)
	if len(api.answerInputs) != 1 {
		t.Fatalf("最后一题确认应提交回答：%+v", api.answerInputs)
	}
	input := api.answerInputs[0]
	if input.RequestID == "" || input.Answers["q1"].OptionID != "opt-clean" || input.Answers["q2"].Text != "十分钟后" {
		t.Fatalf("答案载荷不符：%+v", input)
	}
	if model.chat.wizard != nil {
		t.Fatal("提交成功应关闭向导")
	}
}

func TestInputWizardCancelStopsRun(t *testing.T) {
	api := &fakeAPI{}
	model := driveToWaiting(t, api, wizardFrame())
	model = sendKey(t, model, keyEsc)
	if model.chat.wizard != nil {
		t.Fatal("Esc 应关闭向导")
	}
	// 取消＝停止本轮：fake 取消即时回 cancelled 终态（「正在停止」到终态收敛）。
	if model.chat.runStatus != "cancelled" {
		t.Fatalf("取消向导应停止本轮：%s", model.chat.runStatus)
	}
}

func TestInputWizardSubmitFailureRetriesSameRequestID(t *testing.T) {
	api := &fakeAPI{}
	api.answerErr = &client.Error{Kind: client.KindServer, Status: 409, Message: "回答已提交，冲突"}
	model := driveToWaiting(t, api, wizardFrame())
	model = pressKey(t, model, keyEnter) // 第一题确认
	model = sendKey(t, model, keyEnter)  // 第二题（默认选项）确认 → 提交（回填失败）
	if model.chat.wizard == nil || !strings.Contains(model.chat.wizard.err, "冲突") {
		t.Fatalf("失败应保留向导与服务端原因：%+v", model.chat.wizard)
	}
	api.answerErr = nil
	model = sendKey(t, model, keyEnter) // 重试（答案保留，同 requestId 幂等）
	if len(api.answerInputs) != 2 {
		t.Fatal("重试应再次提交")
	}
	if api.answerInputs[0].RequestID != api.answerInputs[1].RequestID {
		t.Fatalf("重试应复用同 requestId（幂等）：%q vs %q", api.answerInputs[0].RequestID, api.answerInputs[1].RequestID)
	}
}

func TestToolDetailLoadsCallsOnExpand(t *testing.T) {
	api := &fakeAPI{}
	frame := client.ChatOutput{RunID: "r-2", Done: false, Timeline: &client.ChatTimeline{RunID: "r-2", Status: "running",
		Entries: []client.TimelineEntry{{
			ID: "t1", Kind: "tool", Tool: "docker_ps", Status: "succeeded", CallID: "call-1", ArgumentsJSON: `{"all":true}`,
		}}}}
	api.callsPage = client.Page[client.Call]{Items: []client.Call{{ID: "call-1", RunID: "r-2", Tool: "docker_ps", Status: "succeeded", Result: []byte(`{"containers":3}`)}}}
	model := driveToWaiting(t, api, frame)
	model = pressKey(t, model, tea.KeyMsg{Type: tea.KeyCtrlO})
	if model.chat.tools == nil || len(model.chat.tools.entries) != 1 {
		t.Fatal("Ctrl+O 应打开工具详情")
	}
	model = sendKey(t, model, keyEnter) // 展开 → 触发 calls 加载（命令内联执行）。
	if model.chat.tools.calls["call-1"].ID != "call-1" {
		t.Fatalf("展开应加载执行结果：%+v", model.chat.tools.calls)
	}
	if view := model.View(); !strings.Contains(view, `{"containers":3}`) {
		t.Fatalf("详情应展示执行结果：%q", view)
	}
	model = pressKey(t, model, keyEsc) // 收起
	model = pressKey(t, model, keyEsc) // 关闭
	if model.chat.tools != nil {
		t.Fatal("Esc 应关闭工具详情")
	}
}

// —— 上下文用量状态栏文本（Web ChatUsageIndicator 的终端替代形态）——

// usageFrame 构造一帧带 contextUsage 的 timeline（total 为 nil 表示未报告）。
func usageFrame(total *int) client.ChatOutput {
	return client.ChatOutput{RunID: "r-2", Done: false, Timeline: &client.ChatTimeline{
		RunID: "r-2", Status: "running",
		ContextUsage: &client.ChatContextUsage{ModelRequestID: "mr-1", Model: "glm", TotalTokens: total, ContextTokens: 65536},
		Entries:      []client.TimelineEntry{},
	}}
}

func TestStatusBarShowsContextUsageText(t *testing.T) {
	api := &fakeAPI{}
	total := 12500
	model := driveToWaiting(t, api, usageFrame(&total))
	if view := model.View(); !strings.Contains(view, "上下文 12,500/65,536（19.1%）") {
		t.Fatalf("状态栏应显示 timeline.contextUsage 用量文本：%q", view)
	}
}

// 空间不足时先压缩模型段：标题与尾部事实段（含上下文用量）保真。
func TestStatusBarCompressesModelBeforeTailFacts(t *testing.T) {
	api := &fakeAPI{}
	total := 12500
	model := driveToWaiting(t, api, usageFrame(&total))
	model = step(t, model, tea.WindowSizeMsg{Width: 90, Height: 30})
	view := model.View()
	if !strings.Contains(view, "上下文 12,500/65,536（19.1%）") {
		t.Fatalf("压缩模型段后上下文用量应保真：%q", view)
	}
	if !strings.Contains(view, "巡检") {
		t.Fatalf("会话标题应保留：%q", view)
	}
	if strings.Contains(view, "带档位 · p1@1") || !strings.Contains(view, "带档位") {
		t.Fatalf("超预算时模型段应压缩显示：%q", view)
	}
}

func TestStatusBarContextUsageUnreportedKeptUnknown(t *testing.T) {
	api := &fakeAPI{}
	model := driveToWaiting(t, api, usageFrame(nil))
	view := model.View()
	if !strings.Contains(view, "上下文 未报告/65,536") {
		t.Fatalf("未报告 totalTokens 应如实标注不补零：%q", view)
	}
	if label := contextUsageLabel(model.chat.timeline); strings.Contains(label, "（") {
		t.Fatalf("未报告时不应计算占比：%q", label)
	}
}

// 流断连期间轮询快照兜底推进状态栏用量（无 timeline 帧时不显示用量文本）。
func TestPollTimelineFeedsUsageWhenStreamDown(t *testing.T) {
	api := &fakeAPI{}
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", Status: "running"}
	api.streamFrames = nil // 无帧：连接立即结束（interrupted 事件）。
	total := 48000
	api.timeline = &client.ChatTimeline{RunID: "r-2", Status: "running",
		ContextUsage: &client.ChatContextUsage{ModelRequestID: "mr-2", Model: "glm", TotalTokens: &total, ContextTokens: 65536},
		Entries:      []client.TimelineEntry{}}
	model := chatReady(t, api, []client.Session{{ID: "s1", Title: "巡检", ModelProfileID: "p1", ModelRevision: 1}}, pickerModels())
	model = step(t, model, key("问"))
	model = sendKey(t, model, keyEnter)
	model = listenFrames(t, model, 1) // interrupted：流断连。
	if view := model.View(); strings.Contains(view, "上下文") {
		t.Fatalf("无 timeline 快照时不应显示用量：%q", view)
	}
	model = runCmd(t, model, pollRunCmd(api, "s1", model.chat.runID, 0))
	if view := model.View(); !strings.Contains(view, "上下文 48,000/65,536（73.2%）") {
		t.Fatalf("轮询快照应兜底驱动用量文本：%q", view)
	}
}

// —— 前两步遗留测试补齐 ——

func TestPickerShowsLoadingModelsState(t *testing.T) {
	api := &fakeAPI{}
	model := bootReady(t, api, nil, nil)
	model.list.modelsPending = true // 模型目录仍在途。
	model = pressKey(t, model, key("n"))
	model = pressKey(t, model, keyEnter)
	if view := model.View(); !strings.Contains(view, "正在读取模型目录") {
		t.Fatalf("加载中应如实提示而非误报无模型：%q", view)
	}
}

func TestSessionListLoadMore(t *testing.T) {
	api := &fakeAPI{}
	sessions := make([]client.Session, 0, 2)
	sessions = append(sessions, client.Session{ID: "s1", Title: "一", ModelProfileID: "p1", ModelRevision: 1})
	model := bootReady(t, api, sessions, nil)
	// fake 的 ListSessionsByActivity 单页全量：以 listState 追加逻辑驱动。
	model.list.hasMore = true
	model.list.nextCursor = "s1"
	api.sessions = append(api.sessions, client.Session{ID: "s2", Title: "二", ModelProfileID: "p1", ModelRevision: 1})
	model = pressKey(t, model, key("l"))
	model = runCmd(t, model, loadSessionsCmd(api, "s1"))
	if len(model.list.sessions) != 2 || model.list.sessions[1].ID != "s2" {
		t.Fatalf("l 应加载更多并追加：%+v", model.list.sessions)
	}
	if got := model.View(); !strings.Contains(got, "二") {
		t.Fatalf("追加会话应立即可见：%q", got)
	}
}

func TestLoginScreenRateLimitShowsRetrySeconds(t *testing.T) {
	api := &fakeAPI{loginErr: &client.Error{Kind: client.KindServer, Status: 429, Message: "登录尝试过于频繁，请稍后再试", RetryAfter: 37}}
	deps := &fakeDeps{api: api, discover: okDiscover}
	model := New(deps.deps())
	model = runCmd(t, model, model.Init())
	model = pressKey(t, model, keyTab)
	model = pressKey(t, model, key("x"))
	model = sendKey(t, model, keyEnter)
	if !strings.Contains(model.login.error, "37 秒") {
		t.Fatalf("429 应提示等待秒数：%q", model.login.error)
	}
}
