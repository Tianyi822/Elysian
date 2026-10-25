package tui

import (
	"strings"
	"testing"

	"github.com/mattn/go-runewidth"
)

// wrapPlain 折行回归测试：整段中文、长路径、无空格 JSON 等无空格文本按显示宽度
// 硬折（段首超长词不再绕过折行），词间空格仍按词折；宽度不足 4 时原样返回。
// 全部行宽断言以 runewidth.StringWidth 为准（CJK／emoji 按实际列宽计）。

// assertLinesWithinWidth 断言折行结果逐行不超过宽度上限。
func assertLinesWithinWidth(t *testing.T, wrapped string, width int) {
	t.Helper()
	for i, line := range strings.Split(wrapped, "\n") {
		if w := runewidth.StringWidth(line); w > width {
			t.Fatalf("第 %d 行超出宽度上限：got %d cells, want <=%d, line=%q", i+1, w, width, line)
		}
	}
}

func TestWrapPlainChineseParagraphHardWraps(t *testing.T) {
	// 整段中文（无空格，单个「单词」180 列）：30 列宽度下必须全部折行且不丢字。
	text := strings.Repeat("中", 90)
	wrapped := wrapPlain(text, 30)
	assertLinesWithinWidth(t, wrapped, 30)
	if joined := strings.Join(strings.Split(wrapped, "\n"), ""); joined != text {
		t.Fatalf("硬折丢失或改动原文：got %q", joined)
	}
	if lines := strings.Split(wrapped, "\n"); len(lines) < 6 {
		t.Fatalf("90 个汉字在 30 列下至少 6 行，got %d 行：%q", len(lines), wrapped)
	}
}

func TestWrapPlainLongPathHardWraps(t *testing.T) {
	// 长英文路径（无空格单词）：按显示宽度硬折，内容逐字节保留。
	text := "/var/lib/elysian/state/website-runtime-catalog.json"
	wrapped := wrapPlain(text, 20)
	assertLinesWithinWidth(t, wrapped, 20)
	if strings.Join(strings.Split(wrapped, "\n"), "") != text {
		t.Fatalf("路径硬折丢失内容：got %q", wrapped)
	}
}

func TestWrapPlainDenseJSONHardWraps(t *testing.T) {
	// 无空格 JSON 串（工具参数详情的真实形态）：硬折且内容保留。
	text := `{"path":"/var/lib/elysian/data/metrics.sqlite","limit":1024}`
	wrapped := wrapPlain(text, 16)
	assertLinesWithinWidth(t, wrapped, 16)
	if strings.Join(strings.Split(wrapped, "\n"), "") != text {
		t.Fatalf("JSON 硬折丢失内容：got %q", wrapped)
	}
}

func TestWrapPlainMixedCJKAndLatinKeepsWords(t *testing.T) {
	// 中英混排：有词界时优先按词折，词本身不被截断（全部词宽均小于上限）。
	text := "错误 cannot allocate memory in /var/lib 数据库"
	wrapped := wrapPlain(text, 14)
	assertLinesWithinWidth(t, wrapped, 14)
	if got, want := strings.Fields(wrapped), strings.Fields(text); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("词折丢词：got %q, want %q", got, want)
	}
}

func TestWrapPlainLeadingOverlongWordWraps(t *testing.T) {
	// 段首即超长词：第一个单词必须硬折，后续单词在剩余行内正常续排。
	wrapped := wrapPlain("abcdefghijklmn tail words", 10)
	if want := "abcdefghij\nklmn tail\nwords"; wrapped != want {
		t.Fatalf("段首超长词折行不符：got %q, want %q", wrapped, want)
	}
	assertLinesWithinWidth(t, wrapped, 10)
}

func TestWrapPlainEmojiWideRunesNotSplit(t *testing.T) {
	// emoji 等宽字符按 2 列计，不与相邻字符截半拼接出半宽错位。
	text := "状态😀正常"
	wrapped := wrapPlain(text, 4)
	assertLinesWithinWidth(t, wrapped, 4)
	if strings.Join(strings.Split(wrapped, "\n"), "") != text {
		t.Fatalf("emoji 硬折丢失内容：got %q", wrapped)
	}
}

func TestWrapPlainPreservesParagraphStructure(t *testing.T) {
	// 空段落（空行）保留，短段不引入多余折行。
	wrapped := wrapPlain("第一段\n\nsecond paragraph", 20)
	if want := "第一段\n\nsecond paragraph"; wrapped != want {
		t.Fatalf("段落结构被改写：got %q, want %q", wrapped, want)
	}
	if wrapPlain("", 30) != "" {
		t.Fatal("空文本应回空串")
	}
}

func TestWrapPlainNarrowWidthReturnsText(t *testing.T) {
	// 宽度 0／负数／小于 4：无法有效折行，原样返回（上层截断兜底）。
	text := strings.Repeat("中", 20) + " tail"
	for _, width := range []int{0, -5, 3} {
		if got := wrapPlain(text, width); got != text {
			t.Fatalf("width=%d 应原样返回：got %q", width, got)
		}
	}
	// 宽度 4（有效下限）开始折行：每行恰好两个汉字列宽。
	wrapped := wrapPlain("中文测试文本", 4)
	if want := "中文\n测试\n文本"; wrapped != want {
		t.Fatalf("width=4 折行不符：got %q, want %q", wrapped, want)
	}
}

func TestWrapPlainMarkdownFallbackPath(t *testing.T) {
	// 超过 markdownPlainLimit 的回答回落纯文本折行：长中文答复同样逐行受限。
	renderer := newMarkdownRenderer(40)
	wrapped := renderer.render(strings.Repeat("答", 6000))
	if len(wrapped) == 0 || runewidth.StringWidth(strings.SplitN(wrapped, "\n", 2)[0]) > 40 {
		t.Fatalf("超限回落未按宽度折行：first line %q", strings.SplitN(wrapped, "\n", 2)[0])
	}
	assertLinesWithinWidth(t, wrapped, 40)
}
