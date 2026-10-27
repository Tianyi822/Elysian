package tui

import (
	"context"
	"fmt"
	"strings"

	"elysian/server/internal/cli/client"

	tea "github.com/charmbracelet/bubbletea"
)

// 模型选择向导（新建会话与切换会话模型共用）：标题（仅新建）→ 模型 → 思考档
// （仅模型声明档位时出现，默认档预选）；新建成功直接进入会话，切换成功回列表。
// 无可用模型（active＋text＋tools 过滤后为空）时如实说明并引导到 Web 设置页，
// 不提供任何占位模型。

type pickerMode int

const (
	pickerCreate pickerMode = iota
	pickerSwitch
)

type pickerStep int

const (
	stepTitle pickerStep = iota
	stepModel
	stepLevel
)

type pickerState struct {
	mode      pickerMode
	step      pickerStep
	models    []client.ModelProfile
	sessionID string // 切换模式的目标会话

	title     *lineEditor
	cursor    int
	level     int  // stepLevel 光标（档位表索引）
	chosen    int  // stepModel 已选模型索引
	levelOnly bool // 同模型调整思考档：不经 SwitchSessionModel，只更新本地每轮档位
	busy      bool // 创建／切换在途
	failed    string
}

func newPickerState(mode pickerMode, models []client.ModelProfile, sessionID string) pickerState {
	state := pickerState{mode: mode, models: models, sessionID: sessionID, title: newLineEditor(false)}
	if mode == pickerCreate {
		state.step = stepTitle
	} else {
		state.step = stepModel
	}
	return state
}

// sessionCreatedMsg 新建会话回填（level 为本向导记录的思考档选择）。
type sessionCreatedMsg struct {
	session client.Session
	level   string
	err     error
}

func createSessionCmd(api API, input client.CreateSessionInput, level string) tea.Cmd {
	return func() tea.Msg {
		session, err := api.CreateSession(context.Background(), input)
		return sessionCreatedMsg{session: session, level: level, err: err}
	}
}

// modelSwitchedMsg 切换模型回填。
type modelSwitchedMsg struct {
	session client.Session
	level   string
	err     error
}

func switchModelCmd(api API, sessionID string, input client.SwitchModelInput, level string) tea.Cmd {
	return func() tea.Msg {
		session, err := api.SwitchSessionModel(context.Background(), sessionID, input)
		return modelSwitchedMsg{session: session, level: level, err: err}
	}
}

// selectedProfile 当前模型光标处的目录项。
func (s *pickerState) selectedProfile() (client.ModelProfile, bool) {
	if s.cursor < 0 || s.cursor >= len(s.models) {
		return client.ModelProfile{}, false
	}
	return s.models[s.cursor], true
}

// selectedLevels 当前模型的声明档位表。
func (s *pickerState) selectedLevels() []string {
	if profile, ok := s.selectedProfile(); ok {
		return profile.Capabilities.ReasoningLevels
	}
	return nil
}

func (m Model) updatePicker(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.picker.busy {
		return m, nil
	}
	switch m.picker.step {
	case stepTitle:
		return m.updatePickerTitle(msg)
	case stepModel:
		return m.updatePickerModel(msg)
	default:
		return m.updatePickerLevel(msg)
	}
}

func (m Model) updatePickerTitle(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "enter":
		// 非空标题先过与服务端同口径的本地预检；空白标题由服务端归一为「新会话」。
		if text := m.picker.title.text(); strings.TrimSpace(text) != "" {
			if err := client.ValidateTitle(text); err != nil {
				m.picker.failed = err.Error()
				return m, nil
			}
		}
		m.picker.failed = ""
		m.picker.step = stepModel
		return m, nil
	case "esc":
		m.phase = phaseSessions
		return m, nil
	default:
		return m, m.picker.title.updateKey(msg)
	}
}

