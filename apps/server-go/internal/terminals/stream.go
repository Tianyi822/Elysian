package terminals

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// 终端字节流 → 行模型的纯汇编器（无 IO、无定时器）：流式 UTF-8 解码、按 \n 切行保
// 留不完整行、每行按终端语义落成文本（renderTerminalLine）、\x01…\x02 哨兵提取
// （READY / PWD）。READY 哨兵（本机 \x01READY\x02、容器 exec 的 \x01READY:<pid>\x02）
// 之前的一切输出丢弃。单命令轮输出预算在 prompt 事件处重置；无换行积压设硬上限，
// 超限结扎丢弃并记账（丢弃态只保留行终止与 PWD 哨兵两类边界信号）。PWD 哨兵只在
// 跟过真实输入（noteInput）后才被当作命令结束信号。

// 汇编器事件三类：ready（READY 哨兵已见）、lines（完整输出行）、prompt（命令结束）。
const (
	eventReady = iota
	eventLines
	eventPrompt
)

// streamEvent 一次喂入产出的流内事件（次序即流内次序）。
type streamEvent struct {
	kind         int
	pid          string // ready：容器 exec 哨兵携带的 shell pid
	hasPid       bool   // ready：哨兵是否带 pid（本机启动行不带）
	lines        []string
	cwd          string // prompt
	droppedBytes int    // prompt
}

// READY_CARRY_CHARS READY 之前 pending 保留的尾部上界：哨兵最长形态共 18 字符，
// 跨块分裂时任一真前缀都不超过 17 字符，保留 17 字符的尾部不漏识别。
const READY_CARRY_CHARS = 17

// PWD_SENTINEL_PREFIX PWD 哨兵的起始前缀：超长行丢弃态下唯一保留识别的边界信号。
const PWD_SENTINEL_PREFIX = "\x01PWD:"

// WIDE_TAIL 行缓冲里宽字符次格的占位：首格放字符本身，拼接时次格不产出文本
// （空串哨兵与 TS 版一致，单元格里不会有其它来源的空串）。
const WIDE_TAIL = ""

// utf8Decoder 流式 UTF-8 解码器（TS TextDecoder(stream:true) 等价）：跨 chunk 的
// 多字节字符续接，无效序列以 U+FFFD 顶替。
type utf8Decoder struct {
	carry []byte
}

// expectedSeqLen 由起始字节推断多字节序列长度；返回 0 表示该字节是无效起始。
func expectedSeqLen(b byte) int {
	switch {
	case b < 0x80:
		return 1
	case b >= 0xc0 && b <= 0xdf:
		return 2
	case b >= 0xe0 && b <= 0xef:
		return 3
	case b >= 0xf0 && b <= 0xf7:
		return 4
	default:
		return 0
	}
}

// decode 解码一段字节；final 为 true 时冲刷残尾（不完整序列按无效顶替）。
func (d *utf8Decoder) decode(chunk []byte, final bool) string {
	data := d.carry
	data = append(data, chunk...)
	d.carry = nil
	var sb strings.Builder
	for len(data) > 0 {
		r, size := utf8.DecodeRune(data)
		if r == utf8.RuneError && size == 1 {
			need := expectedSeqLen(data[0])
			if need > 1 && len(data) < need && !final {
				// 可能是被截断的多字节序列前缀：留待下一块续接。
				break
			}
			sb.WriteRune(utf8.RuneError)
			data = data[1:]
			continue
		}
		sb.WriteRune(r)
		data = data[size:]
	}
	if !final && len(data) > 0 {
		d.carry = append([]byte(nil), data...)
	}
	return sb.String()
}

// pwdPrefixCarry 文本尾部与 \x01PWD: 前缀的最长重叠：跨块分裂的哨兵在丢弃态仍可被识别。
func pwdPrefixCarry(text string) string {
	max := len(PWD_SENTINEL_PREFIX) - 1
	if len(text) < max {
		max = len(text)
	}
	for l := max; l > 0; l-- {
		if strings.HasSuffix(text, PWD_SENTINEL_PREFIX[:l]) {
			return text[len(text)-l:]
		}
	}
	return ""
}

