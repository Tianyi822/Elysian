package tui

import (
	"context"
	"errors"
	"time"

	"elysian/server/internal/cli/client"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
)

var ErrExitCLI = errors.New("退出 CLI")

type lifetime struct {
	ctx    context.Context
	cancel context.CancelFunc
}

func newLifetime() *lifetime {
	ctx, cancel := context.WithCancel(context.Background())
	return &lifetime{ctx, cancel}
}

type replyScope struct {
	historyEpoch, attachmentEpoch uint64
	runID                         string
	sub                           *streamSub
	epoch                         uint64
	auth                          uint64
	panel                         *approvalPanel
	wizard                        *inputWizard
	tools                         *toolDetail
	history                       *historyPanel
	attachments                   *attachmentPanel
}
type scopedMsg struct {
	scope replyScope
	msg   tea.Msg
}

func wrapCommand(cmd tea.Cmd, scope replyScope) tea.Cmd {
	if cmd == nil {
		return nil
	}
	return func() tea.Msg {
		msg := cmd()
		if batch, ok := msg.(tea.BatchMsg); ok {
			for i := range batch {
				batch[i] = wrapCommand(batch[i], scope)
			}
			return batch
		}
		if msg == nil {
			return nil
		}
		if _, ok := msg.(tea.QuitMsg); ok {
			return msg
		}
		if _, ok := msg.(spinner.TickMsg); ok {
			return msg
		}
		return scopedMsg{scope: scope, msg: msg}
	}
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	if reply, ok := msg.(scopedMsg); ok {
		if reply.scope.auth != m.authEpoch {
			return m, nil
		}
		switch reply.msg.(type) {
		case sessionsLoadedMsg, modelsLoadedMsg, loginDoneMsg, bootMsg, renameDoneMsg, deleteDoneMsg, logoutDoneMsg, stateSavedMsg:
		default:
			if reply.scope.epoch != m.epoch {
				return m, nil
			}
		}
		switch reply.msg.(type) {
		case streamFrameMsg, streamEndedMsg, streamInterruptedMsg, streamDeadMsg, pollMsg, approvalsMsg:
			if reply.scope.sub != m.sub || reply.scope.runID != m.chat.runID {
				return m, nil
			}
		case approvalDecisionMsg:
			if reply.scope.panel != m.chat.panel || reply.scope.runID != m.chat.runID {
				return m, nil
			}
		case userInputAnswerMsg:
			if reply.scope.wizard != m.chat.wizard || reply.scope.runID != m.chat.runID {
				return m, nil
			}
		case callsMsg:
			if reply.scope.tools != m.chat.tools || reply.scope.runID != m.chat.runID {
				return m, nil
			}
		case historyLoadedMsg:
			if reply.scope.history != m.chat.history || (m.chat.history != nil && reply.scope.historyEpoch != m.chat.history.generation) {
				return m, nil
			}
		case attachmentDoneMsg:
			if reply.scope.attachments != m.chat.attachmentPanel || (m.chat.attachmentPanel != nil && reply.scope.attachmentEpoch != m.chat.attachmentPanel.generation) {
				return m, nil
			}
		}
		msg = reply.msg
	}
	priorText := m.chat.editor.Value()
	priorPhase, priorSession := m.phase, m.chat.sessionID
	next, cmd := m.update(msg)
	n := next.(Model)
	n.layoutChat()
	if n.chat.sessionID == priorSession && n.chat.editor.Value() != priorText {
		switch msg.(type) {
		case tea.KeyMsg:
			n.chat.draftRevision++
		default:
			if n.chat.pending != nil && m.chat.pending == n.chat.pending {
				n.chat.draftRevision++
			}
		}
	}
	if priorPhase != n.phase || priorSession != n.chat.sessionID {
		n.epoch++
	}
	if (n.phase == phaseLogin) != (priorPhase == phaseLogin) {
		n.authEpoch++
	}
	scope := replyScope{runID: n.chat.runID, sub: n.sub, epoch: n.epoch, auth: n.authEpoch, panel: n.chat.panel, wizard: n.chat.wizard, tools: n.chat.tools, history: n.chat.history, attachments: n.chat.attachmentPanel}
	if n.chat.history != nil {
		scope.historyEpoch = n.chat.history.generation
	}
	if n.chat.attachmentPanel != nil {
		scope.attachmentEpoch = n.chat.attachmentPanel.generation
	}
	return n, wrapCommand(cmd, scope)
}

func waitContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func apiContext(api API) context.Context {
	if scoped, ok := api.(interface{ requestContext() context.Context }); ok {
		return scoped.requestContext()
	}
	return context.Background()
}

type pendingResolvedMsg struct {
	sessionID, requestID string
	run                  *client.Run
	err                  error
}

func resolvePendingCmd(api API, sessionID, requestID string) tea.Cmd {
	return func() tea.Msg {
		page, err := api.ListRuns(apiContext(api), sessionID, requestID, "")
		msg := pendingResolvedMsg{sessionID: sessionID, requestID: requestID, err: err}
		for _, run := range page.Items {
			if run.RequestID == requestID && run.SessionID == sessionID {
				copy := run
				msg.run = &copy
				break
			}
		}
		return msg
	}
}

func (m Model) updatePendingResolved(msg pendingResolvedMsg) (tea.Model, tea.Cmd) {
	if m.phase != phaseSession || msg.sessionID != m.chat.sessionID || m.chat.pending == nil || msg.requestID != m.chat.pending.requestID {
		return m, nil
	}
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		m.notice = "上次请求尚未确认：" + errText(msg.err)
		m.noticeBad = true
		return m, nil
	}
	if msg.run != nil {
		m.confirmPending(*msg.run)
		return m, loadChatCmd(m.chatAPI(), m.chat.sessionID)
	}
	m.notice = "上次请求未查到受理记录；Enter 使用原请求重试，草稿保留。"
	return m, nil
}

func (m *Model) startChatContext() {
	if m.chatCancel != nil {
		m.chatCancel()
	}
	parent := context.Background()
	if m.life != nil {
		parent = m.life.ctx
	}
	m.chatContext, m.chatCancel = context.WithCancel(parent)
}
func (m Model) chatAPI() API {
	if m.chatContext == nil {
		return m.api
	}
	return withLifetime(m.api, m.chatContext)
}
