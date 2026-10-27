package cli

import (
	"bytes"
	"context"
	"elysian/server/internal/cli/termui"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// 主菜单：Agent 终端、重置密码、面板更新、使用帮助与退出，方向键 ↑/↓（含
// j/k）、Enter 确认、Esc 返回上级（主菜单层即退出）、Ctrl+C 即时退出（退出码 0）；
// 头部常驻 CLI 版本与面板版本（health commit）及不一致标注。

// menuAction 菜单程序退出时带回 Run 分派的动作。
type menuAction int

const (
	menuActionNone menuAction = iota
	menuActionExit
	menuActionResetPassword
	menuActionAgent
	menuActionUpgrade
)

// probeBudget 单次面板探测的总预算（候选端口 + 默认端口回退各一次请求）。
const probeBudget = 2500 * time.Millisecond

// menuModel bubbletea 菜单模型；Update 为纯状态机，导航与退出路径全部可单测。
type menuModel struct {
	info          Info
	deps          deps
	items         []string
	cursor        int
	action        menuAction
	panel         panelStatus
	width, height int
	help          bool
	helpViewport  viewport.Model
}

func newMenuModel(info Info, d deps) menuModel {
	return menuModel{
		info:  info,
		deps:  d,
		items: []string{"Agent 终端", "重置密码", "面板更新", "使用帮助", "退出"},
		width: 78, height: 24,
		helpViewport: viewport.New(78, 16),
		panel:        panelStatus{kind: panelProbing},
	}
}

// probePanelCmd 面板版本探测命令：预算内完成后以 panelStatusMsg 回填头部。
func probePanelCmd(d deps) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), probeBudget)
		defer cancel()
		return panelStatusMsg(d.probePanel(ctx))
	}
}

func (m menuModel) Init() tea.Cmd { return probePanelCmd(m.deps) }

func (m menuModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		if m.help {
			m.sizeHelp()
		}
		return m, nil
	case panelStatusMsg:
		m.panel = panelStatus(msg)
		return m, nil
	case tea.KeyMsg:
		// 批量到达的 rune（快速连按、粘贴或测试注入一次写入多键）是一条 KeyMsg 携带
		// 多个 Runes，逐 rune 归约为等价的多次单键；中途换屏或退出即止，余量不消费。
		if msg.Type == tea.KeyRunes && len(msg.Runes) > 1 {
			var model tea.Model = m
			var final tea.Cmd
			for _, r := range msg.Runes {
				var cmd tea.Cmd
				model, cmd = model.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
				final = cmd
				if cmd != nil {
					break
				}
			}
			return model, final
		}
		return m.updateMain(msg)
	}
	return m, nil
}

func (m menuModel) updateMain(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.help {
		if msg.String() == "esc" || msg.String() == "enter" {
			m.help = false
			return m, nil
		}
		if msg.String() == "ctrl+c" {
			m.action = menuActionExit
			return m, tea.Quit
		}
		var cmd tea.Cmd
		m.helpViewport, cmd = m.helpViewport.Update(msg)
		return m, cmd
	}
	switch msg.String() {
	case "up", "k":
		m.cursor = (m.cursor - 1 + len(m.items)) % len(m.items)
	case "down", "j":
		m.cursor = (m.cursor + 1) % len(m.items)
	case "enter":
		switch m.cursor {
		case 0: // Agent 终端：退出菜单程序后由 Run 启动 TUI（终端让渡给 bubbletea）。
			m.action = menuActionAgent
			return m, tea.Quit
		case 1: // 重置密码：退出菜单程序后由 Run 执行（改密流程自管 termios）。
			m.action = menuActionResetPassword
			return m, tea.Quit
		case 2:
			m.action = menuActionUpgrade
			return m, tea.Quit
		case 3:
			m.help = true
			m.sizeHelp()
			return m, nil
		default: // 退出。
			m.action = menuActionExit
			return m, tea.Quit
		}
	case "esc", "ctrl+c":
		// 主菜单层 Esc 已无上级可返，与「退出」同义；Ctrl+C 即时退出。退出码均为 0。
		m.action = menuActionExit
		return m, tea.Quit
	}
	return m, nil
}

