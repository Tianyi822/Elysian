package tui

import (
	"context"
	"strings"
	"time"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

// 聊天屏覆盖层与等待输入向导（CLI 方案 §6.3 第三步）：
//   - 审批面板（Ctrl+A）：普通审批（批准 y／拒绝 n／取消本轮 x）、运行时授权卡
//     （1 仅本次／2 本会话／3 拒绝，幂等键防重复决定）与本会话授权回读／撤回；
//   - 工具详情（Ctrl+O）：工具条目完整参数与执行结果按需加载（calls）；
//   - 等待用户输入向导（run 转 waiting-input 自动接管）：单选＋自定义文本，
//     逐题作答统一提交（requestId 幂等），Esc 取消即停止本轮；
//   - 计划折叠条（Ctrl+P）：完成数与当前步骤，展开步骤列表。

// approvalPollInterval 待审批期轮询间隔（Web 同值 2 秒）。
const approvalPollInterval = 2 * time.Second

// —— 异步消息 ——

// approvalsMsg 审批轮询回填。
type approvalsMsg struct {
	items []client.Approval
	err   error
}

// approvalDecisionMsg 审批／授权决定回填。
type approvalDecisionMsg struct {
	approval client.Approval
	err      error
}

// authorizationsMsg 会话授权列表回填。
type authorizationsMsg struct {
	items []client.SessionAuthorization
	err   error
}

// revokeAuthMsg 撤回授权回填。
type revokeAuthMsg struct {
	id  string
	err error
}

// userInputAnswerMsg 等待输入回答回填。
type userInputAnswerMsg struct {
	receipt client.UserInputReceipt
	err     error
}

// callsMsg 工具结果加载回填。
type callsMsg struct {
	runID string
	calls []client.Call
	err   error
}

// approvalsPollCmd 待审批轮询（延时后拉取）。
func approvalsPollCmd(api API, runID string, delay time.Duration) tea.Cmd {
	return func() tea.Msg {
		time.Sleep(delay)
		items, err := api.ListApprovalsByRun(context.Background(), runID)
		return approvalsMsg{items: items, err: err}
	}
}

// loadAuthorizationsCmd 会话授权列表。
func loadAuthorizationsCmd(api API, sessionID string) tea.Cmd {
	return func() tea.Msg {
		items, err := api.ListSessionAuthorizations(context.Background(), sessionID)
		return authorizationsMsg{items: items, err: err}
	}
}

// —— 审批面板 ——

// approvalPanel 审批面板覆盖层：待审批与本会话授权两个标签页。
type approvalPanel struct {
	tab         int // 0 待审批；1 本会话授权
	approvals   []client.Approval
	cursor      int
	detail      bool // 详情视图（完整参数／文件变更／授权范围）
	auths       []client.SessionAuthorization
	authCursor  int
	authLoading bool
	busy        bool
	err         string
	// pendingAccess 未确认的授权决定（同卡重试复用同 requestId）。
	pendingAccess map[string]client.AccessDecisionInput
}

func newApprovalPanel(pending map[string]client.AccessDecisionInput) *approvalPanel {
	return &approvalPanel{pendingAccess: pending, authLoading: true}
}

// visibleApprovals 面板展示集：pending 与 approved（已批待执行），过滤 workflow-gate。
func visibleApprovals(items []client.Approval) []client.Approval {
	out := make([]client.Approval, 0, len(items))
	for _, item := range items {
		if item.Kind == "workflow-gate" {
			continue
		}
		if item.Status == "pending" || item.Status == "approved" {
			out = append(out, item)
		}
	}
	return out
}

// updateApprovalPanel 面板按键：Tab 切页、↑↓ 导航、Enter 详情、y/n/x 审批、
// 1/2/3 授权、r 撤回、Esc 关闭。
func (m Model) updateApprovalPanel(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	panel := m.chat.panel
	if panel.busy {
		return m, nil
	}
	switch msg.String() {
	case "esc":
		if panel.detail {
			panel.detail = false
			return m, nil
		}
		m.chat.panel = nil
		return m, nil
	case "tab":
		panel.tab = 1 - panel.tab
		panel.detail = false
		if panel.tab == 1 && panel.auths == nil {
			return m, loadAuthorizationsCmd(m.api, m.chat.sessionID)
		}
		return m, nil
	case "up", "k":
		if panel.tab == 0 && panel.cursor > 0 {
			panel.cursor--
		}
		if panel.tab == 1 && panel.authCursor > 0 {
			panel.authCursor--
		}
	case "down", "j":
		if panel.tab == 0 && panel.cursor < len(panel.approvals)-1 {
			panel.cursor++
		}
		if panel.tab == 1 && panel.authCursor < len(panel.auths)-1 {
			panel.authCursor++
		}
	case "enter", "d":
		if panel.tab == 0 && len(panel.approvals) > 0 {
			panel.detail = !panel.detail
		}
	}
	if panel.tab == 0 && len(panel.approvals) > 0 {
		if next, cmd, handled := m.decideApprovalKey(msg); handled {
			return next, cmd
		}
	}
	if panel.tab == 1 && len(panel.auths) > 0 && msg.String() == "r" {
		return m.requestRevokeAuthorization()
	}
	return m, nil
}

// decideApprovalKey 审批操作键（详情视图内也可操作）。
func (m Model) decideApprovalKey(msg tea.KeyMsg) (tea.Model, tea.Cmd, bool) {
	panel := m.chat.panel
	approval := panel.approvals[panel.cursor]
	switch msg.String() {
	case "y", "n":
		if approval.Access != nil || approval.Status != "pending" {
			return m, nil, true // 授权卡走数字键；已批项目不可再决定。
		}
		decision := "approved"
		if msg.String() == "n" {
			decision = "denied"
		}
		panel.busy = true
		panel.err = ""
		api, id := m.api, approval.ID
		return m, func() tea.Msg {
			result, err := api.DecideApproval(context.Background(), id, decision)
			return approvalDecisionMsg{approval: result, err: err}
		}, true
	case "x":
		// 取消本轮＝停止运行。
		panel.busy = true
		return m, cancelRunCmd(m.api, m.chat.runID), true
	case "1", "2", "3":
		if approval.Access == nil || approval.Status != "pending" {
			return m, nil, true
		}
		decision := map[string]string{"1": "once", "2": "session", "3": "denied"}[msg.String()]
		input, exists := panel.pendingAccess[approval.ID]
		if !exists {
			input = client.AccessDecisionInput{
				RequestID:        client.NewRequestID(),
				ExpectedRevision: approval.Access.Revision,
				ExpectedDigest:   approval.Access.Digest,
			}
			panel.pendingAccess[approval.ID] = input
		}
		input.Decision = decision
		panel.pendingAccess[approval.ID] = input
		panel.busy = true
		panel.err = ""
		api, id := m.api, approval.ID
		return m, func() tea.Msg {
			result, err := api.DecideAccess(context.Background(), id, input)
			return approvalDecisionMsg{approval: result, err: err}
		}, true
	}
	return m, nil, false
}

// requestRevokeAuthorization 撤回当前光标的会话授权（幂等键一次生成）。
func (m Model) requestRevokeAuthorization() (tea.Model, tea.Cmd) {
	panel := m.chat.panel
	auth := panel.auths[panel.authCursor]
	panel.busy = true
	panel.err = ""
	input := client.RevokeAuthorizationInput{RequestID: client.NewRequestID(), ExpectedRevision: auth.Revision}
	api, sessionID, id := m.api, m.chat.sessionID, auth.ID
	return m, func() tea.Msg {
		err := api.RevokeSessionAuthorization(context.Background(), sessionID, id, input)
		return revokeAuthMsg{id: id, err: err}
	}
}

// updateApprovals 审批轮询落地：过滤展示集、更新面板与待审批徽标；运行离开等待
// 态时停轮询。
func (m Model) updateApprovals(msg approvalsMsg) (tea.Model, tea.Cmd) {
	if m.phase != phaseSession {
		return m, nil
	}
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.chat.approvalPolling = false
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		// 轮询失败续排（错误呈现给面板）。
		if m.chat.panel != nil {
			m.chat.panel.err = errText(msg.err)
		}
		if m.chat.approvalPolling {
			return m, approvalsPollCmd(m.api, m.chat.runID, approvalPollInterval)
		}
		return m, nil
	}
	items := visibleApprovals(msg.items)
	if m.chat.panel != nil {
		panel := m.chat.panel
		panel.err = ""
		panel.approvals = items
		// 已不在 pending 集的未确认授权决定按服务端状态清理（revision/digest 变化即失效）。
		for id := range panel.pendingAccess {
			alive := false
			for _, item := range items {
				if item.ID == id && item.Status == "pending" && item.Access != nil &&
					item.Access.Revision == panel.pendingAccess[id].ExpectedRevision &&
					item.Access.Digest == panel.pendingAccess[id].ExpectedDigest {
					alive = true
				}
			}
			if !alive {
				delete(panel.pendingAccess, id)
			}
		}
		if panel.cursor >= len(panel.approvals) {
			panel.cursor = max(0, len(panel.approvals)-1)
		}
	}
	m.chat.pendingApprovals = items
	if m.chat.approvalPolling {
		return m, approvalsPollCmd(m.api, m.chat.runID, approvalPollInterval)
	}
	return m, nil
}