func (m Model) updatePickerModel(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if len(m.picker.models) == 0 {
		if msg.String() == "esc" || msg.String() == "enter" {
			m.phase = phaseSessions
		}
		return m, nil
	}
	switch msg.String() {
	case "up", "k":
		if m.picker.cursor > 0 {
			m.picker.cursor--
		}
	case "down", "j":
		if m.picker.cursor < len(m.picker.models)-1 {
			m.picker.cursor++
		}
	case "enter":
		profile, ok := m.picker.selectedProfile()
		if !ok {
			return m, nil
		}
		levels := profile.Capabilities.ReasoningLevels
		if m.picker.mode == pickerSwitch && m.isCurrentSessionModelOf(profile) {
			// 同模型不重切；但声明档位的模型借同一入口提供思考档调整（每轮
			// reasoningLevel 随提交生效，无须动服务端模型绑定）。
			if len(levels) > 0 {
				m.picker.chosen = m.picker.cursor
				m.picker.levelOnly = true
				m.picker.failed = ""
				m.picker.step = stepLevel
				m.picker.level = defaultLevelIndex(levels, profile.Capabilities.DefaultReasoningLevel)
				return m, nil
			}
			m.notice = "会话已在使用该模型"
			m.noticeBad = false
			m.phase = phaseSessions
			return m, nil
		}
		m.picker.levelOnly = false
		m.picker.chosen = m.picker.cursor
		m.picker.failed = ""
		if len(levels) > 0 {
			m.picker.step = stepLevel
			m.picker.level = defaultLevelIndex(levels, profile.Capabilities.DefaultReasoningLevel)
			return m, nil
		}
		return m.submit("")
	case "esc":
		if m.picker.mode == pickerCreate {
			m.picker.step = stepTitle
			return m, nil
		}
		m.phase = phaseSessions
		return m, nil
	}
	return m, nil
}

func (m Model) updatePickerLevel(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	levels := m.picker.selectedLevels()
	switch msg.String() {
	case "up", "k":
		if m.picker.level > 0 {
			m.picker.level--
		}
	case "down", "j":
		if m.picker.level < len(levels)-1 {
			m.picker.level++
		}
	case "enter":
		if m.picker.level < len(levels) {
			if m.picker.levelOnly {
				// 同模型调整：档位每轮随提交生效，直接更新本地选择。
				m.levels[m.picker.sessionID] = levels[m.picker.level]
				m.picker.levelOnly = false
				m.picker.busy = false
				m.phase = phaseSessions
				m.notice = "思考档位已调整"
				m.noticeBad = false
				return m, saveStateCmd(m)
			}
			return m.submit(levels[m.picker.level])
		}
	case "esc":
		if m.picker.levelOnly {
			m.picker.levelOnly = false
			m.picker.step = stepModel
			return m, nil
		}
		m.picker.step = stepModel
		return m, nil
	}
	return m, nil
}

// submit 提交创建／切换（level 为空表示模型未声明档位，不提交思考档选择）。
func (m Model) submit(level string) (tea.Model, tea.Cmd) {
	m.picker.busy = true
	m.picker.failed = ""
	profile := m.picker.models[m.picker.chosen]
	if m.picker.mode == pickerCreate {
		title := strings.TrimSpace(m.picker.title.text())
		return m, createSessionCmd(m.api, client.CreateSessionInput{
			Title: title, ModelProfileID: profile.ID, ModelRevision: profile.Revision,
		}, level)
	}
	return m, switchModelCmd(m.api, m.picker.sessionID, client.SwitchModelInput{
		ModelProfileID: profile.ID, ModelRevision: profile.Revision,
	}, level)
}

// updateSessionCreated 新建成功：记录思考档、更新列表与指针、进入会话详情。
func (m Model) updateSessionCreated(msg sessionCreatedMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.picker.busy = false
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		m.picker.failed = errText(msg.err)
		m.picker.step = stepModel
		return m, nil
	}
	if msg.level != "" {
		m.levels[msg.session.ID] = msg.level
	} else {
		// 新模型未声明思考档位：清掉旧档选择，避免按已不存在的档位提交被拒。
		delete(m.levels, msg.session.ID)
	}
	m.list.sessions = append([]client.Session{msg.session}, m.list.sessions...)
	m.list.cursor = 0
	m.notice = ""
	m.noticeBad = false
	next, cmd := m.enterChat(msg.session.ID)
	return next, cmd
}

// updateModelSwitched 切换成功：更新行数据与思考档（重置为新模型选择），回列表。
func (m Model) updateModelSwitched(msg modelSwitchedMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.picker.busy = false
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.handleUnauthorized("会话已过期或已在别处登录，请重新登录")
			return m, nil
		}
		m.picker.failed = errText(msg.err)
		m.picker.step = stepModel
		return m, nil
	}
	for i := range m.list.sessions {
		if m.list.sessions[i].ID == msg.session.ID {
			m.list.sessions[i].ModelProfileID = msg.session.ModelProfileID
			m.list.sessions[i].ModelRevision = msg.session.ModelRevision
			m.list.sessions[i].ActiveRunID = msg.session.ActiveRunID
		}
	}
	if msg.level != "" {
		m.levels[msg.session.ID] = msg.level
	} else {
		// 新模型未声明思考档位：清掉旧档选择，避免按已不存在的档位提交被拒。
		delete(m.levels, msg.session.ID)
	}
	m.phase = phaseSessions
	m.notice = "模型已切换"
	m.noticeBad = false
	return m, saveStateCmd(m)
}

