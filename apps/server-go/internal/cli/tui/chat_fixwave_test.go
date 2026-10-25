package tui

import (
	"context"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/cli/client"
)

// 第二波修复回归测试：思考档清值与按模型核验（#6）、向导文本模式吞字符（#7）、
// 已完成会话的过程快照恢复（#8）、流退订取消在途 HTTP（#10）、审批面板取消卡死
// （#14）。用例形态沿用 review_regression_test.go 的注入法。

func fixwaveModel(t *testing.T) (Model, *fakeAPI) {
	t.Helper()
	api := &fakeAPI{}
	m := chatReady(t, api, []client.Session{{ID: "s1", Title: "review", ModelProfileID: "p1", ModelRevision: 1}}, pickerModels())
	return m, api
}

func TestFixModelWithoutReasoningClearsOldLevel(t *testing.T) {
	m, _ := fixwaveModel(t)
	m.levels["s1"] = "max"
	target := client.Session{ID: "s1", ModelProfileID: "p2", ModelRevision: 2}
	m = feedMsg(t, m, modelSwitchedMsg{session: target, level: ""})
	if _, ok := m.levels["s1"]; ok {
		t.Fatalf("未声明档位的模型未清除旧档选择：%q", m.levels["s1"])
	}
	if level := m.currentLevel(target); level != "" {
		t.Fatalf("无档位模型应返回空档：%q", level)
	}
}

func TestFixCurrentLevelValidatedAgainstCurrentModel(t *testing.T) {
	m, _ := fixwaveModel(t)
	// 旧档选择不属于当前模型声明档位表（如目录修订后档位更名）：按声明默认档回落。
	m.levels["s1"] = "ultra"
	session := client.Session{ID: "s1", ModelProfileID: "p1", ModelRevision: 1}
	if level := m.currentLevel(session); level != "max" {
		t.Fatalf("失配旧档应回落声明默认档 max：%q", level)
	}
	m.levels["s1"] = "high"
	if level := m.currentLevel(session); level != "high" {
		t.Fatalf("声明档位内的本地选择应保留：%q", level)
	}
}

func TestFixSameModelSelectionAdjustsLevelWithoutSwitching(t *testing.T) {
	m, api := fixwaveModel(t)
	// 切换模式选中当前模型且声明档位：进入档位调整步，不经 SwitchSessionModel。
	m.phase = phasePicker
	m.picker = newPickerState(pickerSwitch, pickerModels(), "s1")
	m = pressKey(t, m, keyEnter) // 光标停在 p1（当前模型）
	if m.picker.step != stepLevel {
		t.Fatalf("同模型声明档位应进入档位调整步：%d", m.picker.step)
	}
	before := api.switchInput
	m = sendKey(t, m, key("k"))
	m = sendKey(t, m, key("k")) // 默认 max（索引 2）上移两格到 low
	m = pressKey(t, m, keyEnter)
	if m.levels["s1"] != "low" {
		t.Fatalf("同模型调整未更新本地档位：%q", m.levels["s1"])
	}
	if api.switchInput != before {
		t.Fatal("同模型调整不应触发服务端模型切换")
	}
	if m.phase != phaseSessions || m.notice != "思考档位已调整" {
		t.Fatalf("调整后应回列表并提示：%+v", m.notice)
	}
}

func TestFixCustomAnswerAcceptsShortcutLetters(t *testing.T) {
	m, _ := fixwaveModel(t)
	m.chat.wizard = newInputWizard(client.UserInputRequest{ID: "q", Questions: []client.UserInputQuestion{{ID: "q1", Options: []client.UserInputOption{{ID: "yes", Label: "yes"}}}}})
	m.chat.wizard.textMode = true
	for _, r := range "hello test" {
		m = pressKey(t, m, key(string(r)))
	}
	if m.chat.wizard.textEditor.text() != "hello test" {
		t.Fatalf("自定义回答被快捷键吞字：%q textMode=%v", m.chat.wizard.textEditor.text(), m.chat.wizard.textMode)
	}
}

func TestFixCustomAnswerEscReturnsToOptions(t *testing.T) {
	m, api := fixwaveModel(t)
	api.cancelErr = context.DeadlineExceeded // 若误触取消本轮，.notice 会变为「停止失败」
	m.chat.wizard = newInputWizard(client.UserInputRequest{ID: "q", Questions: []client.UserInputQuestion{{ID: "q1", Options: []client.UserInputOption{{ID: "yes", Label: "yes"}}}}})
	m.chat.wizard.textMode = true
	m.chat.runID, m.chat.runStatus = "r", "running"
	m = pressKey(t, m, keyEsc)
	if m.chat.wizard == nil || m.chat.wizard.textMode {
		t.Fatalf("文本模式 Esc 应回到选项模式：wizard=%v", m.chat.wizard)
	}
	if m.notice != "" {
		t.Fatalf("文本模式 Esc 不应取消本轮：%q", m.notice)
	}
}

func TestFixReloadsFinishedRunDetails(t *testing.T) {
	m, api := fixwaveModel(t)
	api.tasks = []client.Task{{ID: "t1", Kind: "agent", LatestRun: &client.Run{ID: "finished-run", Status: "succeeded"}}}
	api.timeline = &client.ChatTimeline{Status: "succeeded", Entries: []client.TimelineEntry{{Kind: "tool"}}}
	m = runCmd(t, m, loadChatCmd(api, "s1"))
	if m.chat.runID != "finished-run" || m.chat.runStatus != "succeeded" || m.chat.timeline == nil {
		t.Fatalf("重入已完成会话未恢复执行详情：runID=%q status=%q timeline=%v", m.chat.runID, m.chat.runStatus, m.chat.timeline)
	}
	if m.chat.polling || m.sub != nil {
		t.Fatalf("终态 Run 不应接流或轮询：polling=%v sub=%v", m.chat.polling, m.sub)
	}
	m = pressKey(t, m, key("ctrl+o"))
	if m.chat.tools == nil || len(m.chat.tools.entries) == 0 {
		t.Fatal("Ctrl+O 未从回读快照构建工具详情")
	}
}

