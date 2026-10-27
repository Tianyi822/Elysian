package tui

import (
	"strconv"
	"strings"

	"elysian/server/internal/cli/client"
	"elysian/server/internal/cli/termui"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// 聊天屏渲染：历史公开消息（用户原文本／助手 Markdown）、活跃 Run 的流式区
// （思考折叠、工具条目、流式正文）与状态行。消息区经 viewport 滚动，跟随底部
// 由按键与增量更新维护。

// toolStatusLabel 工具条目状态标签（timeline entry status 的中文映射，未知回原文）。
func toolStatusLabel(status string) string {
	labels := map[string]string{
		"planned":      "待执行",
		"queued":       "排队中",
		"running":      "运行中",
		"succeeded":    "成功",
		"failed":       "失败",
		"cancelled":    "已取消",
		"interrupted":  "已中断",
		"unknown":      "结果未知",
		"not-executed": "未执行",
		"denied":       "审批已拒绝",
		"expired":      "审批已过期",
		"revoked":      "审批已撤销",
	}
	if label, ok := labels[status]; ok {
		return label
	}
	return status
}

// rebuildView 重建消息区内容（值语义 Model 上的命令包装）。
func (m Model) rebuildView() tea.Cmd {
	return func() tea.Msg { return chatRenderMsg{} }
}

// chatRenderMsg 重渲染请求（Update 内直接重建内容，无异步数据）。
type chatRenderMsg struct{}

// applyRender 重建 viewport 内容并按跟随位滚动。
func (m *Model) applyRender() {
	model := *m
	lines := strings.Split(m.chat.renderContent(model), "\n")
	for len(lines) > 0 && strings.TrimSpace(ansi.Strip(lines[len(lines)-1])) == "" {
		lines = lines[:len(lines)-1]
	}
	m.chat.viewport.SetContent(strings.Join(lines, "\n"))
	if m.chat.follow {
		m.chat.viewport.GotoBottom()
	}
}

// renderContent 聊天区全文：历史消息 + 活跃流式区。
func (s *chatState) renderContent(m Model) string {
	var b strings.Builder
	width := max(16, m.width-2)
	if s.loading {
		b.WriteString(metaStyle.Render("正在读取会话…（完成前暂不能发送）"))
		b.WriteString("\n")
		return b.String()
	}
	if s.loadErr != "" {
		b.WriteString(warnStyle.Render(truncateCells(s.loadErr, width)))
		b.WriteString("\n")
		b.WriteString(metaStyle.Render("按 r 重新读取；读取成功前暂不能发送。"))
		b.WriteString("\n")
		return b.String()
	}
	// 历史公开消息。
	for _, message := range s.messages {
		s.renderMessage(&b, m, message, width)
	}
	if s.stream == nil && s.timeline != nil {
		if s.showReasoning {
			for _, entry := range s.timeline.Entries {
				if entry.Kind == "reasoning" {
					b.WriteString("思考：\n" + wrapPlain(entry.Text, width) + "\n")
				}
			}
		}
		b.WriteString("F3 查看完整思考与执行历史\n")
		if s.timeline.TerminalResult != nil && !s.finalConfirmed(s.timeline.RunID) {
			b.WriteString(warnStyle.Render("运行结果") + "\n" + wrapPlain(s.timeline.TerminalResult.Content, width) + "\n")
		}
	}
	// 活跃 Run 的流式区（终态后保留快照展示，直至离开或新轮次）。
	if s.stream != nil {
		s.renderStream(&b, m, *s.stream, width)
	}
	if len(s.messages) == 0 && s.stream == nil {
		b.WriteString(metaStyle.Render("暂无消息：输入内容开始对话。"))
		b.WriteString("\n")
	}
	return b.String()
}

// finalConfirmed 该 Run 的公开最终消息是否已进历史（终态后增量回读确认）：确认后
// 隐藏流式正文，避免同一答复在历史与流式区重复展示；思考与工具事实保留展示。
func (s *chatState) finalConfirmed(runID string) bool {
	if runID == "" {
		return false
	}
	for i := range s.messages {
		if s.messages[i].RunID == runID && s.messages[i].Role == "assistant" {
			return true
		}
	}
	return false
}

// renderMessage 单条公开消息：用户消息原文引用块、助手消息 Markdown；助手消息
// 前缀所属轮次模型与思考档快照（缺失按未知）。
func (s *chatState) renderMessage(b *strings.Builder, m Model, message client.Message, width int) {
	at := formatActivity(message.CreatedAt)
	switch message.Role {
	case "user":
		b.WriteString(selectSty.Render("你") + metaStyle.Render(" · "+at))
		b.WriteString("\n")
		for _, a := range message.Attachments {
			b.WriteString("图片：" + safeText(a.Name) + " · F4 导出\n")
		}
		for _, line := range strings.Split(wrapPlain(message.Content, width-2), "\n") {
			b.WriteString("│ " + line + "\n")
		}
		b.WriteString("\n")
	case "assistant":
		header := "Ely"
		if message.Origin == "runtime" {
			header = "运行结果"
		}
		if message.Origin != "runtime" && message.RunConfig != nil && message.RunConfig.ModelName != "" {
			header += " · " + message.RunConfig.ModelName
			if message.RunConfig.ReasoningLevel != "" {
				header += " · 思考 " + client.ReasoningLabel(message.RunConfig.ReasoningLevel)
			}
		}
		b.WriteString(okStyle.Render(header) + metaStyle.Render(" · "+at))
		b.WriteString("\n")
		b.WriteString(m.markdown.render(message.Content))
		b.WriteString("\n\n")
	default:
		b.WriteString(metaStyle.Render(safeText(message.Role + " · " + message.Content)))
		b.WriteString("\n\n")
	}
}

// renderStream 活跃 Run 流式区：思考（默认折叠摘要行，Ctrl+T 展开）、工具条目
// （名称＋状态＋参数摘要）、流式正文（Markdown）与运行状态行；该 Run 的公开最终
// 消息确认进历史后不再重复渲染流式正文（思考与工具事实保留）。
func (s *chatState) renderStream(b *strings.Builder, m Model, frame client.ChatOutput, width int) {
	if frame.Reasoning != "" {
		if s.showReasoning {
			b.WriteString(metaStyle.Render("思考："))
			b.WriteString("\n")
			for _, line := range strings.Split(wrapPlain(frame.Reasoning, width-2), "\n") {
				b.WriteString(metaStyle.Render("│ " + line))
				b.WriteString("\n")
			}
		} else {
			firstLine := strings.SplitN(frame.Reasoning, "\n", 2)[0]
			b.WriteString(metaStyle.Render(truncateCells("思考（Ctrl+T 展开）："+firstLine, width)))
			b.WriteString("\n")
		}
	}
	if frame.Timeline != nil {
		for _, entry := range frame.Timeline.Entries {
			if entry.Kind != "tool" {
				continue
			}
			s.renderToolEntry(b, entry, width)
		}
	}
	if frame.Content != "" && !s.finalConfirmed(frame.RunID) {
		b.WriteString(okStyle.Render("Ely"))
		if !frame.Done {
			b.WriteString(metaStyle.Render(" · 正在回复…"))
		}
		b.WriteString("\n")
		b.WriteString(m.markdown.render(frame.Content))
		b.WriteString("\n\n")
		return
	}
	if !frame.Done && frame.Reasoning == "" && !s.finalConfirmed(frame.RunID) {
		b.WriteString(metaStyle.Render("Ely 正在准备回复…"))
		b.WriteString("\n")
	}
}

// renderToolEntry 工具条目：名称＋状态标签＋参数摘要（失败附服务端消息）。
func (s *chatState) renderToolEntry(b *strings.Builder, entry client.TimelineEntry, width int) {
	label := "⚙ " + entry.Tool + " " + toolStatusLabel(entry.Status)
	style := metaStyle
	switch entry.Status {
	case "succeeded":
		style = okStyle
	case "failed", "denied", "expired", "revoked":
		style = dangerSty
	case "running", "queued", "planned":
		style = metaStyle
	}
	line := style.Render(safeText(label))
	if summary := argumentSummary(entry.ArgumentsJSON); summary != "" {
		line += " " + metaStyle.Render(truncateCells(summary, max(10, width-displayWidth(label)-2)))
	}
	b.WriteString(line)
	b.WriteString("\n")
	if entry.Error != nil && entry.Error.Message != "" {
		b.WriteString(dangerSty.Render(truncateCells("  ✗ "+entry.Error.Message, width)))
		b.WriteString("\n")
	}
}

// argumentSummary 参数摘要：紧凑 JSON（去空白）截前 60 显示宽。
func argumentSummary(raw string) string {
	compact := strings.Join(strings.Fields(raw), "")
	if compact == "" || compact == "{}" {
		return ""
	}
	return truncateCells(compact, 60)
}

// chatView 聊天屏整体布局：顶部状态栏（会话/模型/思考/权限/连接/运行/审批徽标/
// 上下文用量）、计划折叠条、消息区（viewport；审批面板或工具详情覆盖层替代）、
// 等待输入向导或多行输入、底部上下文快捷键栏；低于最小可用尺寸时提示调整终端
// （方案 §6.2）。
func (s *chatState) view(m Model) string {
	if s.history != nil {
		return s.history.view()
	}
	if s.attachmentPanel != nil {
		return m.attachmentView()
	}
	if m.width < 60 || m.height < 12 {
		return warnStyle.Render("终端过小：请调整窗口至少 60×12 后继续。") + "\n"
	}
	top, bottom := s.chrome(m)
	var content strings.Builder
	switch {
	case s.panel != nil:
		s.renderApprovalPanel(&content, m)
	case s.tools != nil:
		s.renderToolDetail(&content, m)
	default:
		content.WriteString(s.viewport.View())
	}
	return top + content.String() + "\n" + bottom
}

// chrome 同时用于渲染和高度测量，避免边框、提示和计划挤出输入区。
func (s *chatState) chrome(m Model) (string, string) {
	var top, bottom strings.Builder
	width := max(16, m.width-2)
	top.WriteString(chatStatusBar(m) + "\n")
	if s.plan != nil {
		renderPlan(&top, s.plan, s.showPlan, width)
	}
	if s.runID != "" && !s.streamHealthy && activeRun(s.runStatus) {
		top.WriteString(warnStyle.Render(truncateCells("实时连接暂时中断，正在重新连接；已接收的内容已保留", width)) + "\n")
	}
	if s.lastRun != nil && terminalRun(s.lastRun.Status) {
		if outcome := client.RunOutcome(*s.lastRun); outcome.Detail != "" {
			style := metaStyle
			if outcome.Failed {
				style = dangerSty
			}
			top.WriteString(style.Render(truncateCells("最近运行："+outcome.Label+"："+outcome.Detail, width)) + "\n")
		}
	}
	if s.stopping && s.wizard == nil {
		bottom.WriteString(metaStyle.Render("正在停止…") + "\n")
	}
	if s.wizard != nil {
		s.renderWizard(&bottom, m)
	} else if s.panel == nil && s.tools == nil {
		label := "消息 · Enter 发送 / Ctrl+J 换行"
		if s.editing != nil {
			label = "编辑最后一条用户消息 · Esc 返回草稿"
		}
		if len(*m.draftAttachments()) > 0 {
			bottom.WriteString("图片附件：" + strconv.Itoa(len(*m.draftAttachments())) + " 张 · F4 管理\n")
		}
		bottom.WriteString(termui.Panel(label, s.editor.View(), width, true) + "\n")
	}
	bottom.WriteString(termui.Hints(chatShortcutBar(m), width) + "\n")
	return top.String(), bottom.String()
}

func (m *Model) layoutChat() {
	if m.phase != phaseSession {
		return
	}
	m.chat.editor.SetWidth(max(16, m.width-6))
	m.chat.editor.SetHeight(min(chatEditorHeight, max(1, (m.height-10)/2)))
	top, bottom := m.chat.chrome(*m)
	outside := lipgloss.Height(strings.TrimSuffix(m.header(), "\n"))
	if m.notice != "" {
		outside += 2
	}
	m.chat.viewport.Width = max(16, m.width-2)
	m.chat.viewport.Height = max(1, m.height-outside-lipgloss.Height(strings.TrimSuffix(top+bottom, "\n"))-1)
	if m.chat.follow {
		m.chat.viewport.GotoBottom()
	}
}

// runStatusLabel 运行状态行文案（运行中/等待态/终态；纯文本，样式由调用方按
// runStatusStyle 施加）。
func runStatusLabel(status string, stopping bool) string {
	if stopping && activeRun(status) {
		return "正在停止…"
	}
	switch status {
	case "running":
		return "运行中"
	case "queued":
		return "排队中"
	case "waiting-input":
		return "等待用户输入"
	case "waiting-approval":
		return "等待审批"
	case "waiting-resource":
		return "等待资源"
	case "waiting-task":
		return "等待任务"
	case "succeeded":
		return "已完成"
	case "failed":
		return "运行失败"
	case "cancelled":
		return "已停止"
	case "interrupted":
		return "运行已中断"
	case "recovery-required":
		return "需要恢复"
	}
	if status != "" {
		return status
	}
	return ""
}

// runStatusStyle 运行状态样式：运行绿、失败红、等待黄、其余灰。
func runStatusStyle(status string, stopping bool) lipgloss.Style {
	if stopping && activeRun(status) {
		return warnStyle
	}
	switch status {
	case "running":
		return okStyle
	case "failed", "interrupted", "recovery-required":
		return dangerSty
	case "waiting-input", "waiting-approval", "waiting-resource", "waiting-task":
		return warnStyle
	}
	return metaStyle
}

// modelLine 会话当前模型行：模型名（服务名）id@rev（目录未命中回 id@rev）。
func modelLine(session client.Session, m Model) string {
	for _, profile := range m.list.models {
		if profile.ID == session.ModelProfileID {
			label := profile.Model
			if profile.Service != nil && profile.Service.Name != "" {
				label += "（" + profile.Service.Name + "）"
			}
			return label + " · " + session.ModelProfileID + "@" + strconv.Itoa(session.ModelRevision)
		}
	}
	return session.ModelProfileID + "@" + strconv.Itoa(session.ModelRevision)
}

// currentLevel 本会话当前思考档：本地选择须仍属于当前会话模型声明的档位表（跨模型
// 切换或服务端目录修订后旧选择可能失配，按声明默认档回落），否则按模型声明推导默认档。
func (m Model) currentLevel(session client.Session) string {
	var profile *client.ModelProfile
	for i := range m.list.models {
		if m.list.models[i].ID == session.ModelProfileID {
			profile = &m.list.models[i]
			break
		}
	}
	if profile == nil {
		return ""
	}
	if level, ok := m.levels[session.ID]; ok && level != "" {
		for _, declared := range profile.Capabilities.ReasoningLevels {
			if declared == level {
				return level
			}
		}
	}
	return client.DefaultReasoningLevel(profile.Capabilities.ReasoningLevels, profile.Capabilities.DefaultReasoningLevel)
}