// 菜单样式：克制的中性表达，选中态以「❯＋加粗＋亮色」呈现，未选中留白对齐；
// NO_COLOR／非彩色终端下 lipgloss 自动降级为纯文本（加粗与 ❯ 仍保留可辨识）。
var (
	menuTitleStyle = termui.Title
	menuMetaStyle  = termui.Muted
	menuHintStyle  = termui.Muted
	menuWarnStyle  = termui.Warning
	menuItemStyle  = lipgloss.NewStyle()
	menuSelStyle   = termui.Accent
)

func (m menuModel) View() string {
	var b strings.Builder
	b.WriteString(termui.Header("Elysian CLI", fmt.Sprintf("CLI 版本：%s · 构建于 %s", m.info.Commit, m.info.BuildTime), m.width))
	if m.help {
		return b.String() + m.helpViewport.View() + "\n" + termui.Hints("↑↓ / PgUp/PgDn 滚动 · Esc 返回菜单", m.width) + "\n"
	}
	b.WriteString(termui.Hints(m.panelView(), m.width))
	b.WriteString("\n\n")
	commands := []string{"ely agent", "ely resetpwd", "ely upgrade", "ely help", ""}
	descriptions := []string{"继续会话、查看执行过程与处理审批", "重置本机管理员密码，全部会话失效", "选择 GitHub / Gitee，更新并验证运行版本", "查看命令、参数、默认值与示例", "返回系统终端"}
	for i, item := range m.items {
		if i == m.cursor {
			b.WriteString(menuSelStyle.Render("❯ "+item) + menuMetaStyle.Render("    "+commands[i]))
		} else {
			b.WriteString(menuItemStyle.Render("  "+item) + menuMetaStyle.Render("    "+commands[i]))
		}
		b.WriteString("\n")
		if m.height >= 22 || m.height >= 16 && i == m.cursor {
			b.WriteString("    " + termui.Hints(descriptions[i], max(1, m.width-4)) + "\n")
		}
	}
	b.WriteString("\n")
	b.WriteString(termui.Hints("↑/↓ 或 j/k 选择 · Enter 确认 · Esc 退出 · Ctrl+C 退出", m.width))
	b.WriteString("\n")
	return termui.Fit(b.String(), m.width)
}

// panelView 面板版本行的五态呈现（CLI 方案 §3.1 的菜单头精简版）：可达显示 commit，
// 未启动／连接异常给出可操作提示，均不阻塞菜单本身。
func (m menuModel) panelView() string {
	switch m.panel.kind {
	case panelProbing:
		return menuMetaStyle.Render("面板版本：检测中…")
	case panelReachable:
		line := "面板版本："
		switch {
		case m.panel.commit != "":
			line += m.panel.commit
		default:
			// 非 bare-metal 模式的 /api/health 只回 ok，不携带 commit。
			line += "面板可达（未上报版本）"
		}
		if m.panel.baseURL != "" {
			line += "（" + m.panel.baseURL + "）"
		}
		if m.panel.commit != "" && m.info.Commit != "" && m.panel.commit != m.info.Commit {
			line += "\n" + menuWarnStyle.Render(fmt.Sprintf("面板与 CLI 版本不一致（面板 %s / CLI %s）", m.panel.commit, m.info.Commit))
		}
		return line
	case panelNotRunning:
		return menuWarnStyle.Render("面板未启动：sudo systemctl status elysian / sudo systemctl start elysian")
	default: // panelUnreachable
		detail := m.panel.detail
		if detail != "" {
			detail = "：" + detail
		}
		return menuWarnStyle.Render("面板连接异常" + detail + "（检查 panel-network.json 端口与占用：sudo ss -ltnp）")
	}
}

func (m *menuModel) sizeHelp() {
	var help bytes.Buffer
	printUsage(&help)
	m.helpViewport.Width = max(1, m.width)
	m.helpViewport.Height = max(1, m.height-6)
	m.helpViewport.SetContent(termui.Hints(help.String(), m.width))
}
