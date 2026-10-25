package tui

import (
	"os"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/x/ansi"
	"unicode"
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
	if _, disabled := os.LookupEnv("NO_COLOR"); disabled {
		return &markdownRenderer{width: width}
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
	text = safeText(text)
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

// safeText 在套用终端样式前去掉外部文本的控制序列与双向覆盖符。
func safeText(text string) string {
	text = ansi.Strip(text)
	return strings.Map(func(r rune) rune {
		if r == '\n' || r == '\t' {
			return r
		}
		if unicode.IsControl(r) || r == 0x202e || r == 0x202d || r == 0x202c || r == 0x2066 || r == 0x2067 || r == 0x2068 || r == 0x2069 {
			return -1
		}
		return r
	}, text)
}

// wrapPlain 使用 ANSI 库按字素和显示宽度折行，保留中文与组合字符。
func wrapPlain(text string, width int) string {
	text = safeText(text)
	if width < 4 {
		return text
	}
	return ansi.Wrap(text, width, "")
}
