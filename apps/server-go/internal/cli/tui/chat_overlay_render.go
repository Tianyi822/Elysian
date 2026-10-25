package tui

import (
	"fmt"
	"strconv"
	"strings"

	"elysian/server/internal/cli/client"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// 第三步渲染：审批面板、等待输入向导、工具详情、计划折叠条、顶部状态栏与底部
// 快捷键栏。配色沿用聊天屏的克制中性系：成功绿、失败红、警告黄、其余灰。

// renderPlan 计划折叠条：完成数与当前步骤；展开后列出步骤（✓ 完成／● 进行中／
// ○ 待办）。
func renderPlan(b *strings.Builder, plan *client.RunPlan, expanded bool, width int) {
	if plan == nil || len(plan.Steps) == 0 {
		return
	}
	completed, current := 0, ""
	for _, step := range plan.Steps {
		switch step.Status {
		case "completed":
			completed++
		case "in_progress":
			current = step.Title
		}
	}
	summary := fmt.Sprintf("计划 %d/%d", completed, len(plan.Steps))
	if current != "" {
		summary += " · 进行中：" + current
	}
	summary += "（Ctrl+P 展开）"
	b.WriteString(selectSty.Render(truncateCells(summary, width)))
	b.WriteString("\n")
	if expanded {
		for _, step := range plan.Steps {
			marker := "○ "
			style := metaStyle
			switch step.Status {
			case "completed":
				marker, style = "✓ ", okStyle
			case "in_progress":
				marker, style = "● ", selectSty
			}
			b.WriteString(style.Render(truncateCells(marker+step.Title, width)))
			b.WriteString("\n")
		}
	}
}

// renderWizard 等待用户输入向导（替代输入区）：题目、选项（★ 推荐）、自定义文本、
// 已答摘要与键位说明。
func (s *chatState) renderWizard(b *strings.Builder, m Model) {
	wizard := s.wizard
	width := max(16, m.width-2)
	b.WriteString(warnStyle.Render(fmt.Sprintf("等待你的输入 · 第 %d/%d 题", wizard.questionIdx+1, len(wizard.request.Questions))))
	b.WriteString("\n")
	question := wizard.request.Questions[wizard.questionIdx]
	if question.Header != "" {
		b.WriteString(titleStyle.Render(truncateCells(question.Header, width)))
		b.WriteString("\n")
	}
	b.WriteString(truncateCells(question.Question, width))
	b.WriteString("\n")
	if wizard.textMode {
		b.WriteString(metaStyle.Render("自定义回答：") + wizard.textEditor.render(max(16, width-8), true))
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("Enter 提交本题 · Esc／Ctrl+t 返回选项 · ←→ 换题 · Ctrl+C 退出"))
		b.WriteString("\n")
		return
	}
	for i, option := range question.Options {
		label := option.Label
		if option.ID == question.RecommendedOptionID {
			label = "★ " + label
		}
		if option.Description != "" {
			label += " · " + option.Description
		}
		if i == wizard.optionIdx {
			b.WriteString(selectSty.Render("❯ " + truncateCells(label, width-2)))
		} else {
			b.WriteString("  " + truncateCells(label, width-2))
		}
		b.WriteString("\n")
	}
	b.WriteString(hintStyle.Render("Enter 选择 · t 自定义回答 · ←→ 换题 · Esc 返回 · Ctrl+S 停止本轮"))
	b.WriteString("\n")
	if wizard.err != "" {
		b.WriteString(warnStyle.Render(truncateCells(wizard.err, width)))
		b.WriteString("\n")
	}
	if wizard.submitting {
		b.WriteString(metaStyle.Render("正在提交回答…"))
		b.WriteString("\n")
	}
}

// renderApprovalPanel 审批面板覆盖层（替代消息区）：列表或详情。
func (s *chatState) renderApprovalPanel(b *strings.Builder, m Model) {
	panel := s.panel
	width := max(16, m.width-2)
	tabs := []string{"待审批", "本会话授权"}
	for i, tab := range tabs {
		if i == panel.tab {
			b.WriteString(selectSty.Render("❯ " + tab))
		} else {
			b.WriteString(metaStyle.Render("  " + tab))
		}
		if i == 0 {
			b.WriteString("  ")
		}
	}
	b.WriteString("\n\n")
	if panel.err != "" {
		b.WriteString(warnStyle.Render(truncateCells(panel.err, width)))
		b.WriteString("\n\n")
	}
	if panel.tab == 0 {
		s.renderApprovalList(b, m)
		return
	}
	s.renderAuthorizationList(b, m)
}

