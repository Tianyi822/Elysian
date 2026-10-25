package tui

import (
	"context"
	"encoding/json"
	"errors"
	"runtime"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

func TestRecheckPendingDurableBeforeDispatch(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	var durable []byte
	m.deps.SaveState = func(s StoredState) error {
		var err error
		durable, err = json.Marshal(s)
		return err
	}
	m.chat.editor.SetValue("执行一个操作")
	_, cmd := m.sendCurrent()
	if cmd == nil {
		t.Fatal("缺少发送命令")
	}
	_ = cmd()
	if len(api.submittedInputs) != 1 {
		t.Fatalf("未派发请求：%+v", api.submittedInputs)
	}
	if len(durable) == 0 {
		t.Fatal("请求已经派发，但没有调用 SaveState；异常退出会丢失 requestId")
	}
}

func TestRecheckEqualTextCannotConfirmPending(t *testing.T) {
	for _, draft := range []string{"继续", "还没发送的新草稿"} {
		t.Run(draft, func(t *testing.T) {
			m := regressionChatReady(t, &fakeAPI{})
			m.chat.pending = &pendingSend{requestID: "tui-unaccepted", content: "继续", afterSeq: "9"}
			m.chat.editor.SetValue(draft)
			// 另一个客户端发送同文消息，不能确认 tui-unaccepted。
			m.chat.messages = []client.Message{{ID: "web-message", RunID: "web-run", Role: "user", Content: "继续", Seq: "10"}}
			m.settleRestoredPending()
			if m.chat.pending == nil || m.chat.editor.Value() != draft {
				t.Fatalf("同文消息误清本地状态：pending=%+v draft=%q", m.chat.pending, m.chat.editor.Value())
			}
		})
	}
}

type recheckTaskFailureAPI struct{ *fakeAPI }

func (a *recheckTaskFailureAPI) ListSessionTasksPage(context.Context, string, string) (client.Page[client.Task], error) {
	return client.Page[client.Task]{}, errors.New("任务列表暂时不可用")
}

func TestRecheckTaskLoadFailureMustBlockSubmit(t *testing.T) {
	base := &fakeAPI{}
	m := regressionChatReady(t, base)
	m.api = &recheckTaskFailureAPI{base}
	m.chat.loading = true
	m = feedMsg(t, m, loadChatCmd(m.api, "s1")())
	m.chat.editor.SetValue("继续之前的任务")
	_, cmd := m.sendCurrent()
	if cmd != nil {
		_ = cmd()
	}
	if len(base.submittedInputs) != 0 || m.chat.loadErr == "" {
		t.Fatalf("任务读取失败仍允许创建新任务：loadErr=%q taskID=%q dispatched=%d", m.chat.loadErr, m.chat.taskID, len(base.submittedInputs))
	}
}

func TestRecheckTerminalReasoningRestored(t *testing.T) {
	api := &fakeAPI{
		tasks:    []client.Task{{ID: "t1", Kind: "agent", LatestRun: &client.Run{ID: "r1", Status: "succeeded"}}},
		timeline: &client.ChatTimeline{RunID: "r1", Status: "succeeded", Done: true, Entries: []client.TimelineEntry{{ID: "reason1", Kind: "reasoning", Text: "可以恢复的历史思考"}}},
	}
	m := regressionChatReady(t, api)
	m = pressKey(t, m, tea.KeyMsg{Type: tea.KeyCtrlT})
	var details strings.Builder
	m.chat.tools = &toolDetail{entries: toolEntries(m.chat.timeline.Entries)}
	m.chat.renderToolDetail(&details, m)
	if !strings.Contains(m.chat.renderContent(m)+details.String(), "可以恢复的历史思考") {
		t.Fatal("终态 timeline 已读取，但聊天展开和执行详情均不显示历史思考")
	}
}

func TestRecheckStaleAuthorizationsCannotPopulateOtherSession(t *testing.T) {
	api := &fakeAPI{authorizations: []client.SessionAuthorization{{ID: "auth-a", SessionID: "s1", Status: "allowed"}}}
	m := regressionChatReady(t, api)
	m.chat.panel = newApprovalPanel(map[string]client.AccessDecisionInput{})
	oldReply := loadAuthorizationsCmd(api, "s1")()
	m = pressKey(t, m, keyEsc) // 关面板
	m = pressKey(t, m, keyEsc) // 返回列表
	next, _ := m.enterChat("s2")
	m = next.(Model)
	m.chat.panel = newApprovalPanel(map[string]client.AccessDecisionInput{})
	m = feedMsg(t, m, oldReply)
	if len(m.chat.panel.auths) != 0 {
		t.Fatalf("s1 授权迟到回填到 s2 面板：%+v", m.chat.panel.auths)
	}
}

func TestRecheckLateLoadMustRespectEsc(t *testing.T) {
	api := &fakeAPI{}
	m := regressionChatReady(t, api)
	m.chat.loading = true
	lateReply := loadChatCmd(api, "s1")()
	m = pressKey(t, m, keyEsc)
	if m.phase != phaseSessions {
		t.Fatal("Esc 未返回列表")
	}
	m = feedMsg(t, m, lateReply)
	if m.phase != phaseSessions {
		t.Fatalf("迟到加载回填把用户送回聊天：phase=%d", m.phase)
	}
}

type recheckStreamAPI struct {
	*fakeAPI
	started chan context.Context
	release chan struct{}
}

func (a *recheckStreamAPI) StreamChatOutput(ctx context.Context, _ string, onOutput func(client.ChatOutput) error) error {
	a.started <- ctx
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-a.release:
	}
	return onOutput(client.ChatOutput{Done: true})
}

func TestRecheckImmediateUnsubscribeCancelsHTTP(t *testing.T) {
	old := runtime.GOMAXPROCS(1)
	defer runtime.GOMAXPROCS(old)
	api := &recheckStreamAPI{fakeAPI: &fakeAPI{}, started: make(chan context.Context, 1), release: make(chan struct{})}
	defer close(api.release)
	sub := openStream(api, "run1")
	sub.close() // goroutine 尚未安装 cancel 的退订路径
	select {
	case ctx := <-api.started:
		if ctx.Err() == nil {
			t.Fatal("已退订后仍启动了未取消的 HTTP context")
		}
	case <-time.After(time.Second):
		// 未启动请求也是有效的收敛。
	}
}

func TestRecheckUsageMustUseActualTokens(t *testing.T) {
	for _, tc := range []struct {
		name   string
		actual *int
		want   string
	}{
		{name: "actual", actual: recheckInt(80), want: "累计 80"},
		{name: "explicit-zero", actual: recheckInt(0), want: "累计 0"},
		{name: "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			timeline := &client.ChatTimeline{ContextUsage: &client.ChatContextUsage{ContextTokens: 1000}, Usage: &client.ChatRunUsage{Tokens: 1000, ActualTokens: tc.actual}}
			label := contextUsageLabel(timeline)
			if tc.want != "" && !strings.Contains(label, tc.want) {
				t.Fatalf("累计未使用实际用量：%q", label)
			}
			if tc.want == "" && strings.Contains(label, "累计 1,000") {
				t.Fatalf("未知实际用量被估算值冒充：%q", label)
			}
		})
	}
}

func recheckInt(v int) *int { return &v }
