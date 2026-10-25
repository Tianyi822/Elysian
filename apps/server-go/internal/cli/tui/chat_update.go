package tui

import (
	"strings"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

// 聊天屏的 Update 与渲染。

// enterChat 进入聊天屏：装配状态、恢复草稿、聚焦输入、全量加载。
func (m Model) enterChat(sessionID string) (tea.Model, tea.Cmd) {
	if m.sub != nil {
		// 先收敛旧订阅（迟到提交开启的流或上一会话残留）。
		m.sub.close()
		m.sub = nil
	}
	previous := m.chat
	m.phase = phaseSession
	m.chat = newChatState(sessionID)
	m.selected = sessionID
	m.applyChatFocus(sessionID)
	m.chat.showReasoning = previous.showReasoning
	return m, tea.Batch(loadChatCmd(m.api, sessionID), saveStateCmd(m))
}

// applyChatFocus 聊天屏装配（草稿恢复、输入聚焦、滚动区尺寸）。
func (m *Model) applyChatFocus(sessionID string) {
	m.chat.editor.SetValue(m.drafts[sessionID])
	m.chat.editor.Focus()
	m.chat.viewport.Width = max(16, m.width-2)
	m.chat.viewport.Height = chatViewportHeight(m.height)
	m.chat.editor.SetWidth(max(16, m.width-4))
}

// leaveChat 离开聊天屏：停流停轮询（含审批轮询）、关覆盖层与向导、草稿落本地。
func (m *Model) leaveChat() {
	m.drafts[m.chat.sessionID] = m.chat.editor.Value()
	if m.sub != nil {
		m.sub.close()
		m.sub = nil
	}
	m.chat.polling = false
	m.chat.approvalPolling = false
	m.chat.stopping = false
	m.chat.sending = false
	m.chat.panel = nil
	m.chat.tools = nil
	m.chat.wizard = nil
}

// updateChatKeys 聊天屏按键：权限模式循环切换（Shift+Tab，覆盖层与向导期间也可
// 用）；覆盖层（审批面板／工具详情）与等待输入向导优先接管；其余为 Enter 发送、
// Ctrl+J 换行、Ctrl+S 停止、Ctrl+T 思考展开、Ctrl+A 审批面板、Ctrl+O 工具详情、
// Ctrl+P 计划展开、PgUp/PgDn 滚动消息区、Esc 返回列表。
func (m Model) updateChatKeys(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "shift+tab" {
		return m.cyclePermissionMode()
	}
	if m.chat.panel != nil {
		return m.updateApprovalPanel(msg)
	}
	if m.chat.tools != nil {
		return m.updateToolDetail(msg)
	}
	if m.chat.wizard != nil {
		return m.updateInputWizard(msg)
	}
	switch msg.String() {
	case "enter":
		return m.sendCurrent()
	case "ctrl+j":
		m.chat.editor.InsertString("\n")
		return m, nil
	case "ctrl+s":
		return m.requestStop()
	case "ctrl+t":
		m.chat.showReasoning = !m.chat.showReasoning
		return m, m.rebuildView()
	case "ctrl+p":
		if m.chat.plan != nil {
			m.chat.showPlan = !m.chat.showPlan
		}
		return m, m.rebuildView()
	case "ctrl+a":
		panel := newApprovalPanel(map[string]client.AccessDecisionInput{})
		panel.approvals = m.chat.pendingApprovals
		m.chat.panel = panel
		if m.chat.runStatus == "waiting-approval" || m.chat.runStatus == "preparing-runtime" || len(m.chat.pendingApprovals) > 0 {
			return m, approvalsPollCmd(m.api, m.chat.runID, 0)
		}
		return m, nil
	case "ctrl+o":
		if m.chat.stream != nil && m.chat.stream.Timeline != nil {
			m.chat.tools = &toolDetail{entries: toolEntries(m.chat.stream.Timeline.Entries), calls: map[string]client.Call{}}
		}
		return m, nil
	case "pgup":
		m.chat.viewport.HalfViewUp()
		m.chat.follow = m.chat.viewport.AtBottom()
		return m, nil
	case "pgdn":
		m.chat.viewport.HalfViewDown()
		m.chat.follow = m.chat.viewport.AtBottom()
		return m, nil
	case "home":
		m.chat.viewport.GotoTop()
		m.chat.follow = false
		return m, nil
	case "end":
		m.chat.viewport.GotoBottom()
		m.chat.follow = true
		return m, nil
	case "esc":
		m.leaveChat()
		m.phase = phaseSessions
		return m, saveStateCmd(m)
	}
	var cmd tea.Cmd
	m.chat.editor, cmd = m.chat.editor.Update(msg)
	return m, cmd
}

// sendCurrent 发送：本地预检（非空／字节上限／会话忙）＋requestId 幂等（同输入
// 重试复用 pending.requestId 与首次冻结的权限模式）；思考档取本地选择（缺省不带
// 该字段），权限模式随轮提交（缺省 ask），Skill/MCP 按方案固定
// extensionMode:"enabled" 自动接入已启用扩展。
func (m Model) sendCurrent() (tea.Model, tea.Cmd) {
	if m.chat.sending || activeRun(m.chat.runStatus) {
		m.notice = "会话忙：当前运行结束后再发送"
		m.noticeBad = true
		return m, nil
	}
	content := m.chat.editor.Value()
	if strings.TrimSpace(content) == "" {
		return m, nil
	}
	if err := client.ValidateUserContent(content); err != nil {
		m.notice = err.Error()
		m.noticeBad = true
		return m, nil
	}
	pending := m.chat.pending
	if pending == nil || pending.content != content {
		pending = &pendingSend{requestID: client.NewRequestID(), content: content, permissionMode: m.currentPermissionMode(chatSessionOf(m))}
	}
	input := client.AgentInput{
		RequestID:      pending.requestID,
		Content:        content,
		PermissionMode: pending.permissionMode,
		ExtensionMode:  "enabled",
	}
	if level := m.currentLevel(chatSessionOf(m)); level != "" {
		input.ReasoningLevel = level
	}
	m.chat.pending = pending
	m.chat.sending = true
	m.notice = ""
	m.noticeBad = false
	taskID := m.chat.taskID
	return m, submitCmd(m.api, m.chat.sessionID, taskID, input)
}

// currentPermissionMode 本会话当前权限模式：本地选择优先（持久化），缺省 ask
// （与服务端缺省一致）；本地脏值（旧文件手改）回落 ask。
func (m Model) currentPermissionMode(session client.Session) string {
	if mode, ok := m.permModes[session.ID]; ok {
		switch mode {
		case client.PermissionAsk, client.PermissionAssist, client.PermissionFull:
			return mode
		}
	}
	return client.PermissionAsk
}

// cyclePermissionMode Shift+Tab 循环切换权限模式 ask→assist→full→ask（方案
// §6.2）：纯本地选择、逐轮提交时消费；发送在途或运行中锁定（与 Web 侧禁用
// 同口径），装配未完成时忽略。
func (m Model) cyclePermissionMode() (tea.Model, tea.Cmd) {
	if m.chat.loading {
		return m, nil
	}
	if m.chat.sending || activeRun(m.chat.runStatus) {
		m.notice = "会话忙：当前运行结束后再切换权限模式"
		m.noticeBad = true
		return m, nil
	}
	session := chatSessionOf(m)
	m.permModes[session.ID] = client.NextPermissionMode(m.currentPermissionMode(session))
	return m, tea.Batch(m.rebuildView(), saveStateCmd(m))
}

// chatSessionOf 安全取会话事实（未加载完成时零值）。
func chatSessionOf(m Model) client.Session {
	if m.chat.session != nil {
		return *m.chat.session
	}
	return client.Session{}
}

// requestStop 停止回复：活跃 Run 才可停；「正在停止」直到轮询见终态收敛。
func (m Model) requestStop() (tea.Model, tea.Cmd) {
	if m.chat.runID == "" || !activeRun(m.chat.runStatus) || m.chat.stopping {
		return m, nil
	}
	m.chat.stopping = true
	return m, cancelRunCmd(m.api, m.chat.runID)
}

// updateChatLoaded 装配落地：会话 404 回列表；有活跃 Run（activeRunId 或 latestRun
// 未终态）即订阅输出流并启动轮询。
func (m Model) updateChatLoaded(msg chatLoadedMsg) (tea.Model, tea.Cmd) {
	if msg.sessionID != m.chat.sessionID {
		return m, nil
	}
	m.chat.loading = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Status == 404 {
			m.phase = phaseSessions
			m.notice = "会话已不存在"
			m.noticeBad = true
			m.list.loading = true
			return m, loadSessionsCmd(m.api, "")
		}
		m.chat.loadErr = errText(msg.err)
		return m, nil
	}
	m.chat.loadErr = ""
	m.chat.session = msg.session
	m.chat.taskID = msg.taskID
	m.chat.messages = msg.messages
	m.chat.lastSeq = msg.lastSeq
	m.chat.lastRun = msg.latestRun
	// 恢复链（boot 指针命中）从列表屏直进聊天：装配聚焦与草稿。
	if m.phase == phaseSessions {
		m.phase = phaseSession
		m.applyChatFocus(msg.sessionID)
	}
	runID := msg.session.ActiveRunID
	runStatus := ""
	if msg.latestRun != nil {
		runStatus = msg.latestRun.Status
		if runID == "" && activeRun(runStatus) {
			runID = msg.latestRun.ID
		}
	}
	cmds := []tea.Cmd{m.rebuildView()}
	if runID != "" {
		m.chat.runID = runID
		m.chat.runStatus = firstNonEmpty(runStatus, "running")
		m.sub = openStream(m.api, runID)
		m.chat.polling = true
		cmds = append(cmds, streamListenCmd(m.sub), pollRunCmd(m.api, m.chat.sessionID, runID, chatPollInterval))
	}
	return m, tea.Batch(cmds...)
}