// renderApprovalList 待审批列表与详情。
func (s *chatState) renderApprovalList(b *strings.Builder, m Model) {
	panel := s.panel
	width := max(16, m.width-2)
	if len(panel.approvals) == 0 {
		b.WriteString(metaStyle.Render("暂无待审批操作。"))
		b.WriteString("\n\n")
		b.WriteString(hintStyle.Render("Esc 返回 · Tab 查看本会话授权"))
		b.WriteString("\n")
		return
	}
	for i, approval := range panel.approvals {
		name := approval.Operation.Capability.Name
		if approval.Operation.Capability.Source == "mcp" && approval.Operation.Capability.OriginalName != "" {
			name = approval.Operation.Capability.OriginalName
		}
		status := approvalStatusLabel(approval)
		line := name + " " + status
		if approval.Access != nil {
			line = name + " · 运行时授权"
		}
		if i == panel.cursor {
			b.WriteString(selectSty.Render("❯ " + truncateCells(line, width-2)))
		} else {
			b.WriteString("  " + truncateCells(line, width-2))
		}
		b.WriteString("\n")
	}
	approval := panel.approvals[panel.cursor]
	b.WriteString("\n")
	if panel.detail {
		renderApprovalDetail(b, approval, width)
	} else {
		renderApprovalSummary(b, approval, width)
	}
	b.WriteString("\n")
	b.WriteString(hintStyle.Render(approvalHint(approval)))
	b.WriteString("\n")
}

// renderApprovalSummary 卡片摘要：参数预览与危险提示。
func renderApprovalSummary(b *strings.Builder, approval client.Approval, width int) {
	if summary := argumentSummary(approval.Operation.ArgumentsJSON); summary != "" {
		b.WriteString(metaStyle.Render(truncateCells("参数："+summary, width)))
		b.WriteString("\n")
	}
	if dangerousOperation(approval.Operation) {
		b.WriteString(dangerSty.Render("可能产生不可回滚的外部修改或删除。"))
		b.WriteString("\n")
	}
	b.WriteString(metaStyle.Render("Enter/d 查看完整详情"))
	b.WriteString("\n")
}

// renderApprovalDetail 卡片详情：完整参数、文件变更、资源声明、执行镜像与授权范围。
func renderApprovalDetail(b *strings.Builder, approval client.Approval, width int) {
	operation := approval.Operation
	b.WriteString(metaStyle.Render("完整参数："))
	b.WriteString("\n")
	for _, line := range strings.Split(wrapPlain(operation.ArgumentsJSON, width-2), "\n") {
		b.WriteString("│ " + line + "\n")
	}
	for _, change := range operation.FileChanges {
		b.WriteString(metaStyle.Render("文件变更 " + truncateCells(change.Path, width-8)))
		b.WriteString("\n")
		for _, side := range []struct {
			label   string
			content *client.OperationFileContent
		}{{"修改前", change.Before}, {"修改后", change.After}} {
			switch {
			case side.content == nil:
				b.WriteString("  " + metaStyle.Render(side.label+"：不存在"))
			case side.content.Text != nil:
				text := *side.content.Text
				if text == "" {
					text = "空文件"
				}
				b.WriteString("  " + metaStyle.Render(side.label+"："+truncateCells(text, width-8)))
			default:
				size := ""
				if side.content.Bytes != nil {
					size = fmt.Sprintf("%d B · ", *side.content.Bytes)
				}
				b.WriteString("  " + metaStyle.Render(side.label+"："+size+safeText(side.content.Digest[:min(16, len(side.content.Digest))])+"…"))
			}
			b.WriteString("\n")
		}
	}
	for _, claim := range operation.ResourceClaims {
		line := claim.Kind + " / " + claim.Authority + " / " + claim.Key + " · " + claim.Access
		if claim.Subtree {
			line += " · 含子项"
		}
		b.WriteString(metaStyle.Render(truncateCells(line, width)))
		b.WriteString("\n")
	}
	if operation.Execution != nil {
		b.WriteString(metaStyle.Render("镜像 " + safeText(operation.Execution.Profile.Image)))
		b.WriteString("\n")
		if operation.Execution.Grant != nil {
			for _, directory := range operation.Execution.Grant.Directories {
				b.WriteString(metaStyle.Render(truncateCells("目录 "+directory.Path+" · "+directory.Access, width)))
				b.WriteString("\n")
			}
			for _, endpoint := range operation.Execution.Grant.Network {
				b.WriteString(metaStyle.Render(truncateCells(fmt.Sprintf("网络 %s://%s:%d", endpoint.Scheme, endpoint.Host, endpoint.Port), width)))
				b.WriteString("\n")
			}
		}
	}
	if approval.Access != nil {
		renderAccessScope(b, *approval.Access, width)
	}
	if dangerousOperation(operation) {
		b.WriteString(dangerSty.Render("可能产生不可回滚的外部修改或删除。"))
		b.WriteString("\n")
	}
}

