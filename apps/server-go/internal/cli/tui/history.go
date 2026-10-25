package tui

import (
	"fmt"
	"strings"

	"elysian/server/internal/cli/client"
	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

type runItem struct{ run client.Run }

func (i runItem) Title() string {
	return safeText(i.run.ID) + " · " + runStatusLabel(i.run.Status, false)
}
func (i runItem) Description() string {
	return formatActivity(i.run.CreatedAt) + " · 第 " + fmt.Sprint(i.run.RunNumber) + " 轮"
}
func (i runItem) FilterValue() string { return i.run.ID }

type historyPanel struct {
	generation         uint64
	list               list.Model
	viewport           viewport.Model
	next               string
	more, busy, detail bool
	err                string
	runID              string
}
type historyLoadedMsg struct {
	page   *client.Page[client.Run]
	append bool
	runID  string
	text   string
	err    error
}

func (m Model) openHistory() (tea.Model, tea.Cmd) {
	l := list.New(nil, list.NewDefaultDelegate(), max(20, m.width-2), max(6, m.height-8))
	l.Title = "执行历史"
	l.SetFilteringEnabled(false)
	l.SetShowHelp(false)
	m.chat.history = &historyPanel{list: l, viewport: viewport.New(max(20, m.width-2), max(6, m.height-8)), busy: true}
	return m, historyPageCmd(m.chatAPI(), m.chat.sessionID, "")
}
func historyPageCmd(api API, sessionID, cursor string) tea.Cmd {
	return func() tea.Msg {
		page, err := api.ListRuns(apiContext(api), sessionID, "", cursor)
		return historyLoadedMsg{page: &page, append: cursor != "", err: err}
	}
}

func (m Model) updateHistoryKey(key tea.KeyMsg) (tea.Model, tea.Cmd) {
	h := m.chat.history
	if key.String() == "esc" {
		if h.detail {
			h.generation++
			h.detail = false
			h.runID = ""
			h.busy = false
			h.err = ""
			return m, nil
		}
		m.chat.history = nil
		return m, nil
	}
	if h.busy {
		return m, nil
	}
	if key.String() == "r" {
		h.generation++
		h.busy = true
		h.err = ""
		if h.detail {
			return m, historyDetailCmd(m.chatAPI(), h.runID, m)
		}
		return m, historyPageCmd(m.chatAPI(), m.chat.sessionID, "")
	}
	if h.detail {
		var cmd tea.Cmd
		h.viewport, cmd = h.viewport.Update(key)
		return m, cmd
	}
	if key.String() == "l" && h.more {
		h.busy = true
		return m, historyPageCmd(m.chatAPI(), m.chat.sessionID, h.next)
	}
	if key.String() == "enter" {
		if item, ok := h.list.SelectedItem().(runItem); ok {
			h.generation++
			h.runID = item.run.ID
			h.detail = true
			h.busy = true
			return m, historyDetailCmd(m.chatAPI(), h.runID, m)
		}
	}
	var cmd tea.Cmd
	h.list, cmd = h.list.Update(key)
	return m, cmd
}

func historyDetailCmd(api API, runID string, m Model) tea.Cmd {
	return func() tea.Msg {
		fail := func(err error) tea.Msg { return historyLoadedMsg{runID: runID, err: err} }
		run, err := api.GetRun(apiContext(api), runID)
		if err != nil {
			return fail(err)
		}
		timeline, err := api.TimelineSnapshot(apiContext(api), runID)
		if err != nil {
			return fail(err)
		}
		var b strings.Builder
		fmt.Fprintf(&b, "%s · %s\n", run.ID, runStatusLabel(run.Status, false))
		if run.EndReason != "" {
			fmt.Fprintf(&b, "结束原因：%s\n", run.EndReason)
		}
		if run.Error != nil {
			fmt.Fprintf(&b, "错误：%s\n", run.Error.Message)
		}
		state := chatState{timeline: &timeline}
		b.WriteString(renderContextUsageDetail(&state, m, max(20, m.width-2)) + "\n")
		if timeline.Plan != nil {
			for _, step := range timeline.Plan.Steps {
				fmt.Fprintf(&b, "计划 · %s · %s\n", step.Status, step.Title)
			}
		}
		cursor := ""
		for {
			page, e := api.ModelRequests(apiContext(api), runID, cursor)
			if e != nil {
				return fail(e)
			}
			for _, request := range page.Items {
				fmt.Fprintf(&b, "\n模型请求 %d · %s · %s\n", request.Index+1, request.Purpose, request.Status)
				reasoning, content := request.Reasoning, request.Content
				if request.Response != nil {
					reasoning = request.Response.Reasoning
					content = request.Response.Content
				}
				if reasoning != "" {
					b.WriteString("思考：\n" + wrapPlain(reasoning, max(16, m.width-4)) + "\n")
				}
				if content != "" {
					b.WriteString("答复：\n" + wrapPlain(content, max(16, m.width-4)) + "\n")
				}
				if request.Error != nil {
					b.WriteString("错误：" + request.Error.Message + "\n")
				}
			}
			if !page.HasMore {
				break
			}
			if page.NextCursor == "" || page.NextCursor == cursor {
				return fail(fmt.Errorf("模型请求分页游标无效"))
			}
			cursor = page.NextCursor
		}
		calls, err := allCalls(api, runID)
		if err != nil {
			return fail(err)
		}
		byID := map[string]client.Call{}
		for _, call := range calls {
			byID[call.ID] = call
		}
		for _, entry := range timeline.Entries {
			if entry.Kind == "tool" {
				fmt.Fprintf(&b, "\n工具 %s · %s\n参数：\n%s\n", entry.Tool, toolStatusLabel(entry.Status), wrapPlain(entry.ArgumentsJSON, max(16, m.width-4)))
				if call, ok := byID[entry.CallID]; ok {
					fmt.Fprintf(&b, "结果：\n%s\n", wrapPlain(string(call.Result), max(16, m.width-4)))
					if call.Error != nil {
						b.WriteString(call.Error.Message + "\n")
					}
					if call.Truncated {
						b.WriteString("（服务端保存结果已截断）\n")
					}
				}
			}
		}
		return historyLoadedMsg{runID: runID, text: safeText(b.String())}
	}
}

func allCalls(api API, runID string) ([]client.Call, error) {
	var all []client.Call
	cursor := ""
	for {
		page, err := api.ListCalls(apiContext(api), runID, cursor)
		if err != nil {
			return nil, err
		}
		all = append(all, page.Items...)
		if !page.HasMore {
			return all, nil
		}
		if page.NextCursor == "" || page.NextCursor == cursor {
			return nil, fmt.Errorf("工具结果分页游标无效")
		}
		cursor = page.NextCursor
	}
}

func (m Model) updateHistoryLoaded(msg historyLoadedMsg) (tea.Model, tea.Cmd) {
	h := m.chat.history
	if h == nil || (msg.runID != "" && msg.runID != h.runID) {
		return m, nil
	}
	h.busy = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		h.err = errText(msg.err)
		return m, nil
	}
	h.err = ""
	if msg.page != nil {
		items := []list.Item{}
		if msg.append {
			items = append(items, h.list.Items()...)
		}
		for _, run := range msg.page.Items {
			items = append(items, runItem{run})
		}
		h.more = msg.page.HasMore
		h.next = msg.page.NextCursor
		return m, h.list.SetItems(items)
	}
	h.viewport.SetContent(msg.text)
	h.viewport.GotoTop()
	return m, nil
}
func (h *historyPanel) view() string {
	if h.busy {
		return "正在读取执行记录…\nEsc 返回"
	}
	if h.err != "" {
		return safeText(h.err) + "\nr 重试 · Esc 返回"
	}
	if h.detail {
		return h.viewport.View() + "\n↑↓/PgUp/PgDn 滚动 · r 重读 · Esc 返回历史"
	}
	return h.list.View() + "\nEnter 查看完整过程 · l 加载更多 · r 刷新 · Esc 返回"
}