// updateSubmit 提交回填：成功（202/200）接流与轮询并清输入；失败保留输入与
// pending（同输入重试复用同 requestId）。已离开聊天屏的迟到回填丢弃（请求本身
// 已被服务端按幂等键受理或拒绝，重进会话经 activeRun 恢复展示）。
func (m Model) updateSubmit(msg submitMsg) (tea.Model, tea.Cmd) {
	if m.phase != phaseSession {
		return m, nil
	}
	m.chat.sending = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		m.notice = "发送失败：" + errText(msg.err)
		m.noticeBad = true
		return m, nil
	}
	if m.chat.pending != nil && m.chat.pending.requestID == msg.requestID {
		m.chat.pending = nil
		m.drafts[m.chat.sessionID] = ""
		m.chat.editor.SetValue("")
	}
	if msg.run.TaskID != "" {
		m.chat.taskID = msg.run.TaskID
	}
	submitted := msg.run
	m.chat.lastRun = &submitted
	if m.sub != nil {
		m.sub.close()
	}
	m.chat.runID = msg.run.ID
	m.chat.runStatus = msg.run.Status
	m.chat.stopping = false
	m.chat.stream = nil
	m.chat.timeline = nil
	m.sub = openStream(m.api, msg.run.ID)
	m.chat.polling = true
	return m, tea.Batch(streamListenCmd(m.sub), pollRunCmd(m.api, m.chat.sessionID, msg.run.ID, chatPollInterval), m.rebuildView())
}

