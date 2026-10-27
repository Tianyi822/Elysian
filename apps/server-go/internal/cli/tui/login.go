package tui

import (
	"context"
	"strings"

	"elysian/server/internal/cli/client"
	"elysian/server/internal/cli/termui"

	tea "github.com/charmbracelet/bubbletea"
)

// 登录屏：用户名（缺省 admin，可改，兼容 dev 账号）与密码两字段；Tab／↑↓ 切换、
// Enter 提交（在密码字段直接回车即提交）；失败呈现服务端中文原因（429 附等待秒
// 数）；登录成功保存本地凭据（baseURL＋Cookie，0600 由存储层保证）并加载会话与
// 模型目录。不做任何自动重登（登录限流 5 次/60 秒，自动重登会锁死入口）。

type loginField int

const (
	loginFieldUser loginField = iota
	loginFieldPassword
)

type loginState struct {
	user     *lineEditor
	password *lineEditor
	field    loginField
	busy     bool
	error    string
}

func newLoginState() loginState {
	state := loginState{user: newLineEditor(false), password: newLineEditor(true)}
	state.user.setRunes("admin")
	return state
}

// loginDoneMsg 登录命令回填。
type loginDoneMsg struct{ err error }

func loginCmd(api API, username, password string) tea.Cmd {
	return func() tea.Msg {
		return loginDoneMsg{err: api.Login(context.Background(), username, password)}
	}
}

func (m Model) updateLogin(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.login.busy {
		return m, nil
	}
	switch msg.String() {
	case "tab", "down", "shift+tab", "up":
		if msg.String() == "tab" || msg.String() == "down" {
			m.login.field = loginFieldPassword
		} else {
			m.login.field = loginFieldUser
		}
	case "enter":
		if m.login.user.empty() || m.login.password.empty() {
			m.login.error = "请输入用户名与密码"
			return m, nil
		}
		m.login.busy = true
		m.login.error = ""
		return m, loginCmd(m.api, m.login.user.text(), m.login.password.text())
	case "esc":
		return m, tea.Quit
	default:
		m.login.error = ""
		active := m.login.user
		if m.login.field == loginFieldPassword {
			active = m.login.password
		}
		return m, active.updateKey(msg)
	}
	return m, nil
}

// updateLoginDone 登录成功：保存凭据并进入会话列表（与 boot 就绪同链路加载）。
func (m Model) updateLoginDone(msg loginDoneMsg) (tea.Model, tea.Cmd) {
	if msg.err != nil {
		m.login.busy = false
		if connErr := asClientErr(msg.err); connErr != nil && connErr.Kind == client.KindUnauthorized {
			m.login.error = connErr.Message
			return m, nil
		}
		m.login.error = errText(msg.err)
		return m, nil
	}
	if err := m.deps.SaveCreds(m.baseURL, m.api.SessionCookie()); err != nil {
		m.login.busy = false
		m.login.error = "保存 CLI 登录失败：" + err.Error()
		return m, nil
	}
	m.login = newLoginState()
	return m.updateBoot(bootMsg{baseURL: m.baseURL, api: m.api})
}

func (s loginState) view(m Model) string {
	var b strings.Builder
	labelWidth := 10
	userLabel, passwordLabel := padCells("用户名", labelWidth), padCells("密码", labelWidth)
	fieldWidth := min(72, max(20, m.width-2)) - labelWidth - 6
	if fieldWidth < 12 {
		fieldWidth = 12
	}
	render := func(label string, editor *lineEditor, focused bool) string {
		value := editor.render(fieldWidth, focused)
		if focused {
			return selectSty.Render(label) + value
		}
		return metaStyle.Render(label) + value
	}
	fields := render(userLabel, s.user, s.field == loginFieldUser) + "\n\n" + render(passwordLabel, s.password, s.field == loginFieldPassword)
	b.WriteString(termui.Panel("管理员登录", fields, min(72, max(20, m.width-2)), true))
	b.WriteString("\n")
	if s.busy {
		b.WriteString(m.spinner.View() + metaStyle.Render("正在登录…"))
		b.WriteString("\n")
	} else if s.error != "" {
		b.WriteString(warnStyle.Render(truncateCells(s.error, max(20, m.width-2))))
		b.WriteString("\n")
	}
	b.WriteString(hintStyle.Render("Enter 登录 · Tab 切换字段 · Esc 返回主菜单"))
	b.WriteString("\n")
	return b.String()
}

// padCells 把标签补齐到固定显示宽度（中英文对齐）。
func padCells(text string, width int) string {
	pad := width - displayWidth(text)
	if pad <= 0 {
		return text + " "
	}
	return text + strings.Repeat(" ", pad+1)
}