// clearCell 覆盖宽字符的任一半格时另一半一并清成空格：与终端一致，不留半个字。
func clearCell(cells *[]string, index int) {
	c := *cells
	if index >= len(c) {
		return
	}
	if c[index] == WIDE_TAIL && index > 0 {
		c[index-1] = " "
	}
	if index+1 < len(c) && c[index+1] == WIDE_TAIL {
		c[index+1] = " "
	}
	c[index] = " "
}

// csiCount CSI 参数计数：解析失败或 <1 按 1（TS parseInt NaN 语义）。
func csiCount(params string) int {
	n, err := strconv.Atoi(params)
	if err != nil || n < 1 {
		return 1
	}
	return n
}

// isDroppedControl 无操作语义的控制字符（C0 与 DEL，除 \r\b\t 落行时单独处理）。
func isDroppedControl(token string) bool {
	if len(token) != 1 {
		return false
	}
	c := token[0]
	return (c < 0x20 && c != '\r' && c != '\b' && c != '\t') || c == 0x7f
}

// nextLineToken 行内 token 文法（TS LINE_TOKEN 正则的等价手写扫描）：OSC 转义
// （ESC ] … BEL 或 ST）、CSI 转义（ESC [ 参数列[0-?] 中间列[ -/] 终结字节[@-~]）、
// 其余单字符 ESC 序列（ESC 后跟 0x40-0x5A / 0x5C-0x5F），以及单个码点。
func nextLineToken(s string, i int) (token, csiParams string, csiFinal byte, isCSI bool, next int) {
	if s[i] != 0x1b {
		_, size := utf8.DecodeRuneInString(s[i:])
		if size <= 0 {
			size = 1
		}
		return s[i : i+size], "", 0, false, i + size
	}
	if i+1 >= len(s) {
		return s[i : i+1], "", 0, false, i + 1
	}
	switch s[i+1] {
	case ']': // OSC：以 BEL 或 ST（ESC \）结束
		j := i + 2
		for j < len(s) && s[j] != 0x07 && s[j] != 0x1b {
			j++
		}
		if j < len(s) && s[j] == 0x07 {
			return s[i : j+1], "", 0, false, j + 1
		}
		if j+1 < len(s) && s[j] == 0x1b && s[j+1] == '\\' {
			return s[i : j+2], "", 0, false, j + 2
		}
		// 未终止的 OSC 回落为单字符 ESC 序列（']' 在集合内），其余字节逐个处理。
		return s[i : i+2], "", 0, false, i + 2
	case '[': // CSI：参数列 + 中间列 + 终结字节
		j := i + 2
		paramStart := j
		for j < len(s) && s[j] >= 0x30 && s[j] <= 0x3f {
			j++
		}
		params := s[paramStart:j]
		for j < len(s) && s[j] >= 0x20 && s[j] <= 0x2f {
			j++
		}
		if j < len(s) && s[j] >= 0x40 && s[j] <= 0x7e {
			return "", params, s[j], true, j + 1
		}
		// 未终止的 CSI：lone ESC 按单字符（'[' 不在单字符序列集合内）。
		return s[i : i+1], "", 0, false, i + 1
	default:
		c := s[i+1]
		if (c >= 0x40 && c <= 0x5a) || (c >= 0x5c && c <= 0x5f) {
			return s[i : i+2], "", 0, false, i + 2
		}
		return s[i : i+1], "", 0, false, i + 1
	}
}