// defaultLevelIndex 默认档在档位表中的索引（声明默认档优先，未声明按 high→
// medium→首项推导）。
func defaultLevelIndex(levels []string, declared string) int {
	target := client.DefaultReasoningLevel(levels, declared)
	for i, level := range levels {
		if level == target {
			return i
		}
	}
	return 0
}

func (s *pickerState) view(m Model) string {
	var b strings.Builder
	if s.mode == pickerCreate {
		b.WriteString(titleStyle.Render("新建会话"))
	} else {
		b.WriteString(titleStyle.Render("切换模型"))
	}
	b.WriteString("\n\n")
	if s.busy {
		b.WriteString(metaStyle.Render("正在提交…"))
		b.WriteString("\n")
		return b.String()
	}
	switch s.step {
	case stepTitle:
		b.WriteString("标题：" + s.title.render(max(16, m.width-8), true))
		b.WriteString("\n")
		if s.failed != "" {
			b.WriteString(warnStyle.Render(truncateCells(s.failed, max(20, m.width-2))))
			b.WriteString("\n")
		}
		b.WriteString(hintStyle.Render("Enter 下一步（留空使用默认标题） · Esc 取消"))
		b.WriteString("\n")
		return b.String()
	case stepModel:
		if len(s.models) == 0 {
			switch {
			case m.list.modelsPending:
				b.WriteString(metaStyle.Render("正在读取模型目录…"))
				b.WriteString("\n\n")
				b.WriteString(hintStyle.Render("Esc 返回"))
				b.WriteString("\n")
				return b.String()
			case m.list.modelsErr != "":
				b.WriteString(warnStyle.Render(truncateCells("模型目录读取失败："+m.list.modelsErr, max(20, m.width-2))))
			default:
				b.WriteString(warnStyle.Render("没有可用的模型：需要启用且同时支持文本与工具调用的模型配置"))
				b.WriteString("\n")
				b.WriteString(metaStyle.Render("请在浏览器 Web 面板的系统设置中配置模型后重试"))
			}
			b.WriteString("\n\n")
			b.WriteString(hintStyle.Render("Esc 返回"))
			b.WriteString("\n")
			return b.String()
		}

		start, end := listWindow(len(s.models), s.cursor, max(1, m.height-9))
		for i := start; i < end; i++ {
			profile := s.models[i]
			marker := "  "
			if s.mode == pickerSwitch && m.isCurrentSessionModelOf(profile) {
				marker = metaStyle.Render("· ")
			}
			line := fmt.Sprintf("%s%s · 上下文 %s", marker, profileLabel(profile), formatTokens(profile.ContextTokens))
			if i == s.cursor {
				b.WriteString(selectSty.Render("❯ " + truncateCells(line, max(10, m.width-4))))
			} else {
				b.WriteString("  " + truncateCells(line, max(10, m.width-4)))
			}
			b.WriteString("\n")
		}
		if s.failed != "" {
			b.WriteString(warnStyle.Render(truncateCells(s.failed, max(20, m.width-2))))
			b.WriteString("\n")
		}
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("Enter 选择 · Esc 返回"))
		b.WriteString("\n")
		return b.String()
	default: // stepLevel
		profile := s.models[s.chosen]
		levels := profile.Capabilities.ReasoningLevels
		b.WriteString(metaStyle.Render(profileLabel(profile) + " 的思考等级"))
		b.WriteString("\n")
		for i, level := range levels {
			line := client.ReasoningLabel(level)
			if i == s.level {
				b.WriteString(selectSty.Render("❯ " + line))
			} else {
				b.WriteString("  " + line)
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
		b.WriteString(hintStyle.Render("Enter 确认 · Esc 返回模型选择"))
		b.WriteString("\n")
		return b.String()
	}
}

// isCurrentSessionModelOf 判定所选是否即切换目标会话的当前模型（同模型不重切，
// 列表渲染「·」标记）。
func (m Model) isCurrentSessionModelOf(profile client.ModelProfile) bool {
	for _, session := range m.list.sessions {
		if session.ID == m.picker.sessionID {
			return session.ModelProfileID == profile.ID && session.ModelRevision == profile.Revision
		}
	}
	return false
}

// profileLabel 模型行标签：模型名（服务名）。
func profileLabel(profile client.ModelProfile) string {
	if profile.Service != nil && profile.Service.Name != "" {
		return profile.Model + "（" + profile.Service.Name + "）"
	}
	return profile.Model
}

// formatTokens token 数简报。
func formatTokens(tokens int) string {
	switch {
	case tokens >= 1_000_000 && tokens%1_000_000 == 0:
		return fmt.Sprintf("%dM", tokens/1_000_000)
	case tokens >= 1_000:
		return fmt.Sprintf("%dK", tokens/1_000)
	default:
		return fmt.Sprintf("%d", tokens)
	}
}
