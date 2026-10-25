package tui

import (
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/mattn/go-runewidth"
)

// 单行输入编辑器：登录（用户名／密码）与标题输入共用；密码以 • 遮蔽；渲染做显示
// 宽度窗口（光标附近的可见区），中文与全角字符不破版。

type lineEditor struct {
	runes  []rune
	cursor int
	secret bool
}

func newLineEditor(secret bool) *lineEditor { return &lineEditor{secret: secret} }

// setRunes 预填内容并把光标放到末尾（重命名场景）。
func (e *lineEditor) setRunes(text string) {
	e.runes = []rune(text)
	e.cursor = len(e.runes)
}

func (e *lineEditor) text() string { return string(e.runes) }

func (e *lineEditor) empty() bool { return len(e.runes) == 0 }

func (e *lineEditor) insert(runes []rune) {
	if len(runes) == 0 {
		return
	}
	rest := append([]rune{}, e.runes[e.cursor:]...)
	e.runes = append(append(e.runes[:e.cursor], runes...), rest...)
	e.cursor += len(runes)
}

func (e *lineEditor) backspace() {
	if e.cursor == 0 {
		return
	}
	e.runes = append(e.runes[:e.cursor-1], e.runes[e.cursor:]...)
	e.cursor--
}

func (e *lineEditor) del() {
	if e.cursor >= len(e.runes) {
		return
	}
	e.runes = append(e.runes[:e.cursor], e.runes[e.cursor+1:]...)
}

func (e *lineEditor) left() {
	if e.cursor > 0 {
		e.cursor--
	}
}

func (e *lineEditor) right() {
	if e.cursor < len(e.runes) {
		e.cursor++
	}
}

func (e *lineEditor) home() { e.cursor = 0 }
func (e *lineEditor) end()  { e.cursor = len(e.runes) }

// updateKey 消费一条按键；返回是否消费（未消费的键交上层处理，如 Enter／Esc）。
func (e *lineEditor) updateKey(msg tea.KeyMsg) bool {
	switch msg.Type {
	case tea.KeyRunes:
		e.insert(msg.Runes)
		return true
	case tea.KeySpace:
		e.insert([]rune{' '})
		return true
	case tea.KeyBackspace:
		e.backspace()
		return true
	case tea.KeyDelete:
		e.del()
		return true
	case tea.KeyLeft:
		e.left()
		return true
	case tea.KeyRight:
		e.right()
		return true
	case tea.KeyHome:
		e.home()
		return true
	case tea.KeyEnd:
		e.end()
		return true
	case tea.KeyCtrlU:
		e.runes = nil
		e.cursor = 0
		return true
	}
	return false
}

// render 按显示宽度渲染输入行：遮蔽（•）、光标反色、光标可见的水平窗口。
func (e *lineEditor) render(width int) string {
	if width < 4 {
		return ""
	}
	limit := width - 2
	shown := make([]rune, len(e.runes))
	for i, r := range e.runes {
		if e.secret {
			shown[i] = '•'
		} else {
			shown[i] = r
		}
	}
	// 窗口起点从行首逐步右移，直到「起点到光标」的显示宽度可容纳，保证光标可见。
	start := 0
	for start < e.cursor && runeSliceWidth(shown, start, e.cursor) > limit {
		start++
	}
	visible := shown[start:]
	cursorAt := e.cursor - start
	var b strings.Builder
	for i, r := range visible {
		if i == cursorAt {
			b.WriteString(cursorStyle.Render(string(r)))
			continue
		}
		b.WriteString(string(r))
	}
	if cursorAt >= len(visible) {
		b.WriteString(cursorStyle.Render(" "))
	}
	return b.String()
}

// runeSliceWidth 计算 runes[from:upto) 的显示宽度。
func runeSliceWidth(runes []rune, from, upto int) int {
	if from < 0 {
		from = 0
	}
	if upto > len(runes) {
		upto = len(runes)
	}
	width := 0
	for _, r := range runes[from:upto] {
		width += runewidth.RuneWidth(r)
	}
	return width
}

var cursorStyle = lipgloss.NewStyle().Reverse(true)

// truncateCells 按显示宽度截断文本（列表行不破版），超出以 … 结尾。
func truncateCells(text string, width int) string {
	if width <= 0 {
		return ""
	}
	if runewidth.StringWidth(text) <= width {
		return text
	}
	return runewidth.Truncate(text, width, "…")
}

// displayWidth 文本显示宽度（CJK／emoji 按实际列宽计）。
func displayWidth(text string) int { return runewidth.StringWidth(text) }
