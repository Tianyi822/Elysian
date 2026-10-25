package tui

import (
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/mattn/go-runewidth"
)

// Markdown 渲染（glamour 固定选型）：按终端背景自动选风格（NO_COLOR／非彩色终端
// 自动降级纯文本缩进），词法换行按消息区宽度；超长文本（流式长答复）回落等宽纯
// 文本换行，避免每帧全量渲染卡顿。代码块由 glamour 等宽渲染并保留语言标注；终端
// 无剪贴板 API，不提供复制（完整内容随消息区滚动查看——与 Web 的显式形态差异）。

// markdownPlainLimit 超过该字节数的文本回落纯文本渲染（流式期间每帧重渲染的
// 保护上限）。
const markdownPlainLimit = 12 * 1024

type markdownRenderer struct {
	width    int
	renderer *glamour.TermRenderer
}

func newMarkdownRenderer(width int) *markdownRenderer {
	if width < 16 {
		width = 16
	}
	renderer, err := glamour.NewTermRenderer(glamour.WithAutoStyle(), glamour.WithWordWrap(width))
	if err != nil {
		// 构造失败不致命：渲染回落纯文本。
		return &markdownRenderer{width: width}
	}
	return &markdownRenderer{width: width, renderer: renderer}
}

// render 渲染 Markdown 文本；空文本回空串，超限或失败回落原文本。
func (r *markdownRenderer) render(text string) string {
	if text == "" {
		return ""
	}
	if r.renderer == nil || len(text) > markdownPlainLimit {
		return wrapPlain(text, r.width)
	}
	out, err := r.renderer.Render(text)
	if err != nil || out == "" {
		return text
	}
	return strings.Trim(out, "\n")
}

// wrapPlain 纯文本按显示宽度换行（CJK 不截半）。
func wrapPlain(text string, width int) string {
	if width < 4 {
		return text
	}
	var b strings.Builder
	for _, paragraph := range strings.Split(text, "\n") {
		if paragraph == "" {
			b.WriteString("\n")
			continue
		}
		lineWidth := 0
		for _, word := range strings.Split(paragraph, " ") {
			wordWidth := runewidth.StringWidth(word)
			switch {
			case lineWidth == 0:
				b.WriteString(word)
				lineWidth = wordWidth
			case lineWidth+1+wordWidth <= width:
				b.WriteString(" " + word)
				lineWidth += 1 + wordWidth
			default:
				b.WriteString("\n")
				// 单词本身超宽：按字符硬折。
				if wordWidth > width {
					cell := 0
					for _, char := range word {
						charWidth := runewidth.RuneWidth(char)
						if cell+charWidth > width {
							b.WriteString("\n")
							cell = 0
						}
						b.WriteString(string(char))
						cell += charWidth
					}
					lineWidth = cell
					continue
				}
				b.WriteString(word)
				lineWidth = wordWidth
			}
		}
		b.WriteString("\n")
	}
	return strings.TrimSuffix(b.String(), "\n")
}
