package terminals

import (
	"reflect"
	"strings"
	"testing"
)

// 行模型汇编器的行为锚定（盘点 §8.2 对等移植）：\r\n 与 lone \r、ANSI（CSI/OSC/
// 单字符 ESC）剥离、UTF-8 分块边界（多字节字符跨 chunk）、PWD 哨兵提取与流中移除、
// READY 前丢弃、单轮预算触顶与丢弃计数、控制字符剥离与制表位展开、无换行积压硬
// 上限（丢弃态与边界信号）、哨兵的输入门控（伪造哨兵剥离），以及按终端语义落行。

func renderEqual(t *testing.T, raw, want string) {
	t.Helper()
	if got := renderTerminalLine(raw); got != want {
		t.Fatalf("renderTerminalLine(%q) = %q，期望 %q", raw, got, want)
	}
}

func TestRenderLs对齐行原样保留(t *testing.T) {
	line := "drwxr-xr-x  22 root root  704 Sep 22 17:27 app"
	renderEqual(t, line+"\r", line)
}

func TestRender制表位从行首起算宽字符占两格(t *testing.T) {
	renderEqual(t, "ab\tc", "ab"+strings.Repeat(" ", 6)+"c")
	renderEqual(t, "中文\tx", "中文"+strings.Repeat(" ", 4)+"x")
	renderEqual(t, "\t\tx", strings.Repeat(" ", 16)+"x")
}

func TestRender回车后覆盖写(t *testing.T) {
	renderEqual(t, "Downloading 10%\r100%", "100%loading 10%")
	renderEqual(t, "  1%\r 50%\r100%\r", "100%")
}

func TestRender回车配合CSIK擦到行尾(t *testing.T) {
	renderEqual(t, "Downloading 10%\r\x1b[KDone", "Done")
	renderEqual(t, "abc\x1b[2K\rxy", "xy")
	renderEqual(t, "abcdef\x1b[3D\x1b[1K", "    ef")
}

func TestRender退格叠印还原成单字(t *testing.T) {
	renderEqual(t, "N\bNA\bAM\bME\bE", "NAME")
	renderEqual(t, "_\bl_\bs", "ls")
}

func TestRenderCSICDG横移光标缺口以空格补位(t *testing.T) {
	renderEqual(t, "a\x1b[3Cb", "a   b")
	renderEqual(t, "abcd\x1b[2Dx", "abxd")
	renderEqual(t, "abc\x1b[10Gx", "abc      x")
}

func TestRender覆盖宽字符半格另一并清空格(t *testing.T) {
	renderEqual(t, "中\rx", "x ")
	renderEqual(t, "a中\x1b[2Gb", "ab ")
}

func TestRender组合附加符挂在前一字符上(t *testing.T) {
	renderEqual(t, "é\tx", "é"+strings.Repeat(" ", 7)+"x")
}

func TestRender颜色光标上移与清屏类转义剥离(t *testing.T) {
	renderEqual(t, "\x1b[1;34mdir\x1b[0m  \x1b[?25lfile\x1b[H\x1b[2J", "dir  file")
}

// ---------- 汇编器 ----------

type rawEvent struct {
	kind         string
	pid          string
	lines        []string
	cwd          string
	droppedBytes int
}

func normalize(events []streamEvent) []rawEvent {
	out := make([]rawEvent, 0, len(events))
	for _, ev := range events {
		switch ev.kind {
		case eventReady:
			pid := ""
			if ev.hasPid {
				pid = ev.pid
			}
			out = append(out, rawEvent{kind: "ready", pid: pid})
		case eventLines:
			out = append(out, rawEvent{kind: "lines", lines: ev.lines})
		case eventPrompt:
			out = append(out, rawEvent{kind: "prompt", cwd: ev.cwd, droppedBytes: ev.droppedBytes})
		}
	}
	return out
}

func eventsOf(t *testing.T, chunks ...string) []rawEvent {
	t.Helper()
	assembler := newStreamAssembler()
	var events []rawEvent
	for _, chunk := range chunks {
		events = append(events, normalize(assembler.push([]byte(chunk)))...)
	}
	return events
}

