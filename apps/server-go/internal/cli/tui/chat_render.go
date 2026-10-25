package tui

import (
	"strconv"
	"strings"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
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
	m.chat.viewport.SetContent(m.chat.renderContent(model))
	if m.chat.follow {
		m.chat.viewport.GotoBottom()
	}
}

// renderContent 聊天区全文：历史消息 + 活跃流式区。
func (s *chatState) renderContent(m Model) string {
	var b strings.Builder
	width := max(16, m.width-2)
	if s.loading {
		b.WriteString(metaStyle.Render("正在读取会话…"))
		b.WriteString("\n")
		return b.String()
	}
	if s.loadErr != "" {
		b.WriteString(warnStyle.Render(truncateCells(s.loadErr, width)))
		b.WriteString("\n")
		return b.String()
	}
	// 历史公开消息。
	for _, message := range s.messages {
		s.renderMessage(&b, m, message, width)
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

// renderMessage 单条公开消息：用户消息原文引用块、助手消息 Markdown；助手消息
// 前缀所属轮次模型与思考档快照（缺失按未知）。
func (s *chatState) renderMessage(b *strings.Builder, m Model, message client.Message, width int) {
	at := formatActivity(message.CreatedAt)
	switch message.Role {
	case "user":
		b.WriteString(selectSty.Render("你") + metaStyle.Render(" · "+at))
		b.WriteString("\n")
		for _, line := range strings.Split(wrapPlain(message.Content, width-2), "\n") {
			b.WriteString("│ " + line + "\n")
		}
		b.WriteString("\n")
	case "assistant":
		header := "Ely"
		if message.RunConfig != nil && message.RunConfig.ModelName != "" {
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
		b.WriteString(metaStyle.Render(message.Role + " · " + message.Content))
		b.WriteString("\n\n")
	}
}

// renderStream 活跃 Run 流式区：思考（默认折叠摘要行，Ctrl+T 展开）、工具条目
// （名称＋状态＋参数摘要）、流式正文（Markdown）与运行状态行。
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
	if frame.Content != "" {
		b.WriteString(okStyle.Render("Ely"))
		if !frame.Done {
			b.WriteString(metaStyle.Render(" · 正在回复…"))
		}
		b.WriteString("\n")
		b.WriteString(m.markdown.render(frame.Content))
		b.WriteString("\n\n")
		return
	}
	if !frame.Done && frame.Reasoning == "" {
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
	line := style.Render(label)
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
	var b strings.Builder
	if m.width < 60 || m.height < 12 {
		b.WriteString(warnStyle.Render("终端过小：请调整窗口至少 60×12 后继续。"))
		b.WriteString("\n")
		return b.String()
	}
	width := max(16, m.width-2)
	b.WriteString(truncateCells(chatStatusBar(m), width))
	b.WriteString("\n")
	if s.plan != nil {
		renderPlan(&b, s.plan, s.showPlan, width)
	}
	if s.runID != "" && !s.streamHealthy && activeRun(s.runStatus) {
		b.WriteString(warnStyle.Render(truncateCells("实时连接暂时中断，正在重新连接；已接收的内容已保留", width)))
		b.WriteString("\n")
	}
	if s.lastRun != nil && terminalRun(s.lastRun.Status) {
		if outcome := client.RunOutcome(*s.lastRun); outcome.Detail != "" {
			style := metaStyle
			if outcome.Failed {
				style = dangerSty
			}
			b.WriteString(style.Render(truncateCells("最近运行："+outcome.Label+"："+outcome.Detail, width)))
			b.WriteString("\n")
		}
	}
	switch {
	case s.panel != nil:
		s.renderApprovalPanel(&b, m)
	case s.tools != nil:
		s.renderToolDetail(&b, m)
	default:
		b.WriteString(s.viewport.View())
	}
	b.WriteString("\n")
	if s.stopping && s.wizard == nil {
		b.WriteString(metaStyle.Render("正在停止…"))
		b.WriteString("\n")
	}
	if s.wizard != nil {
		s.renderWizard(&b, m)
	} else if s.panel == nil && s.tools == nil {
		b.WriteString(s.editor.View())
		b.WriteString("\n")
	}
	b.WriteString(chatShortcutBar(m))
	b.WriteString("\n")
	return b.String()
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
		return "等待用户输入（交互界面将在后续版本接入）"
	case "waiting-approval":
		return "等待审批（审批界面将在后续版本接入）"
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

// currentLevel 本会话当前思考档：本地选择优先，否则按模型声明推导默认档。
func (m Model) currentLevel(session client.Session) string {
	if level, ok := m.levels[session.ID]; ok && level != "" {
		return level
	}
	for _, profile := range m.list.models {
		if profile.ID == session.ModelProfileID {
			return client.DefaultReasoningLevel(profile.Capabilities.ReasoningLevels, profile.Capabilities.DefaultReasoningLevel)
		}
	}
	return ""
}