// renderTerminalLine 按终端语义把一行（已解码、已提取哨兵）落成文本：光标在行缓冲
// 里移动，\r 回行首后覆盖写，\b 左移一格，\t 跳到下一个制表位并以空格补位，CSI K
// 擦除行内、CSI C/D/G 横移光标；宽字符占两格。其余转义与控制字符丢弃。
func renderTerminalLine(raw string) string {
	var cells []string
	col := 0
	for i := 0; i < len(raw); {
		token, csiParams, csiFinal, isCSI, next := nextLineToken(raw, i)
		i = next
		if isCSI {
			switch csiFinal {
			case 'K':
				mode := 0
				if csiParams != "" {
					m, err := strconv.Atoi(csiParams)
					if err != nil {
						mode = -1 // NaN：无操作（TS Number 解析失败语义）
					} else {
						mode = m
					}
				}
				switch mode {
				case 0:
					if col < len(cells) {
						if col > 0 && cells[col] == WIDE_TAIL {
							cells[col-1] = " "
						}
						cells = cells[:col]
					}
				case 1:
					for index := 0; index <= col; index++ {
						clearCell(&cells, index)
					}
				case 2:
					cells = cells[:0]
				}
			case 'C':
				col += csiCount(csiParams)
			case 'D':
				col -= csiCount(csiParams)
				if col < 0 {
					col = 0
				}
			case 'G':
				col = csiCount(csiParams) - 1
			}
			continue
		}
		if strings.HasPrefix(token, "\x1b") && len(token) > 1 {
			continue
		}
		switch token {
		case "\r":
			col = 0
			continue
		case "\b":
			if col > 0 {
				col--
			}
			continue
		case "\t":
			col = (col/TERMINAL_TAB_WIDTH + 1) * TERMINAL_TAB_WIDTH
			continue
		}
		if isDroppedControl(token) {
			continue
		}
		r, _ := utf8.DecodeRuneInString(token)
		width := terminalCharWidth(r)
		if width == 0 {
			target := col - 1
			if target >= 0 && target < len(cells) && cells[target] == WIDE_TAIL {
				target--
			}
			if target >= 0 && target < len(cells) {
				cells[target] += token
			}
			continue
		}
		for len(cells) < col {
			cells = append(cells, " ")
		}
		for index := col; index < col+width; index++ {
			clearCell(&cells, index)
		}
		for len(cells) <= col {
			cells = append(cells, " ")
		}
		cells[col] = token
		if width == 2 {
			for len(cells) <= col+1 {
				cells = append(cells, " ")
			}
			cells[col+1] = WIDE_TAIL
		}
		col += width
	}
	return strings.Join(cells, "")
}

// readyMarker READY 哨兵的固定前缀。
const readyMarker = "\x01READY"

// findReadySentinel 在 s 中找 READY 哨兵（\x01READY\x02 或 \x01READY:<1-10 位数字>\x02，
// 与 TS 正则 \x01READY(?::([0-9]{1,10}))?\x02 等价：带 ':' 但数字位数不落 1-10 或后不
// 接 \x02 的形态在该位置整体不匹配，继续向后找）。返回结束位置与 pid。
func findReadySentinel(s string) (end int, pid string, hasPid, found bool) {
	searchFrom := 0
	for searchFrom <= len(s) {
		idx := strings.Index(s[searchFrom:], readyMarker)
		if idx == -1 {
			return 0, "", false, false
		}
		idx += searchFrom
		if e, p, has, ok := matchReadyAt(s, idx); ok {
			return e, p, has, true
		}
		searchFrom = idx + 1
	}
	return 0, "", false, false
}

// matchReadyAt 判定 s[idx:] 是否以完整 READY 哨兵开头。
func matchReadyAt(s string, idx int) (end int, pid string, hasPid, found bool) {
	rest := s[idx+len(readyMarker):]
	if strings.HasPrefix(rest, "\x02") {
		return idx + len(readyMarker) + 1, "", false, true
	}
	if !strings.HasPrefix(rest, ":") {
		return 0, "", false, false
	}
	digits := 0
	for 1+digits < len(rest) && rest[1+digits] >= '0' && rest[1+digits] <= '9' {
		digits++
	}
	if digits >= 1 && digits <= 10 && 1+digits < len(rest) && rest[1+digits] == '\x02' {
		return idx + len(readyMarker) + 1 + digits + 1, rest[1 : 1+digits], true, true
	}
	return 0, "", false, false
}

