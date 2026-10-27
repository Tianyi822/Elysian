// Package termui 提供命令行各页面共用的终端呈现，不依赖业务或 HTTP 客户端。
package termui

import (
	"strings"
	"unicode"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

var (
	Title   = lipgloss.NewStyle().Bold(true)
	Muted   = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "240", Dark: "252"})
	Accent  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.AdaptiveColor{Light: "25", Dark: "117"})
	Success = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "28", Dark: "114"})
	Warning = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "130", Dark: "221"})
	Danger  = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "124", Dark: "210"})
	Line    = lipgloss.NewStyle().Foreground(lipgloss.AdaptiveColor{Light: "245", Dark: "240"})
)

// Safe 清理上游消息、日志和路径中的终端控制符；先净化再套用自有样式。
func Safe(text string) string {
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || r == 0x202e || r == 0x202d || r == 0x202c || r >= 0x2066 && r <= 0x2069 {
			return -1
		}
		return r
	}, ansi.Strip(text))
}

func Width(width int) int {
	if width <= 0 {
		return 78
	}
	return width
}

func Header(title, meta string, width int) string {
	width = Width(width)
	text := Accent.Render("Elysian") + Line.Render("  /  ") + Title.Render(title)
	if strings.HasPrefix(title, "Elysian ") {
		text = Accent.Render(title)
	}
	if meta != "" {
		text += "\n" + Muted.Render(Safe(meta))
	}
	return Fit(text, width) + "\n" + Line.Render(strings.Repeat("─", min(width, 88))) + "\n"
}

func Panel(title, body string, width int, focused bool) string {
	width = Width(width)
	if width < 12 {
		return Fit(title+"\n"+body, width)
	}
	border := Line.GetForeground()
	if focused {
		border = Accent.GetForeground()
	}
	style := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(border).Padding(0, 1).Width(width - 2)
	if title != "" {
		body = Title.Render(title) + "\n" + body
	}
	return style.Render(body)
}

// Fit 只用于布局边界，保留已经由可信呈现层生成的 ANSI 样式。
func Fit(text string, width int) string {
	width = Width(width)
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = ansi.Truncate(line, width, "…")
	}
	return strings.Join(lines, "\n")
}

func Hints(text string, width int) string {
	return Muted.Render(ansi.Wrap(text, max(1, Width(width)), ""))
}
