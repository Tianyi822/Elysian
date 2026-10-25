package tui

import (
	"strings"
	"testing"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

// 权限模式能力测试（CLI 方案 §6.2／§6.3）：Shift+Tab 循环切换 ask→assist→full→ask、
// 状态栏中文标签、随轮提交（缺省 ask）、发送在途与运行中锁定、失败重试冻结首次
// 模式（幂等键与载荷同生命周期）与本地持久化回读。

var keyShiftTab = tea.KeyMsg{Type: tea.KeyShiftTab}

func chatSessions() []client.Session {
	return []client.Session{{ID: "s1", Title: "巡检", ModelProfileID: "p1", ModelRevision: 1}}
}

func TestPermissionModeCyclesInStatusBar(t *testing.T) {
	api := &fakeAPI{messages: chatMessages()}
	model := chatReady(t, api, chatSessions(), pickerModels())
	if view := model.View(); !strings.Contains(view, "权限 请求批准") {
		t.Fatalf("缺省权限模式应显示 ask 标签：%q", view)
	}
	model = pressKey(t, model, keyShiftTab)
	if view := model.View(); !strings.Contains(view, "权限 帮我批准") {
		t.Fatalf("第一次切换应到 assist：%q", view)
	}
	model = pressKey(t, model, keyShiftTab)
	if view := model.View(); !strings.Contains(view, "权限 完全开放") {
		t.Fatalf("第二次切换应到 full：%q", view)
	}
	model = pressKey(t, model, keyShiftTab)
	if view := model.View(); !strings.Contains(view, "权限 请求批准") {
		t.Fatalf("第三次切换应回到 ask（循环）：%q", view)
	}
}

func TestPermissionModeLockedWhileRunning(t *testing.T) {
	api := &fakeAPI{}
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", Status: "running"}
	api.streamFrames = []client.ChatOutput{{RunID: "r-2", Content: "答到一半", Done: false}}
	model := chatReady(t, api, chatSessions(), nil)
	model = step(t, model, key("问"))
	model = sendKey(t, model, keyEnter)
	model = listenFrames(t, model, 1)
	model = sendKey(t, model, keyShiftTab)
	if !strings.Contains(model.notice, "会话忙：当前运行结束后再切换权限模式") {
		t.Fatalf("运行中切换应锁定并提示：%q", model.notice)
	}
	if view := model.View(); !strings.Contains(view, "权限 请求批准") {
		t.Fatalf("锁定期间模式应保持 ask：%q", view)
	}
	if got := api.submittedInputs[0].PermissionMode; got != client.PermissionAsk {
		t.Fatalf("缺省提交应为 ask：%q", got)
	}
}

func TestSendCarriesSelectedPermissionMode(t *testing.T) {
	api := &fakeAPI{}
	api.nextRun = client.Run{ID: "r-2", TaskID: "t-1", Status: "running"}
	model := chatReady(t, api, chatSessions(), nil)
	model = pressKey(t, model, keyShiftTab) // assist
	model = pressKey(t, model, keyShiftTab) // full
	model = step(t, model, key("部署前检查"))
	model = sendKey(t, model, keyEnter)
	if got := api.submittedInputs[0].PermissionMode; got != client.PermissionFull {
		t.Fatalf("本地选择 full 应随轮提交：%q", got)
	}
}

func TestPendingRetryFreezesPermissionMode(t *testing.T) {
	api := &fakeAPI{}
	api.createTaskErr = &client.Error{Kind: client.KindServer, Status: 409, Message: "会话已有运行中的任务", Code: "session-busy"}
	model := chatReady(t, api, chatSessions(), nil)
	model = step(t, model, key("第一轮"))
	model = sendKey(t, model, keyEnter) // 失败：保留输入与 pending。
	if model.chat.pending == nil {
		t.Fatal("失败应保留 pending 供幂等重试")
	}
	model = pressKey(t, model, keyShiftTab) // 本地切到 assist，不改写已冻结载荷。
	api.createTaskErr = nil
	api.nextRun = client.Run{ID: "r-3", TaskID: "t-9", Status: "running"}
	model = sendKey(t, model, keyEnter) // 同输入重试。
	if len(api.submittedInputs) != 2 {
		t.Fatalf("重试应再次提交：%+v", api.submittedInputs)
	}
	first, second := api.submittedInputs[0], api.submittedInputs[1]
	if second.RequestID != first.RequestID {
		t.Fatalf("重试应复用同 requestId：%q vs %q", first.RequestID, second.RequestID)
	}
	if first.PermissionMode != client.PermissionAsk || second.PermissionMode != client.PermissionAsk {
		t.Fatalf("重试应复用首次冻结的权限模式：%+v %+v", first, second)
	}
}

func TestPermissionModePersistsAcrossRestart(t *testing.T) {
	api := &fakeAPI{messages: chatMessages()}
	deps := &fakeDeps{api: api, discover: okDiscover}
	model := bootReadyWithDeps(t, deps, api, chatSessions(), pickerModels())
	model = step(t, model, keyEnter)
	model = runCmd(t, model, loadChatCmd(api, "s1"))
	model = pressKey(t, model, keyShiftTab) // assist
	model = runCmd(t, model, saveStateCmd(model))
	if len(deps.savedStates) == 0 {
		t.Fatal("切换权限模式应触发本地持久化")
	}
	saved := deps.savedStates[len(deps.savedStates)-1]
	if saved.PermissionModes["s1"] != client.PermissionAssist {
		t.Fatalf("持久化应记录会话权限模式：%+v", saved.PermissionModes)
	}
	// 模拟重启：按保存状态回读。
	restart := &fakeDeps{api: api, discover: okDiscover, loadState: func() StoredState { return saved }}
	model = bootReadyWithDeps(t, restart, api, chatSessions(), pickerModels())
	model = step(t, model, keyEnter)
	model = runCmd(t, model, loadChatCmd(api, "s1"))
	if view := model.View(); !strings.Contains(view, "权限 帮我批准") {
		t.Fatalf("重启后应恢复会话权限模式选择：%q", view)
	}
}