// readyCarry pending 尾部 ≤17 字符的保留（按字符切，避免多字节字符被字节切撕裂）。
func readyCarry(pending string) string {
	runes := []rune(pending)
	if len(runes) <= READY_CARRY_CHARS {
		return pending
	}
	return string(runes[len(runes)-READY_CARRY_CHARS:])
}

// streamAssembler PTY 字节流 → 事件汇编器（纯内存状态机）。
type streamAssembler struct {
	decoder          utf8Decoder
	pending          string
	seenReady        bool
	skipToNewline    bool
	turnBytes        int
	turnDroppedBytes int
	events           []streamEvent
	// dropping 超长行丢弃态：pending 已清空，增量在 consumeDropped 里丢弃记账。
	dropping bool
	// dropCarry 丢弃态下跨块哨兵前缀的碎片缓存。
	dropCarry string
	// promptArmed 下一个 PWD 哨兵是否被接受：READY（启动行）与 noteInput（真实输入）武装。
	promptArmed bool
}

func newStreamAssembler() *streamAssembler { return &streamAssembler{} }

// isReady READY 哨兵是否已出现（服务端据此判定驯化 bash 已就绪）。
func (a *streamAssembler) isReady() bool { return a.seenReady }

// droppedBytes 当前命令轮累计被丢字节数（prompt 事件发出时清零；流结束时供退出路径读取）。
func (a *streamAssembler) droppedBytes() int { return a.turnDroppedBytes }

// noteInput 客户端向 PTY 写入了新输入（input/interrupt 帧）：解锁下一个 PWD 哨兵。
// 命令输出可伪造字面哨兵字节，只有跟在真实输入之后的哨兵才被当作命令结束信号。
func (a *streamAssembler) noteInput() { a.promptArmed = true }

// push 喂入一段 PTY 输出字节，返回这段字节产出的全部事件（次序即流内次序）。
func (a *streamAssembler) push(chunk []byte) []streamEvent {
	a.events = nil
	text := a.decoder.decode(chunk, false)
	if a.dropping {
		text = a.consumeDropped(a.dropCarry + text)
		a.dropCarry = ""
		if text == "" {
			return a.events
		}
	}
	a.pending += text
	a.drain()
	return a.events
}

// finish 流结束：冲刷解码器残尾，未换行的末行按完整行处理。
func (a *streamAssembler) finish() []streamEvent {
	a.events = nil
	a.pending += a.decoder.decode(nil, true)
	if !a.seenReady {
		// 流结束仍未见到 READY 哨兵：启动失败或进程秒退，一切输出作废。
		a.pending = ""
		return a.events
	}
	if a.dropping {
		// 丢弃态未恢复的残尾（含哨兵前缀碎片）一并作废：丢弃已在发生时记账。
		a.pending = ""
		a.dropCarry = ""
		return a.events
	}
	if a.pending != "" {
		rest := a.pending
		a.pending = ""
		a.handleLine(rest)
	}
	return a.events
}

// drain 切行主循环：READY 识别、行终结消费与超长 pending 结扎。
func (a *streamAssembler) drain() {
	if !a.seenReady {
		end, pid, hasPid, found := findReadySentinel(a.pending)
		if !found {
			// READY 之前的一切字节丢弃；只保留可能是跨块哨兵前缀的尾部。
			a.pending = readyCarry(a.pending)
			return
		}
		a.pending = a.pending[end:]
		a.seenReady = true
		a.promptArmed = true // 启动行是服务端写入的第一次输入：其后的首提示符哨兵有效。
		a.skipToNewline = true
		a.events = append(a.events, streamEvent{kind: eventReady, pid: pid, hasPid: hasPid})
	}
	if a.skipToNewline {
		// READY 哨兵自带行终止符（printf '\n'）：连同其后的行尾一并消费，不产空行。
		nl := strings.IndexByte(a.pending, '\n')
		if nl == -1 {
			a.pending = ""
			return
		}
		a.pending = a.pending[nl+1:]
		a.skipToNewline = false
	}
	for {
		nl := strings.IndexByte(a.pending, '\n')
		if nl == -1 {
			// 无换行的积压设硬上限：超限立即结扎这行、丢弃记账并进入丢弃态——
			// 预算的执行不依赖换行到达，无换行洪流（cat /dev/zero 类）的内存有界。
			if utf8.RuneCountInString(a.pending) > TERMINAL_PENDING_MAX_CHARS {
				a.turnDroppedBytes += len(a.pending)
				a.pending = ""
				a.dropping = true
			}
			return
		}
		rawLine := a.pending[:nl]
		a.pending = a.pending[nl+1:]
		a.handleLine(rawLine)
	}
}