type fixwaveBlockingStream struct {
	*fakeAPI
	started chan struct{}
	stopped chan struct{}
	force   chan struct{}
}

func (a *fixwaveBlockingStream) StreamChatOutput(ctx context.Context, _ string, _ func(client.ChatOutput) error) error {
	close(a.started)
	defer close(a.stopped)
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-a.force:
		return nil
	}
}

func TestFixUnsubscribeCancelsHTTPRequest(t *testing.T) {
	a := &fixwaveBlockingStream{fakeAPI: &fakeAPI{}, started: make(chan struct{}), stopped: make(chan struct{}), force: make(chan struct{})}
	s := openStream(a, "r")
	<-a.started
	s.close()
	defer close(a.force)
	select {
	case <-a.stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("退订后未取消在途 HTTP 请求的 context")
	}
}

func TestFixCancelFromApprovalPanelClosesOnTerminal(t *testing.T) {
	m, _ := fixwaveModel(t)
	m.chat.runID, m.chat.runStatus = "r", "waiting-approval"
	m.chat.panel = newApprovalPanel(map[string]client.AccessDecisionInput{})
	m.chat.panel.approvals = []client.Approval{pendingApproval(false)}
	m = pressKey(t, m, key("x"))
	m = feedMsg(t, m, cancelMsg{runID: "r", run: client.Run{ID: "r", Status: "cancelled"}})
	m = pressKey(t, m, keyEsc)
	if m.chat.panel != nil {
		t.Fatalf("终态回填后审批面板应已关闭：%+v", m.chat.panel)
	}
}

func TestFixCancelFromApprovalPanelFailureUnlocks(t *testing.T) {
	m, _ := fixwaveModel(t)
	m.chat.runID, m.chat.runStatus = "r", "waiting-approval"
	m.chat.panel = newApprovalPanel(map[string]client.AccessDecisionInput{})
	m.chat.panel.approvals = []client.Approval{pendingApproval(false)}
	m = pressKey(t, m, key("x"))
	if !m.chat.panel.busy {
		t.Fatal("取消在途应置 busy")
	}
	m = feedMsg(t, m, cancelMsg{runID: "r", err: context.DeadlineExceeded})
	if m.chat.panel == nil {
		t.Fatal("失败回填不应关闭面板")
	}
	if m.chat.panel.busy {
		t.Fatal("失败回填应解除 busy（busy 时面板按键全挡，不解锁即卡死）")
	}
	if !strings.Contains(m.chat.panel.err, "取消未确认") {
		t.Fatalf("失败应保留可重试反馈：%q", m.chat.panel.err)
	}
	m = pressKey(t, m, keyEsc)
	if m.chat.panel != nil {
		t.Fatal("解除 busy 后 Esc 应能关闭面板")
	}
}

// —— 上下文用量完整展示（状态栏累计／缓存段＋Ctrl+O 分类明细） ——

func usageTimeline() *client.ChatTimeline {
	total, tokens := 12500, 40000
	return &client.ChatTimeline{
		RunID: "r-2", Status: "running",
		ContextUsage: &client.ChatContextUsage{
			ModelRequestID: "mr-1", Model: "glm", TotalTokens: &total, ContextTokens: 65536,
			EstimatedBreakdown: &client.ChatContextBreakdown{Messages: 3000, SystemTools: 800, Skills: 400, SystemPrompt: 1200, MCPTools: 150},
		},
		Usage:         &client.ChatRunUsage{Tokens: tokens, ActualTokens: &tokens},
		CacheHitUsage: &client.ChatCacheHitUsage{InputTokens: 4000, CachedTokens: 1000},
		Entries:       []client.TimelineEntry{},
	}
}

func TestFixUsageStatusBarShowsCumulativeAndCacheHit(t *testing.T) {
	m, _ := fixwaveModel(t)
	m.chat.timeline = usageTimeline()
	label := contextUsageLabel(m.chat.timeline)
	for _, want := range []string{"上下文 12,500/65,536（19.1%）", "累计 40,000", "缓存 1,000/4,000（25%）"} {
		if !strings.Contains(label, want) {
			t.Fatalf("状态栏用量文本缺段 %q：%q", want, label)
		}
	}
}

func TestFixUsageSegmentsOmittedWhenUnreported(t *testing.T) {
	timeline := usageTimeline()
	timeline.Usage = &client.ChatRunUsage{}
	timeline.CacheHitUsage = nil
	label := contextUsageLabel(timeline)
	if strings.Contains(label, "累计") || strings.Contains(label, "缓存") {
		t.Fatalf("未报告的累计／缓存不得补零展示：%q", label)
	}
}

func TestFixUsageDetailOverlayShowsBreakdown(t *testing.T) {
	m, _ := fixwaveModel(t)
	m.chat.timeline = usageTimeline()
	m = pressKey(t, m, key("ctrl+o"))
	if m.chat.tools == nil {
		t.Fatal("Ctrl+O 应打开详情覆盖层")
	}
	view := m.View()
	for _, want := range []string{"上下文用量", "模型 glm", "单次推理 12,500/65,536（19.1%）", "本轮累计 40,000 token", "平均缓存命中 1,000/4,000（25%）", "分类占用（本地估算）", "系统提示词 1,200"} {
		if !strings.Contains(view, want) {
			t.Fatalf("执行详情缺段 %q", want)
		}
	}
}