// renderAccessScope 运行时授权范围（目录／网络／镜像与原因）。
func renderAccessScope(b *strings.Builder, access client.AccessReq, width int) {
	if access.Reason != "" {
		b.WriteString(metaStyle.Render(truncateCells("理由："+access.Reason, width)))
		b.WriteString("\n")
	}
	if access.Runtime != nil {
		b.WriteString(metaStyle.Render("运行环境 " + safeText(access.Runtime.Image)))
		b.WriteString("\n")
	}
	for _, directory := range access.Directories {
		b.WriteString(metaStyle.Render(truncateCells("目录 "+directory.Path+" · "+directory.Access, width)))
		b.WriteString("\n")
	}
	for _, endpoint := range access.Network {
		b.WriteString(metaStyle.Render(truncateCells(fmt.Sprintf("网络 %s://%s:%d", endpoint.Scheme, endpoint.Host, endpoint.Port), width)))
		b.WriteString("\n")
	}
}

// renderAuthorizationList 本会话授权列表（可撤回）。
func (s *chatState) renderAuthorizationList(b *strings.Builder, m Model) {
	panel := s.panel
	width := max(16, m.width-2)
	if panel.authLoading {
		b.WriteString(metaStyle.Render("正在读取授权…"))
		b.WriteString("\n\n")
		b.WriteString(hintStyle.Render("Esc 返回 · Tab 返回待审批"))
		b.WriteString("\n")
		return
	}
	if len(panel.auths) == 0 {
		b.WriteString(metaStyle.Render("本会话没有已允许的授权。"))
		b.WriteString("\n\n")
		b.WriteString(hintStyle.Render("Esc 返回 · Tab 返回待审批"))
		b.WriteString("\n")
		return
	}
	for i, auth := range panel.auths {
		line := auth.Tool + " · " + auth.Status + " · " + formatActivity(auth.CreatedAt)
		if i == panel.authCursor {
			b.WriteString(selectSty.Render("❯ " + truncateCells(line, width-2)))
		} else {
			b.WriteString("  " + truncateCells(line, width-2))
		}
		b.WriteString("\n")
	}
	b.WriteString("\n")
	if auth := panel.auths[panel.authCursor]; auth.ID != "" {
		renderAccessScope(b, auth.Access, width)
	}
	b.WriteString("\n")
	b.WriteString(hintStyle.Render("r 撤回该授权 · Esc 返回 · Tab 返回待审批"))
	b.WriteString("\n")
}

// approvalStatusLabel 审批状态标签。
func approvalStatusLabel(approval client.Approval) string {
	switch approval.Status {
	case "pending":
		return "待审批"
	case "approved":
		return okStyle.Render("已批准，等待执行")
	case "denied":
		return dangerSty.Render("已拒绝")
	case "expired":
		return warnStyle.Render("已过期")
	case "revoked":
		return warnStyle.Render("已撤销")
	}
	return metaStyle.Render(safeText(approval.Status))
}

// dangerousOperation 危险判定（与 Web ChatApprovals 同口径：非只读 builtin，或
// 授权目录含 rw）。
func dangerousOperation(operation client.Operation) bool {
	if !operation.Capability.ReadOnly && operation.Capability.Source == "builtin" {
		return true
	}
	if operation.Execution != nil && operation.Execution.Grant != nil {
		for _, directory := range operation.Execution.Grant.Directories {
			if directory.Access == "rw" {
				return true
			}
		}
	}
	return false
}

