package tui

import (
	"elysian/server/internal/cli/client"
	"errors"
	tea "github.com/charmbracelet/bubbletea"
	"reflect"
	"strings"
	"testing"
)

func TestSaveFailureBlocksDispatchAndExactRetryPreservesDraft(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.editor.SetValue("原请求")
	m.deps.SaveState = func(StoredState) error { return errors.New("磁盘写入失败") }
	next, cmd := m.sendCurrent()
	m = next.(Model)
	if cmd != nil || m.chat.sending || m.chat.pending == nil {
		t.Fatal("写盘失败仍派发或丢请求")
	}
	original := m.chat.pending.request()
	m.chat.editor.SetValue("独立新草稿")
	m.deps.SaveState = func(StoredState) error { return nil }
	next, cmd = m.sendCurrent()
	m = next.(Model)
	reply := cmd().(submitMsg)
	if len(api.submittedInputs) != 1 || !reflect.DeepEqual(api.submittedInputs[0], original) {
		t.Fatalf("重试改写请求：%+v", api.submittedInputs)
	}
	m = feedMsg(t, m, reply)
	if m.chat.editor.Value() != "独立新草稿" {
		t.Fatal("受理误清独立草稿")
	}
}
func TestEditDraftAndAttachmentsAreIndependent(t *testing.T) {
	m := regressionChatReady(t, &fakeAPI{})
	m.chat.messages = []client.Message{{ID: "last", TaskID: "original-task", Role: "user", Content: "原文"}}
	m.chat.editor.SetValue("普通草稿")
	m.chat.attachments = []client.MessageAttachment{{ID: "normal"}}
	next, _ := m.beginEdit()
	m = next.(Model)
	m.chat.editor.SetValue("修订内容")
	m.chat.editing.Attachments = []client.MessageAttachment{{ID: "edit"}}
	m = pressKey(t, m, keyEsc)
	if m.chat.editor.Value() != "普通草稿" || m.chat.editing != nil {
		t.Fatal("Esc 未恢复普通草稿")
	}
	next, _ = m.beginEdit()
	m = next.(Model)
	if m.chat.editor.Value() != "修订内容" {
		t.Fatal("编辑草稿丢失")
	}
	next, _ = m.sendCurrent()
	m = next.(Model)
	p := m.chat.pending
	if p.taskID != "original-task" || p.request().ReplaceMessageID != "last" || p.request().Attachments[0].ID != "edit" {
		t.Fatalf("重发目标不正确：%+v", p.request())
	}
	m.confirmPending(client.Run{RequestID: p.requestID, SessionID: "s1", TaskID: p.taskID})
	if m.chat.editor.Value() != "普通草稿" || m.chat.attachments[0].ID != "normal" {
		t.Fatal("重发误清普通草稿附件")
	}
}
func TestViewEpochRejectsSameSessionReentryAndOldLogin(t *testing.T) {
	m := regressionChatReady(t, &fakeAPI{})
	old := scopedMsg{scope: replyScope{epoch: m.epoch, auth: m.authEpoch}, msg: chatLoadedMsg{sessionID: "s1", session: &client.Session{ID: "s1", Title: "迟到"}}}
	next, _ := m.enterChat("s1")
	m = next.(Model)
	m = feedMsg(t, m, old)
	if m.chat.session != nil {
		t.Fatal("同会话重入接受旧结果")
	}
	m.handleUnauthorized("退出")
	m = feedMsg(t, m, old)
	if m.phase != phaseLogin || m.chat.session != nil {
		t.Fatal("登出后回灌")
	}
}
func TestExternalTextCannotExecuteTerminalControls(t *testing.T) {
	got := safeText("前\x1b]52;c;YXR0YWNr\a后\x1b[2J\r\x00")
	if got != "前后" {
		t.Fatalf("控制序列未过滤：%q", got)
	}
	wrapped := wrapPlain(strings.Repeat("👨‍👩‍👧‍👦中é", 6), 10)
	if !strings.Contains(wrapped, "👨‍👩‍👧‍👦") {
		t.Fatal("组合字符被拆开")
	}
}
func TestCtrlCExitsWholeCLIWithoutCancellingRun(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.runStatus = "running"
	m.chat.runID = "r1"
	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyCtrlC})
	m = next.(Model)
	if !m.exitAll || cmd == nil {
		t.Fatal("Ctrl+C 未退出")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("非退出命令")
	}
	if m.life.ctx.Err() == nil {
		t.Fatal("退出未取消根上下文")
	}
}

