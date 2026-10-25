package tui

import (
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

// 单行输入编辑器：登录（用户名／密码）、会话标题、重命名与向导自定义回答共用。
// 输入管理（光标、删除、遮蔽、光标可见的水平窗口）收敛到 bubbles/textinput——
// 需求红线「不自研通用输入组件」；本类型只保留仓库侧的最小接缝（取值／预填／
// 按键透传／按焦点渲染）。密码以 • 遮蔽。

type lineEditor struct {
	input textinput.Model
}

func newLineEditor(secret bool) *lineEditor {
	input := textinput.New()
	input.Prompt = ""
	input.Placeholder = ""
	if secret {
		input.EchoMode = textinput.EchoPassword
		input.EchoCharacter = '•'
	}
	// 恒保持聚焦：textinput 失焦即丢键，而本类型的多编辑器场景（登录双字段）由
	// 调用方路由按键，焦点只影响渲染形态。
	input.Focus()
	return &lineEditor{input: input}
}

// setRunes 预填内容并把光标放到末尾（重命名场景）。
func (e *lineEditor) setRunes(text string) {
	e.input.SetValue(safeText(text))
	e.input.CursorEnd()
}

func (e *lineEditor) text() string { return e.input.Value() }

func (e *lineEditor) empty() bool { return e.input.Value() == "" }

// updateKey 把按键交给 textinput 消费（结构键 Enter／Esc 由调用方先行处理）。
func (e *lineEditor) updateKey(msg tea.KeyMsg) tea.Cmd { return e.update(msg) }
func (e *lineEditor) update(msg tea.Msg) tea.Cmd {
	var cmd tea.Cmd
	e.input, cmd = e.input.Update(msg)
	return cmd
}

// render 按显示宽度渲染输入行：聚焦形态带光标（textinput View），失焦纯文本不显示
// 光标；密码以 • 遮蔽；超宽时光标可见的水平窗口由 textinput 依据 Width 处理。
// 渲染不改焦点状态——textinput 失焦即丢键，焦点切换只属于输入路由。
func (e *lineEditor) render(width int, focused bool) string {
	if width < 4 {
		return ""
	}
	if focused {
		e.input.Width = width - 2
		return e.input.View()
	}
	value := e.text()
	if e.input.EchoMode == textinput.EchoPassword {
		value = strings.Repeat("•", len([]rune(value)))
	}
	return truncateCells(value, width-2)
}

// truncateCells 按显示宽度截断文本（列表行不破版），超出以 … 结尾。
func truncateCells(text string, width int) string {
	if width <= 0 {
		return ""
	}
	return ansi.Truncate(safeText(text), width, "…")
}

// displayWidth 文本显示宽度（CJK／emoji 按实际列宽计）。
func displayWidth(text string) int { return ansi.StringWidth(safeText(text)) }