// approvalHint 卡片操作键位（授权卡与普通审批不同）。
func approvalHint(approval client.Approval) string {
	if approval.Access != nil {
		if approval.Status != "pending" {
			return "Esc 返回 · Tab 切换"
		}
		return "1 仅本次 · 2 本会话允许 · 3 拒绝 · x 取消本轮 · Enter/d 详情 · Esc 返回"
	}
	if approval.Status != "pending" {
		return "Esc 返回 · x 取消本轮 · Tab 切换"
	}
	return "y 批准 · n 拒绝 · x 取消本轮 · Enter/d 详情 · Esc 返回"
}

// renderToolDetail 工具过程详情覆盖层（含上下文用量分类明细，Web 环形浮层的终端
// 等价形态）。
func (s *chatState) renderToolDetail(b *strings.Builder, m Model) {
	detail := s.tools
	if detail.err != "" {
		b.WriteString(wrapPlain(detail.err, max(16, m.width-2)) + "\n")
	}
	width := max(16, m.width-2)
	b.WriteString(titleStyle.Render("工具调用过程"))
	b.WriteString("\n\n")
	if usage := renderContextUsageDetail(s, m, width); usage != "" {
		b.WriteString(usage)
		b.WriteString("\n")
	}
	if len(detail.entries) == 0 {
		b.WriteString(metaStyle.Render("本轮没有工具调用。"))
		b.WriteString("\n")
	} else {
		for i, entry := range detail.entries {
			label := entry.Tool + " " + toolStatusLabel(entry.Status)
			if i == detail.cursor {
				b.WriteString(selectSty.Render("❯ " + truncateCells(label, width-2)))
			} else {
				b.WriteString("  " + truncateCells(label, width-2))
			}
			b.WriteString("\n")
		}
		if detail.cursor < len(detail.entries) {
			entry := detail.entries[detail.cursor]
			b.WriteString("\n")
			b.WriteString(metaStyle.Render("完整参数："))
			b.WriteString("\n")
			for _, line := range strings.Split(wrapPlain(entry.ArgumentsJSON, width-2), "\n") {
				b.WriteString("│ " + line + "\n")
			}
			if call, ok := detail.calls[entry.CallID]; ok && entry.CallID != "" {
				b.WriteString(metaStyle.Render("执行结果："))
				b.WriteString("\n")
				if call.Error != nil && call.Error.Message != "" {
					b.WriteString(dangerSty.Render(truncateCells("✗ "+call.Error.Message, width)))
					b.WriteString("\n")
				}
				if len(call.Result) > 0 {
					result := wrapPlain(string(call.Result), width-2)
					if displayWidth(result) > 2000 {
						result = truncateCells(result, 2000) + "\n…（结果过长，截断显示）"
					}
					for _, line := range strings.Split(result, "\n") {
						b.WriteString("│ " + line + "\n")
					}
					if call.Truncated {
						b.WriteString(metaStyle.Render("…（服务端已截断保存）"))
						b.WriteString("\n")
					}
				}
			} else if detail.loading {
				b.WriteString(metaStyle.Render("正在加载执行结果…"))
				b.WriteString("\n")
			} else if entry.CallID == "" {
				b.WriteString(metaStyle.Render("（该调用尚无执行结果）"))
				b.WriteString("\n")
			}
		}
	}
	b.WriteString("\n")
	b.WriteString(hintStyle.Render("Enter/d 展开/收起并加载结果 · ↑↓ 选择 · Esc 返回"))
	b.WriteString("\n")
}