// updateApprovalDecision 决定落地：回执替换列表项；失败保留未确认授权决定供原选择重试。
func (m Model) updateApprovalDecision(msg approvalDecisionMsg) (tea.Model, tea.Cmd) {
	if m.chat.panel == nil {
		return m, nil
	}
	panel := m.chat.panel
	panel.busy = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		panel.err = "审批结果未确认，请重新读取：" + errText(msg.err)
		return m, approvalsPollCmd(m.api, m.chat.runID, 0)
	}
	panel.err = ""
	for i := range panel.approvals {
		if panel.approvals[i].ID == msg.approval.ID {
			panel.approvals[i] = msg.approval
		}
	}
	delete(panel.pendingAccess, msg.approval.ID)
	m.chat.pendingApprovals = panel.approvals
	switch msg.approval.Status {
	case "approved":
		m.notice = "操作已批准，等待执行。"
		m.noticeBad = false
	case "denied":
		m.notice = "操作已拒绝。"
		m.noticeBad = false
	}
	return m, nil
}

// updateAuthorizations 授权列表落地与撤回收敛。
func (m Model) updateAuthorizations(msg authorizationsMsg) (tea.Model, tea.Cmd) {
	if m.chat.panel == nil {
		return m, nil
	}
	panel := m.chat.panel
	panel.authLoading = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		panel.err = "读取授权失败：" + errText(msg.err)
		return m, nil
	}
	panel.auths = msg.items
	panel.err = ""
	if panel.authCursor >= len(panel.auths) {
		panel.authCursor = max(0, len(panel.auths)-1)
	}
	return m, nil
}