// consumeDropped 超长行丢弃态：丢弃一切内容字节并记账，只保留两类边界信号——行终止
// \n 与 PWD 哨兵（命令结束信号不能因截断而丢失）。返回恢复正常处理的剩余文本；
// 空串表示整段丢弃（哨兵前缀碎片存入 dropCarry）。
func (a *streamAssembler) consumeDropped(text string) string {
	nl := strings.IndexByte(text, '\n')
	sentinel := strings.Index(text, PWD_SENTINEL_PREFIX)
	if sentinel != -1 && (nl == -1 || sentinel < nl) {
		a.turnDroppedBytes += len(text[:sentinel])
		a.dropping = false
		return text[sentinel:]
	}
	if nl != -1 {
		a.turnDroppedBytes += len(text[:nl])
		a.dropping = false
		return text[nl+1:]
	}
	carry := pwdPrefixCarry(text)
	a.turnDroppedBytes += len(text[:len(text)-len(carry)])
	a.dropCarry = carry
	return ""
}

// handleLine 一行：先提取 PWD 哨兵（\x01/\x02 属控制字符，必须在控制字符过滤之前），
// 再按终端语义落行、执行单轮预算，最后按输入门控产出 prompt 事件。
func (a *streamAssembler) handleLine(rawLine string) {
	var cwds []string
	var rest strings.Builder
	last := 0
	pos := 0
	for pos <= len(rawLine) {
		idx := strings.Index(rawLine[pos:], PWD_SENTINEL_PREFIX)
		if idx == -1 {
			break
		}
		idx += pos
		contentStart := idx + len(PWD_SENTINEL_PREFIX)
		term := strings.IndexByte(rawLine[contentStart:], '\x02')
		if term == -1 {
			// 无 \x02 终止：正则同样不匹配，前缀留在文本里（控制字符随后被剥离）。
			break
		}
		term += contentStart
		rest.WriteString(rawLine[last:idx])
		last = term + 1
		cwds = append(cwds, rawLine[contentStart:term])
		pos = term + 1
	}
	rest.WriteString(rawLine[last:])

	cleaned := renderTerminalLine(rest.String())
	// 哨兵行清空后是控制元数据，不再产出空输出行；无哨兵的空行是真实空行，保留。
	if !(cleaned == "" && len(cwds) > 0) {
		bytes := len(cleaned)
		if a.turnBytes+bytes > TERMINAL_TURN_OUTPUT_BUDGET_BYTES {
			a.turnDroppedBytes += bytes
		} else {
			a.turnBytes += bytes
			a.events = append(a.events, streamEvent{kind: eventLines, lines: []string{cleaned}})
		}
	}
	for _, cwd := range cwds {
		// 无输入即得的哨兵是伪造或重复（命令输出可产字面哨兵字节）：剥离丢弃，
		// 不产 prompt 事件、不重置预算。
		if !a.promptArmed {
			continue
		}
		a.promptArmed = false
		dropped := a.turnDroppedBytes
		a.turnBytes = 0
		a.turnDroppedBytes = 0
		a.events = append(a.events, streamEvent{kind: eventPrompt, cwd: cwd, droppedBytes: dropped})
	}
}