// chatStatusBar 顶部状态栏：会话 · 模型 · 思考档 · 权限模式 · 运行状态 · 待审批徽标 ·
// 上下文用量文本。宽度不足时先压缩模型与标题段（会话身份尽量保留最短形态），
// 思考档之后的尾部事实段保真到最后，仍不够再整行截断兜底。
func chatStatusBar(m Model) string {
	chat := &m.chat
	width := max(16, m.width-2)
	// 尾部固定段：预算优先保住（运行状态、徽标与用量不能被截断吞掉）。
	var tailPlain, tailStyled []string
	tailWidth := 0
	pushTail := func(text string, style lipgloss.Style) {
		if text == "" {
			return
		}
		text = safeText(text)
		tailPlain = append(tailPlain, text)
		tailStyled = append(tailStyled, style.Render(text))
		tailWidth += displayWidth(text)
	}
	if level := m.currentLevel(chatSessionOf(m)); level != "" {
		pushTail("思考 "+client.ReasoningLabel(level), metaStyle)
	}
	pushTail("权限 "+client.PermissionModeLabel(m.currentPermissionMode(chatSessionOf(m))), metaStyle)
	if chat.runStatus != "" {
		pushTail(runStatusLabel(chat.runStatus, chat.stopping), runStatusStyle(chat.runStatus, chat.stopping))
	}
	if pending := pendingApprovalCount(chat.pendingApprovals); pending > 0 {
		pushTail(fmt.Sprintf("● %d 项待审批", pending), warnStyle)
	}
	pushTail(contextUsageLabel(chat.timeline), metaStyle)

	title := safeText(sessionTitle(chat))
	model := ""
	if line := modelLine(chatSessionOf(m), m); line != "" && chat.session != nil {
		model = safeText(line)
	}
	// 分隔符 " · " 占 3 列：先按「标题＋尾部段」齐全计（N 段尾部配 N 个分隔符），
	// 模型保留时再补其自身与一个分隔符的宽度。
	budget := width - 3*len(tailPlain) - tailWidth
	if model != "" {
		if displayWidth(model) > min(30, max(4, budget-7)) {
			if modelBudget := min(30, budget-7); modelBudget >= 4 {
				model = truncateCells(model, modelBudget)
			} else {
				model = ""
			}
		}
	}
	if model != "" {
		budget -= displayWidth(model) + 3
	}
	if displayWidth(title) > budget {
		if budget >= 4 {
			title = truncateCells(title, budget)
		} else {
			title = ""
		}
	}
	parts := make([]string, 0, len(tailStyled)+2)
	if title != "" {
		parts = append(parts, titleStyle.Render(title))
	}
	if model != "" {
		parts = append(parts, metaStyle.Render(model))
	}
	parts = append(parts, tailStyled...)
	return ansi.Truncate(strings.Join(parts, " · "), width, "…")
}

// pendingApprovalCount 仍处待决定状态的审批数（徽标数据）。
func pendingApprovalCount(approvals []client.Approval) int {
	pending := 0
	for _, approval := range approvals {
		if approval.Status == "pending" {
			pending++
		}
	}
	return pending
}

// contextUsageLabel 上下文用量文本（Web ChatUsageIndicator 环形浮层的终端替代形态，
// 终端展示）：total 未报告时如实标注不补零，容量已知且大于 0 才计
// 占比（与 Web contextValue 同口径）；Run 累计与平均缓存命中随可用追加（缺失不补
// 零、无有效分母不计比例）；无 timeline 时不显示。完整分类明细在
// Ctrl+O 执行详情覆盖层。
func contextUsageLabel(timeline *client.ChatTimeline) string {
	if timeline == nil {
		return ""
	}
	usage := timeline.ContextUsage
	label := ""
	if usage != nil {
		total := "未报告"
		if usage.TotalTokens != nil {
			total = formatTokenCount(*usage.TotalTokens)
		}
		label = "上下文 " + total + "/" + formatTokenCount(usage.ContextTokens)
		if usage.TotalTokens != nil && usage.ContextTokens > 0 {
			label += fmt.Sprintf("（%.1f%%）", float64(*usage.TotalTokens)/float64(usage.ContextTokens)*100)
		}
	}
	if timeline.Usage != nil && timeline.Usage.ActualTokens != nil {
		label += " · 累计 " + formatTokenCount(*timeline.Usage.ActualTokens)
	}
	if timeline.Usage != nil && timeline.Usage.CachedTokens != nil {
		label += " · 缓存 token " + formatTokenCount(*timeline.Usage.CachedTokens)
	}
	if hit := timeline.CacheHitUsage; hit != nil && hit.InputTokens > 0 {
		label += fmt.Sprintf(" · 缓存 %s/%s（%.0f%%）", formatTokenCount(hit.CachedTokens), formatTokenCount(hit.InputTokens), float64(hit.CachedTokens)/float64(hit.InputTokens)*100)
	}
	return strings.TrimPrefix(label, " · ")
}