func (m Model) updateRevokeAuth(msg revokeAuthMsg) (tea.Model, tea.Cmd) {
	if m.chat.panel == nil {
		return m, nil
	}
	panel := m.chat.panel
	panel.busy = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		panel.err = "撤回结果未确认，请重新读取：" + errText(msg.err)
		return m, loadAuthorizationsCmd(m.api, m.chat.sessionID)
	}
	kept := panel.auths[:0]
	for _, auth := range panel.auths {
		if auth.ID != msg.id {
			kept = append(kept, auth)
		}
	}
	panel.auths = kept
	m.notice = "已撤回会话授权，相关派发将被阻止。"
	m.noticeBad = false
	if panel.authCursor >= len(panel.auths) {
		panel.authCursor = max(0, len(panel.auths)-1)
	}
	return m, nil
}

// —— 等待用户输入向导 ——

// inputWizard 单选向导：逐题作答，统一提交。
type inputWizard struct {
	request     client.UserInputRequest
	questionIdx int
	optionIdx   int
	answers     map[string]client.UserInputAnswer
	textMode    bool
	textEditor  *lineEditor
	requestID   string
	submitting  bool
	err         string
}

func newInputWizard(request client.UserInputRequest) *inputWizard {
	return &inputWizard{
		request:    request,
		answers:    map[string]client.UserInputAnswer{},
		textEditor: newLineEditor(false),
		requestID:  client.NewRequestID(),
	}
}

// updateInputWizard 向导按键：↑↓ 选项、Enter 确认／下一题、t 自定义文本、
// ←→ 换题、Esc 取消（停止本轮）。
func (m Model) updateInputWizard(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	wizard := m.chat.wizard
	if wizard.submitting {
		return m, nil
	}
	questions := wizard.request.Questions
	if len(questions) == 0 {
		m.chat.wizard = nil
		return m, nil
	}
	question := questions[wizard.questionIdx]
	switch msg.String() {
	case "esc":
		// 取消＝停止本轮（保留已接收内容）。
		m.chat.wizard = nil
		if m.chat.runID != "" && activeRun(m.chat.runStatus) {
			m.chat.stopping = true
			return m, cancelRunCmd(m.api, m.chat.runID)
		}
		return m, nil
	case "left", "h":
		if wizard.questionIdx > 0 {
			wizard.questionIdx--
			wizard.textMode = false
			syncWizardCursor(wizard)
		}
		return m, nil
	case "right", "l":
		if wizard.questionIdx < len(questions)-1 && wizard.answers[question.ID] != (client.UserInputAnswer{}) {
			wizard.questionIdx++
			wizard.textMode = false
			syncWizardCursor(wizard)
		}
		return m, nil
	case "t":
		wizard.textMode = !wizard.textMode
		return m, nil
	case "enter":
		if wizard.textMode {
			text := strings.TrimSpace(wizard.textEditor.text())
			if text == "" {
				return m, nil
			}
			wizard.answers[question.ID] = client.UserInputAnswer{Text: text}
			wizard.textMode = false
			wizard.textEditor.setRunes("")
		} else {
			if wizard.optionIdx < 0 || wizard.optionIdx >= len(question.Options) {
				return m, nil
			}
			wizard.answers[question.ID] = client.UserInputAnswer{OptionID: question.Options[wizard.optionIdx].ID}
		}
		// 最后一题且全部作答：提交；否则进入下一题。
		if wizard.questionIdx < len(questions)-1 {
			wizard.questionIdx++
			syncWizardCursor(wizard)
			return m, nil
		}
		for _, q := range questions {
			if wizard.answers[q.ID] == (client.UserInputAnswer{}) {
				wizard.err = "还有未作答的问题。"
				return m, nil
			}
		}
		wizard.submitting = true
		wizard.err = ""
		api, runID, inputID := m.api, wizard.request.RunID, wizard.request.ID
		input := client.AnswerUserInputInput{RequestID: wizard.requestID, Answers: wizard.answers}
		return m, func() tea.Msg {
			receipt, err := api.AnswerUserInput(context.Background(), runID, inputID, input)
			return userInputAnswerMsg{receipt: receipt, err: err}
		}
	}
	if wizard.textMode {
		wizard.textEditor.updateKey(msg)
		return m, nil
	}
	switch msg.String() {
	case "up", "k":
		if wizard.optionIdx > 0 {
			wizard.optionIdx--
		}
	case "down", "j":
		if wizard.optionIdx < len(question.Options)-1 {
			wizard.optionIdx++
		}
	}
	return m, nil
}