func (m Model) beginEdit() (tea.Model, tea.Cmd) {
	if m.chat.loading || m.chat.loadErr != "" || m.chat.sending || activeRun(m.chat.runStatus) || m.chat.pending != nil || (m.chat.session != nil && m.chat.session.ActiveWorkflowID != "") {
		m.notice = "会话空闲且提交已确认后，才能编辑最后一条用户消息"
		m.noticeBad = true
		return m, nil
	}
	for i := len(m.chat.messages) - 1; i >= 0; i-- {
		message := m.chat.messages[i]
		if message.Role != "user" {
			continue
		}
		m.captureLocal()
		m.chat.editing = &EditDraft{MessageID: message.ID, TaskID: message.TaskID, Content: message.Content, Attachments: append([]client.MessageAttachment(nil), message.Attachments...)}
		if saved := m.locals[m.chat.sessionID].Editing; saved != nil && (saved.MessageID == message.ID || (saved.AcceptedRunID != "" && saved.AcceptedRunID == message.RunID)) {
			copy := *saved
			copy.MessageID, copy.TaskID, copy.AcceptedRunID = message.ID, message.TaskID, ""
			m.chat.editing = &copy
		}
		m.chat.editor.SetValue(m.chat.editing.Content)
		m.captureLocal()
		return m, m.rebuildView()
	}
	m.notice = "没有可编辑的用户消息"
	return m, nil
}