// updateStreamFrame 流帧：全量快照覆盖（重连帧同样覆盖）；done 时停轮询前先增量
// 回读公开消息补最终答复。
func (m Model) updateStreamFrame(msg streamFrameMsg) (tea.Model, tea.Cmd) {
	if m.sub == nil || msg.frame.RunID != m.chat.runID {
		return m, nil
	}
	frame := msg.frame
	m.chat.stream = &frame
	m.chat.streamHealthy = true
	if frame.Timeline != nil {
		m.chat.timeline = frame.Timeline
		if frame.Timeline.Status != "" {
			m.chat.runStatus = frame.Timeline.Status
		}
		if frame.Timeline.Plan != nil {
			m.chat.plan = frame.Timeline.Plan
		}
	}
	cmds := []tea.Cmd{m.rebuildView()}
	cmds = append(cmds, m.applyWaitingStates()...)
	if frame.Done {
		m.chat.polling = true // 轮询链继续推进至终态收敛（增量回读由 poll 分支触发）。
		cmds = append(cmds, appendMessagesCmd(m.api, m.chat.sessionID, m.chat.lastSeq))
	}
	if m.sub != nil {
		cmds = append(cmds, streamListenCmd(m.sub))
	}
	return m, tea.Batch(cmds...)
}

// updatePoll 轮询回填：终态收敛（停轮询、增量回读、保留快照），等待态与运行中
// 续排；网络错误保留提示并续排（轮询是流断连时的兜底通道）。
func (m Model) updatePoll(msg pollMsg) (tea.Model, tea.Cmd) {
	if m.phase != phaseSession || !m.chat.polling {
		return m, nil
	}
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.chat.polling = false
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		// 轮询失败不终止链路：下一拍重试。
		return m, pollRunCmd(m.api, m.chat.sessionID, m.chat.runID, chatPollInterval)
	}
	if msg.run != nil {
		m.chat.runStatus = msg.run.Status
		m.chat.lastRun = msg.run
	}
	if msg.timeline != nil {
		// 流断连期间轮询快照兜底推进展示（含上下文用量）。
		m.chat.timeline = msg.timeline
	}
	if msg.session != nil && msg.session.ActiveRunID != "" {
		m.chat.runID = msg.session.ActiveRunID
	}
	cmds := []tea.Cmd{m.rebuildView()}
	if msg.run != nil && terminalRun(msg.run.Status) {
		m.chat.polling = false
		m.chat.stopping = false
		m.chat.approvalPolling = false
		m.chat.wizard = nil
		if m.sub != nil {
			m.sub.close()
		}
		cmds = append(cmds, appendMessagesCmd(m.api, m.chat.sessionID, m.chat.lastSeq))
		return m, tea.Batch(cmds...)
	}
	cmds = append(cmds, pollRunCmd(m.api, m.chat.sessionID, m.chat.runID, chatPollInterval))
	cmds = append(cmds, m.applyWaitingStates()...)
	return m, tea.Batch(cmds...)
}