func TestEditReceiptPreservesLaterChangesAndRebasesOnServerMessage(t *testing.T) {
	m := regressionChatReady(t, &fakeAPI{})
	m.chat.messages = []client.Message{{ID: "old", TaskID: "task", Role: "user", Content: "旧内容"}}
	m.chat.editor.SetValue("普通草稿")
	next, _ := m.beginEdit()
	m = next.(Model)
	m.chat.editor.SetValue("第一次修订")
	next, _ = m.sendCurrent()
	m = next.(Model)
	p := m.chat.pending
	m.chat.editor.SetValue("继续修订")
	m.chat.draftRevision++
	m.confirmPending(client.Run{ID: "accepted", RequestID: p.requestID, SessionID: "s1", TaskID: "task"})
	if m.chat.editor.Value() != "普通草稿" || m.locals["s1"].Editing.Content != "继续修订" {
		t.Fatal("回执清除了独立草稿")
	}
	m.chat.sending = false
	m.chat.messages = []client.Message{{ID: "new", RunID: "accepted", TaskID: "task", Role: "user", Content: "第一次修订"}}
	next, _ = m.beginEdit()
	m = next.(Model)
	if m.chat.editor.Value() != "继续修订" || m.chat.editing.MessageID != "new" {
		t.Fatal("保留草稿未绑定新服务端消息")
	}
}

func TestUsageWithoutContextPreservesActualZeroAndUnknown(t *testing.T) {
	zero := 0
	timeline := &client.ChatTimeline{Usage: &client.ChatRunUsage{Tokens: 999, ActualTokens: &zero, CachedTokens: &zero}}
	label := contextUsageLabel(timeline)
	detail := renderContextUsageDetail(&chatState{timeline: timeline}, Model{}, 100)
	if !strings.Contains(label, "累计 0") || !strings.Contains(detail, "缓存 token 0") || strings.Contains(detail, "999") {
		t.Fatalf("零值/预算语义错误：%s %s", label, detail)
	}
	timeline.Usage.ActualTokens = nil
	if strings.Contains(contextUsageLabel(timeline), "累计 0") {
		t.Fatal("未知实际用量补零")
	}
}

func TestAdditionalReadFailuresReturnToLogin(t *testing.T) {
	for _, kind := range []string{"history", "attachment", "pending", "public"} {
		t.Run(kind, func(t *testing.T) {
			m := regressionChatReady(t, &fakeAPI{})
			m.chat.editor.SetValue("保留草稿")
			err := &client.Error{Kind: client.KindUnauthorized, Status: 401, Message: "需要登录"}
			var msg tea.Msg
			switch kind {
			case "history":
				next, _ := m.openHistory()
				m = next.(Model)
				msg = historyLoadedMsg{err: err}
			case "attachment":
				next, _ := m.openAttachments()
				m = next.(Model)
				msg = attachmentDoneMsg{err: err}
			case "pending":
				m.chat.pending = &pendingSend{requestID: "req"}
				msg = pendingResolvedMsg{sessionID: "s1", requestID: "req", err: err}
			case "public":
				msg = publicReloadMsg{sessionID: "s1", err: err}
			}
			m = feedMsg(t, m, msg)
			if m.phase != phaseLogin || m.chat.sessionID != "" || m.locals["s1"].Draft != "保留草稿" {
				t.Fatal("401 未清展示并保留草稿")
			}
		})
	}
}

func TestHelpAvailableOutsideChatAndScrolls(t *testing.T) {
	m := regressionChatReady(t, &fakeAPI{})
	m.phase = phaseLogin
	m.width, m.height = 60, 12
	m.login = newLoginState()
	m = pressKey(t, m, tea.KeyMsg{Type: tea.KeyF1})
	if !m.help || !strings.Contains(m.View(), "F1 帮助") {
		t.Fatal("登录页不能打开帮助")
	}
	m = pressKey(t, m, tea.KeyMsg{Type: tea.KeyPgDown})
	if m.helpViewport.YOffset == 0 {
		t.Fatal("帮助不能滚动")
	}
	m = pressKey(t, m, keyEsc)
	if m.help || m.phase != phaseLogin {
		t.Fatal("关闭帮助改变原页面")
	}
}

func TestOverlayRepliesFromPreviousRunAreDiscarded(t *testing.T) {
	late := errors.New("旧运行的错误")
	for _, msg := range []tea.Msg{approvalDecisionMsg{err: late}, userInputAnswerMsg{err: late}, callsMsg{err: late}} {
		m := regressionChatReady(t, &fakeAPI{})
		m.chat.runID = "current"
		m.chat.panel = newApprovalPanel(map[string]client.AccessDecisionInput{})
		m.chat.wizard = &inputWizard{}
		m.chat.tools = &toolDetail{}
		scope := replyScope{epoch: m.epoch, auth: m.authEpoch, runID: "old", panel: m.chat.panel, wizard: m.chat.wizard, tools: m.chat.tools}
		next, cmd := m.Update(scopedMsg{scope: scope, msg: msg})
		m = next.(Model)
		if cmd != nil || m.chat.panel.err != "" || m.chat.wizard.err != "" || m.chat.tools.err != "" || m.notice != "" {
			t.Fatalf("旧 Run 回执回灌：%T", msg)
		}
	}
}