func expectEvents(t *testing.T, got, want []rawEvent) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("事件数 %d（%+v），期望 %d（%+v）", len(got), got, len(want), want)
	}
	for i := range got {
		if !reflect.DeepEqual(got[i], want[i]) {
			t.Fatalf("第 %d 个事件 = %+v，期望 %+v", i, got[i], want[i])
		}
	}
}

func TestREADY之前的字节全部丢弃(t *testing.T) {
	got := eventsOf(t, "bash-5.2# 噪音\r\n"+testReady+"\r\n", "hello\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: ""},
		{kind: "lines", lines: []string{"hello"}},
	})
}

func TestREADY哨兵跨chunk分裂仍能识别(t *testing.T) {
	got := eventsOf(t, "noise\x01RE", "ADY\x02\r\nout\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: ""},
		{kind: "lines", lines: []string{"out"}},
	})
}

func Test带pid哨兵产出ready事件并携带pid(t *testing.T) {
	got := eventsOf(t, "noise\r\n\x01READY:4194304\x02\r\nout\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: "4194304"},
		{kind: "lines", lines: []string{"out"}},
	})
}

func Test带pid哨兵跨chunk分裂pid任意位切断(t *testing.T) {
	got := eventsOf(t, "noise\x01READY:12", "34\x02\r\nout\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: "1234"},
		{kind: "lines", lines: []string{"out"}},
	})
}

func TestREADY前的超长垃圾不淹没跨块哨兵(t *testing.T) {
	got := eventsOf(t, "x"+strings.Repeat("弃", 60), "y\x01READY:9\x02\r\nout\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: "9"},
		{kind: "lines", lines: []string{"out"}},
	})
}

func Test不带终止字节的半截哨兵不产出ready(t *testing.T) {
	got := eventsOf(t, "noise\x01READY:123")
	expectEvents(t, got, nil)
}

func Test启动行回显的字面转义文本不冒充哨兵(t *testing.T) {
	got := eventsOf(t, "printf '\\x01READY\\x02\\n'\r\n", testReady+"\r\nreal\r\n")
	if len(got) == 0 || !reflect.DeepEqual(got[0], rawEvent{kind: "ready", pid: ""}) {
		t.Fatalf("首事件应为 ready： %+v", got)
	}
	found := false
	for _, ev := range got {
		if ev.kind == "lines" && len(ev.lines) == 1 && ev.lines[0] == "real" {
			found = true
		}
	}
	if !found {
		t.Fatalf("real 行未产出：%+v", got)
	}
}

func Test回车换行切行剥行尾回车(t *testing.T) {
	got := eventsOf(t, testReady+"\r\na\r\n", "pro\x07gress\x08\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: ""},
		{kind: "lines", lines: []string{"a"}},
		{kind: "lines", lines: []string{"progress"}},
	})
}

func Test不带换行的进度重绘只留最终一帧(t *testing.T) {
	got := eventsOf(t, testReady+"\r\n10%\r", "99%\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: ""},
		{kind: "lines", lines: []string{"99%"}},
	})
}

func TestCSI与OSC转义序列剥离(t *testing.T) {
	got := eventsOf(t, testReady+"\r\n", "\x1b[31mred\x1b[0m\r\n", "\x1b]0;title\x07after-osc\r\n", "\x1b[2Kcleared\r\n")
	expectEvents(t, got[1:], []rawEvent{
		{kind: "lines", lines: []string{"red"}},
		{kind: "lines", lines: []string{"after-osc"}},
		{kind: "lines", lines: []string{"cleared"}},
	})
}

func Test单字符ESC序列剥离(t *testing.T) {
	got := eventsOf(t, testReady+"\r\n\x1bMline\r\n")
	expectEvents(t, got[1:], []rawEvent{{kind: "lines", lines: []string{"line"}}})
}

func Test控制字符剥离与制表位展开(t *testing.T) {
	got := eventsOf(t, testReady+"\r\na\tb\x00c\x7f\r\n")
	expectEvents(t, got[1:], []rawEvent{{kind: "lines", lines: []string{"a" + strings.Repeat(" ", 7) + "bc"}}})
}

func Test多字节UTF8字符跨chunk边界不撕裂(t *testing.T) {
	full := testReady + "\r\n中文"
	assembler := newStreamAssembler()
	first := normalize(assembler.push([]byte(full)[:len(full)-2]))
	expectEvents(t, first, []rawEvent{{kind: "ready", pid: ""}})
	second := append(normalize(assembler.push([]byte(full)[len(full)-2:])), normalize(assembler.finish())...)
	expectEvents(t, second, []rawEvent{{kind: "lines", lines: []string{"中文"}}})
}