// updateMessagesAppended 增量消息落地（终态后补最终公开消息）。
func (m Model) updateMessagesAppended(msg messagesAppendedMsg) (tea.Model, tea.Cmd) {
	if msg.sessionID != m.chat.sessionID {
		return m, nil
	}
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		return m, nil // 增量失败静默：下次终态或刷新重读。
	}
	for _, item := range msg.messages {
		if m.chat.lastSeq == "" || item.Seq > m.chat.lastSeq {
			m.chat.messages = append(m.chat.messages, item)
			m.chat.lastSeq = item.Seq
		}
	}
	return m, m.rebuildView()
}

// updateCancel 停止回填：请求已受理，「正在停止」保持到轮询见终态；离开聊天屏
// 后的迟到回填丢弃。
func (m Model) updateCancel(msg cancelMsg) (tea.Model, tea.Cmd) {
	if m.phase != phaseSession {
		return m, nil
	}
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		m.chat.stopping = false
		m.notice = "停止失败：" + errText(msg.err)
		m.noticeBad = true
		return m, nil
	}
	if terminalRun(msg.run.Status) {
		// 已终态（如早已结束或取消即时生效）：直接收敛。
		m.chat.runStatus = msg.run.Status
		m.chat.stopping = false
		m.chat.polling = false
		if m.sub != nil {
			m.sub.close()
		}
		return m, tea.Batch(m.rebuildView(), appendMessagesCmd(m.api, m.chat.sessionID, m.chat.lastSeq))
	}
	m.chat.stopping = true
	return m, nil
}

// applyWaitingStates 按当前运行状态驱动等待态界面：waiting-input 且无向导时从
// timeline 提取问题组接管输入区；waiting-approval/preparing-runtime 启动审批轮询
// （徽标与面板数据源）；离开等待态停审批轮询并关向导。返回需执行的命令。
func (m *Model) applyWaitingStates() []tea.Cmd {
	var cmds []tea.Cmd
	switch m.chat.runStatus {
	case "waiting-input":
		m.chat.approvalPolling = false
		if m.chat.wizard == nil && m.chat.stream != nil && m.chat.stream.Timeline != nil {
			if request := pendingUserInput(m.chat.stream.Timeline.Entries); request != nil {
				m.chat.wizard = newInputWizard(*request)
			}
		}
	case "waiting-approval", "preparing-runtime":
		if !m.chat.approvalPolling && m.chat.runID != "" {
			m.chat.approvalPolling = true
			cmds = append(cmds, approvalsPollCmd(m.api, m.chat.runID, 0))
		}
	default:
		m.chat.approvalPolling = false
		if m.chat.runStatus != "" && activeRun(m.chat.runStatus) {
			m.chat.wizard = nil
		}
	}
	return cmds
}

// pendingUserInput 从 timeline 提取未答的问题组（status 仍为等待中）。
func pendingUserInput(entries []client.TimelineEntry) *client.UserInputRequest {
	for i := range entries {
		entry := &entries[i]
		if entry.Kind == "user-input" && entry.UserInput != nil && entry.UserInput.Status == "waiting" {
			return entry.UserInput
		}
	}
	return nil
}

// toolEntries 工具条目（详情列表数据）。
func toolEntries(entries []client.TimelineEntry) []client.TimelineEntry {
	tools := make([]client.TimelineEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.Kind == "tool" {
			tools = append(tools, entry)
		}
	}
	return tools
}

// updateStreamDead 流致命错误（401）：收敛登录。
func (m Model) updateStreamDead(msg streamDeadMsg) (tea.Model, tea.Cmd) {
	m.chat.polling = false
	m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
	return m, nil
}

// updateStreamInterrupted 断连：如实提示并继续监听（订阅内部 1 秒重连）。
func (m Model) updateStreamInterrupted() (tea.Model, tea.Cmd) {
	if m.sub == nil {
		return m, nil
	}
	m.chat.streamHealthy = false
	return m, streamListenCmd(m.sub)
}

// updateStreamEnded 订阅结束（退订或 done 收敛）：不再监听。
func (m Model) updateStreamEnded() (tea.Model, tea.Cmd) {
	m.chat.streamHealthy = false
	return m, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}