// renderContextUsageDetail 上下文用量分类明细（Ctrl+O 覆盖层首节）：最近一次确认
// 推理的模型、单次用量与容量占比、Run 累计、平均缓存命中，以及六项互斥来源的分类
// 占比（装配期本地估算，明确标注）；各段只在数据存在时出现，缺失不补零。
func renderContextUsageDetail(s *chatState, m Model, width int) string {
	timeline := s.timeline
	if timeline == nil {
		return ""
	}
	usage := timeline.ContextUsage
	var b strings.Builder
	b.WriteString(metaStyle.Render("上下文用量"))
	b.WriteString("\n")
	if usage != nil {
		first := truncateCells("模型 "+usage.Model, width)
		b.WriteString(first)
		b.WriteString("\n")
		total := "未报告"
		if usage.TotalTokens != nil {
			total = formatTokenCount(*usage.TotalTokens)
		}
		line := "单次推理 " + total + "/" + formatTokenCount(usage.ContextTokens)
		if usage.TotalTokens != nil && usage.ContextTokens > 0 {
			line += fmt.Sprintf("（%.1f%%）", float64(*usage.TotalTokens)/float64(usage.ContextTokens)*100)
		}
		b.WriteString(truncateCells(line, width))
		b.WriteString("\n")
	} else {
		b.WriteString("单次推理用量未报告\n")
	}
	if timeline.Usage != nil && timeline.Usage.ActualTokens != nil {
		b.WriteString(truncateCells("本轮累计 "+formatTokenCount(*timeline.Usage.ActualTokens)+" token", width))
		b.WriteString("\n")
	}
	if timeline.Usage != nil && timeline.Usage.CachedTokens != nil {
		b.WriteString("缓存 token " + formatTokenCount(*timeline.Usage.CachedTokens) + "\n")
	}
	if hit := timeline.CacheHitUsage; hit != nil && hit.InputTokens > 0 {
		b.WriteString(truncateCells(fmt.Sprintf("平均缓存命中 %s/%s（%.0f%%）", formatTokenCount(hit.CachedTokens), formatTokenCount(hit.InputTokens), float64(hit.CachedTokens)/float64(hit.InputTokens)*100), width))
		b.WriteString("\n")
	}
	if usage != nil && usage.EstimatedBreakdown != nil {
		breakdown := usage.EstimatedBreakdown
		b.WriteString(metaStyle.Render("分类占用（本地估算）"))
		b.WriteString("\n")
		segments := []struct {
			label string
			value int
		}{
			{"消息", breakdown.Messages},
			{"系统工具", breakdown.SystemTools},
			{"其他", breakdown.Other},
			{"技能", breakdown.Skills},
			{"系统提示词", breakdown.SystemPrompt},
			{"MCP 工具", breakdown.MCPTools},
		}
		sum := 0
		for _, segment := range segments {
			sum += segment.value
		}
		for _, segment := range segments {
			if segment.value <= 0 {
				continue
			}
			b.WriteString(truncateCells(fmt.Sprintf("· %s %s（%.1f%%）", segment.label, formatTokenCount(segment.value), float64(segment.value)/float64(sum)*100), width))
			b.WriteString("\n")
		}
	}
	return strings.TrimSuffix(b.String(), "\n")
}

// formatTokenCount 千分位计数（与 Web 侧 en-US 数字格式一致）。
func formatTokenCount(n int) string {
	digits := strconv.Itoa(n)
	if len(digits) <= 3 {
		return digits
	}
	var b strings.Builder
	for i, digit := range digits {
		if i > 0 && (len(digits)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(digit)
	}
	return b.String()
}

func sessionTitle(chat *chatState) string {
	if chat.session != nil && chat.session.Title != "" {
		return chat.session.Title
	}
	return "会话"
}

// chatShortcutBar 底部快捷键栏：按上下文（向导／覆盖层／等待审批／运行中／空闲）；
// 运行中权限模式锁定，故仅空闲档提示 Shift+Tab。
func chatShortcutBar(m Model) string {
	chat := &m.chat
	switch {
	case chat.wizard != nil:
		return hintStyle.Render("Enter 选择 · t 自定义 · ←→ 换题 · Esc 返回 · Ctrl+S 停止本轮 · Ctrl+C 退出")
	case chat.runStatus == "waiting-approval" || chat.runStatus == "preparing-runtime":
		return hintStyle.Render("Ctrl+A 审批面板 · Ctrl+S 停止 · PgUp/PgDn 滚动 · Esc 返回 · Ctrl+C 退出")
	case activeRun(chat.runStatus):
		return hintStyle.Render("Ctrl+S 停止 · Ctrl+O 工具过程 · Ctrl+T 思考 · Ctrl+P 计划 · PgUp/PgDn 滚动 · Esc 返回")
	default:
		return hintStyle.Render("Enter 发送 · Ctrl+J 换行 · Shift+Tab 权限 · Ctrl+A 审批 · Ctrl+O 工具过程 · Esc 返回 · Ctrl+C 退出")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