func TestPWD哨兵提取为prompt事件并从流中移除(t *testing.T) {
	got := eventsOf(t, testReady+"\r\nresult\r\n\x01PWD:/tmp\x02\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: ""},
		{kind: "lines", lines: []string{"result"}},
		{kind: "prompt", cwd: "/tmp", droppedBytes: 0},
	})
}

func Test哨兵跨块到齐且以换行结尾后交付prompt(t *testing.T) {
	assembler := newStreamAssembler()
	assembler.push([]byte(testReady + "\n"))
	assembler.noteInput()
	if got := normalize(assembler.push([]byte("结果\x01PWD:/tm"))); len(got) != 0 {
		t.Fatalf("半截哨兵不应产出事件：%+v", got)
	}
	got := normalize(assembler.push([]byte("p\x02\n")))
	expectEvents(t, got, []rawEvent{
		{kind: "lines", lines: []string{"结果"}},
		{kind: "prompt", cwd: "/tmp", droppedBytes: 0},
	})
}

func Test哨兵与输出同行时剥离合并(t *testing.T) {
	got := eventsOf(t, testReady+"\r\nout\x01PWD:/var\x02tail\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: ""},
		{kind: "lines", lines: []string{"outtail"}},
		{kind: "prompt", cwd: "/var", droppedBytes: 0},
	})
}

func Test纯哨兵行不产空输出行真实空行保留(t *testing.T) {
	got := eventsOf(t, testReady+"\r\n\x01PWD:/root\x02\r\n\r\n")
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: ""},
		{kind: "prompt", cwd: "/root", droppedBytes: 0},
		{kind: "lines", lines: []string{""}},
	})
}

func Test单轮预算触顶超出部分丢弃并计数prompt处重置(t *testing.T) {
	assembler := newStreamAssembler()
	assembler.push([]byte(testReady + "\r\n"))
	bigLine := strings.Repeat("x", TERMINAL_TURN_OUTPUT_BUDGET_BYTES-10)
	over := strings.Repeat("y", 5000)
	got := append(normalize(assembler.push([]byte(bigLine+"\r\n"+over+"\r\n"))),
		normalize(assembler.push([]byte("\x01PWD:/root\x02\r\nok\r\n")))...)
	expectEvents(t, got, []rawEvent{
		{kind: "lines", lines: []string{bigLine}},
		{kind: "prompt", cwd: "/root", droppedBytes: 5000},
		{kind: "lines", lines: []string{"ok"}},
	})
	if assembler.droppedBytes() != 0 {
		t.Fatalf("droppedBytes 应在 prompt 处归零，得 %d", assembler.droppedBytes())
	}
}

func TestFinish冲未换行末行READY未出现时一切作废(t *testing.T) {
	assembler := newStreamAssembler()
	assembler.push([]byte(testReady + "\r\npartial"))
	expectEvents(t, normalize(assembler.finish()), []rawEvent{{kind: "lines", lines: []string{"partial"}}})

	dead := newStreamAssembler()
	dead.push([]byte("died before ready"))
	expectEvents(t, normalize(dead.finish()), nil)
	if dead.isReady() {
		t.Fatal("READY 未出现 isReady 应为 false")
	}
}

func Test无换行洪流超硬上限即结扎丢弃并实时记账(t *testing.T) {
	assembler := newStreamAssembler()
	assembler.push([]byte(testReady + "\r\n"))
	chunk := strings.Repeat("x", 65536)
	// 前四块（恰等于预算）不触发。
	for i := 0; i < 4; i++ {
		if got := normalize(assembler.push([]byte(chunk))); len(got) != 0 {
			t.Fatalf("预算内洪流不应产出事件：%+v", got)
		}
		if assembler.droppedBytes() != 0 {
			t.Fatalf("预算内不应记账，得 %d", assembler.droppedBytes())
		}
	}
	if got := normalize(assembler.push([]byte(chunk))); len(got) != 0 {
		t.Fatalf("超限块不应产出事件：%+v", got)
	}
	if assembler.droppedBytes() != 5*65536 {
		t.Fatalf("第五块起应结扎记账 %d，得 %d", 5*65536, assembler.droppedBytes())
	}
	// 丢弃态继续吞增量并记账：内存不随洪流体积增长。
	assembler.push([]byte(chunk))
	if assembler.droppedBytes() != 6*65536 {
		t.Fatalf("丢弃态记账 %d，期望 %d", assembler.droppedBytes(), 6*65536)
	}
	if got := normalize(assembler.finish()); len(got) != 0 {
		t.Fatalf("丢弃态残尾应作废：%+v", got)
	}
}