// syncWizardCursor 切题后光标对齐已选选项。
func syncWizardCursor(wizard *inputWizard) {
	questions := wizard.request.Questions
	if wizard.questionIdx >= len(questions) {
		return
	}
	question := questions[wizard.questionIdx]
	wizard.optionIdx = 0
	if answer := wizard.answers[question.ID]; answer.OptionID != "" {
		for i, option := range question.Options {
			if option.ID == answer.OptionID {
				wizard.optionIdx = i
			}
		}
	}
}

// updateUserInputAnswer 回答回填：成功关闭向导（Run 已重新入队，轮询继续跟进）；
// 冲突／失败保留向导与幂等键供重试。
func (m Model) updateUserInputAnswer(msg userInputAnswerMsg) (tea.Model, tea.Cmd) {
	if m.chat.wizard == nil {
		return m, nil
	}
	wizard := m.chat.wizard
	wizard.submitting = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		wizard.err = "提交未确认：" + errText(msg.err)
		return m, nil
	}
	m.chat.wizard = nil
	m.chat.runStatus = msg.receipt.Run.Status
	m.notice = "已提交回答，运行继续。"
	m.noticeBad = false
	return m, m.rebuildView()
}

// —— 工具详情 ——

// toolDetail 工具过程详情覆盖层：完整参数与执行结果按需加载。
type toolDetail struct {
	entries []client.TimelineEntry
	cursor  int
	expand  bool
	calls   map[string]client.Call // callID → 结果（按需加载一次）
	loading bool
}

// updateToolDetail 工具详情按键：↑↓ 选择、Enter 展开（首次展开加载结果）、Esc 返回。
func (m Model) updateToolDetail(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	detail := m.chat.tools
	switch msg.String() {
	case "esc":
		if detail.expand {
			detail.expand = false
			return m, nil
		}
		m.chat.tools = nil
		return m, nil
	case "up", "k":
		if detail.cursor > 0 {
			detail.cursor--
			detail.expand = false
		}
	case "down", "j":
		if detail.cursor < len(detail.entries)-1 {
			detail.cursor++
			detail.expand = false
		}
	case "enter", "d":
		if detail.cursor >= len(detail.entries) {
			return m, nil
		}
		entry := detail.entries[detail.cursor]
		detail.expand = !detail.expand
		if detail.expand && entry.CallID != "" && detail.calls[entry.CallID].ID == "" {
			detail.loading = true
			return m, loadCallsCmd(m.api, m.chat.runID)
		}
	}
	return m, nil
}

// loadCallsCmd 加载运行的全部工具结果（单页 100 条；TUI 逐条展开匹配）。
func loadCallsCmd(api API, runID string) tea.Cmd {
	return func() tea.Msg {
		page, err := api.ListCalls(context.Background(), runID, "")
		return callsMsg{runID: runID, calls: page.Items, err: err}
	}
}

// updateCalls 结果落地。
func (m Model) updateCalls(msg callsMsg) (tea.Model, tea.Cmd) {
	if m.chat.tools == nil {
		return m, nil
	}
	m.chat.tools.loading = false
	if msg.err != nil {
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		return m, nil // 结果加载失败静默：详情仍显示参数与状态。
	}
	if m.chat.tools.calls == nil {
		m.chat.tools.calls = map[string]client.Call{}
	}
	for _, call := range msg.calls {
		m.chat.tools.calls[call.ID] = call
	}
	return m, nil
}