func Test丢弃态的行终止残余记账其后各行恢复(t *testing.T) {
	assembler := newStreamAssembler()
	assembler.push([]byte(testReady + "\r\n"))
	assembler.push([]byte(strings.Repeat("x", TERMINAL_PENDING_MAX_CHARS+1)))
	got := normalize(assembler.push([]byte("tail-before-nl\nafter\n")))
	expectEvents(t, got, []rawEvent{{kind: "lines", lines: []string{"after"}}})
	want := TERMINAL_PENDING_MAX_CHARS + 1 + len("tail-before-nl")
	if assembler.droppedBytes() != want {
		t.Fatalf("丢弃记账 %d，期望 %d", assembler.droppedBytes(), want)
	}
}

func Test丢弃态保留哨兵(t *testing.T) {
	assembler := newStreamAssembler()
	assembler.push([]byte(testReady + "\r\n"))
	assembler.push([]byte(strings.Repeat("x", 300000)))
	got := normalize(assembler.push([]byte("\x01PWD:/tmp\x02\nok\n")))
	expectEvents(t, got, []rawEvent{
		{kind: "prompt", cwd: "/tmp", droppedBytes: 300000},
		{kind: "lines", lines: []string{"ok"}},
	})
	if assembler.droppedBytes() != 0 {
		t.Fatalf("droppedBytes 应随 prompt 归零，得 %d", assembler.droppedBytes())
	}
}

func Test伪造哨兵只认首个noteInput后恢复(t *testing.T) {
	assembler := newStreamAssembler()
	// 初始哨兵（bash 首提示符，跟在启动行这次输入之后）有效；其后无输入的哨兵是
	// 命令输出伪造的字面字节：剥离、不产事件、不重置预算。
	got := normalize(assembler.push([]byte(testReady + "\r\n\x01PWD:/a\x02\nout\n\x01PWD:/b\x02\n\x01PWD:/c\x02\n")))
	expectEvents(t, got, []rawEvent{
		{kind: "ready", pid: ""},
		{kind: "prompt", cwd: "/a", droppedBytes: 0},
		{kind: "lines", lines: []string{"out"}},
	})
	assembler.noteInput()
	got = normalize(assembler.push([]byte("\x01PWD:/d\x02\n")))
	expectEvents(t, got, []rawEvent{{kind: "prompt", cwd: "/d", droppedBytes: 0}})
}

func TestREADY哨兵十位以上pid不匹配(t *testing.T) {
	// {1,10} 位数字：11 位数字后接 \x02 整体不匹配（正则回溯语义），一切作废。
	assembler := newStreamAssembler()
	assembler.push([]byte("\x01READY:12345678901\x02\r\nout\r\n"))
	if assembler.isReady() {
		t.Fatal("11 位 pid 不应命中哨兵")
	}
	expectEvents(t, normalize(assembler.finish()), nil)
}

func Test终端字符宽度表锚点(t *testing.T) {
	cases := []struct {
		r    rune
		want int
	}{
		{'a', 1},
		{'中', 2},
		{0x1f600, 2}, // emoji 区段
		{0x0300, 0},  // 组合附加符
		{0xfe0f, 0},  // 变体选择符
		{0x2ff, 1},   // < 0x0300 恒 1
		{0x1100, 2},  // 谚文音节起始
		{0x115f, 2},
		{0x1160, 1}, // 谚文填充区外
		{0xff61, 1}, // 半角片假名区外（0xff00-0xff60 为宽）
		{0xff60, 2},
	}
	for _, tc := range cases {
		if got := terminalCharWidth(tc.r); got != tc.want {
			t.Fatalf("terminalCharWidth(%U) = %d，期望 %d", tc.r, got, tc.want)
		}
	}
}
