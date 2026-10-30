package security

// /etc/ssh/sshd_config 的只读解析器与行级补丁器（parseSshdConfig.ts 与
// patchSshdConfig.ts 的 Go 等价物）：只处理面板要动的四个指令（Port、
// PasswordAuthentication、PubkeyAuthentication、PermitRootLogin），其余行不解释。
//
// 语义对齐 sshd_config(5)：井号起始的行是注释；指令名大小写不敏感；同一指令
// 多次出现时首个取值生效（first-obtained value，Port 是例外——多次出现为累积监听，
// 解析仍取首个用于面板显示，补丁侧负责消掉多余 Port 行）；Match 块整块跳过；
// 关键词与取值之间的「= 及紧邻空白」与空白分隔等价（Keyword=Value 写法）。

import (
	"strconv"
	"strings"
)

// SSHD_DIRECTIVE_NAMES 面板允许读写的四个指令名（规范大小写，顺序即补丁追加顺序）。
var SSHD_DIRECTIVE_NAMES = []string{"Port", "PasswordAuthentication", "PubkeyAuthentication", "PermitRootLogin", "KbdInteractiveAuthentication"}

// sshdDirectives 四个指令的解析结果；指令未在全局段出现（或取值无法辨认）时为 nil，
// 由调用方按 sshd 默认值兜底。
type sshdDirectives struct {
	port                         *int
	passwordAuthentication       *bool
	kbdInteractiveAuthentication *bool
	pubkeyAuthentication         *bool
	// permitRootLogin 存小写归一后的原始取值（含无法识别的值，由调用方裁决）。
	permitRootLogin *string
}

// sshdPatchEntry 补丁取值：指令名（规范大小写）→ 单个取值词；切片序即追加与
// 「本次修改」文案的连接顺序。
type sshdPatchEntry struct {
	Name  string
	Value string
}

// StripConfigComment sshd_config 里 `#` 只有出现在行首或空白之后才是注释起点
// （公钥等取值里不会有这个形态），返回注释前的段落。
func StripConfigComment(line string) string {
	// 正则 /(^\s*#|\s#)/ 取最左匹配：行首「空白*#」必在位置 0，先判它。
	i := 0
	for i < len(line) && isJSWhitespaceByte(line[i]) {
		i++
	}
	if i < len(line) && line[i] == '#' {
		return line[:0]
	}
	for j := 0; j+1 < len(line); j++ {
		if isJSWhitespaceByte(line[j]) && line[j+1] == '#' {
			return line[:j]
		}
	}
	return line
}

// NormalizeEqualsSeparator 把行内第一处「可选空白 + 恰一个 = + 可选空白」归一为
// 单个空白（`Port=22`、`Port = 22` 同 `Port 22`）；面板只读四个白名单指令，
// 它们的取值都不含 =，后续取值不受影响。
func NormalizeEqualsSeparator(line string) string {
	idx := strings.IndexByte(line, '=')
	if idx < 0 {
		return line
	}
	start := idx
	for start > 0 && isJSWhitespaceByte(line[start-1]) {
		start--
	}
	end := idx + 1
	for end < len(line) && isJSWhitespaceByte(line[end]) {
		end++
	}
	return line[:start] + " " + line[end:]
}

// normalizeConfigLine 行预处理的固定次序：剥注释 → trim → 等号归一。
func normalizeConfigLine(rawLine string) string {
	return NormalizeEqualsSeparator(strings.TrimSpace(StripConfigComment(rawLine)))
}

// parseSshdConfigValue 解析全文的全局段指令。
func parseSshdConfig(text string) sshdDirectives {
	directives := sshdDirectives{}
	seen := map[string]bool{}
	inMatchBlock := false

	for _, rawLine := range strings.Split(text, "\n") {
		line := normalizeConfigLine(rawLine)
		if line == "" {
			continue
		}
		tokens := strings.Fields(line)
		keyword := strings.ToLower(tokens[0])
		var value string
		hasValue := false
		if len(tokens) > 1 {
			value = tokens[1]
			hasValue = true
		}

		if keyword == "match" {
			// Match 块到文件尾或下一个 Match 为止，块内指令不进全局取值。
			inMatchBlock = true
			continue
		}
		if inMatchBlock {
			continue
		}

		name := sshdDirectiveName(keyword)
		if name == "" || !hasValue || seen[name] {
			continue
		}
		seen[name] = true

		switch name {
		case "Port":
			// 纯数字且 1-65535 才可用；parseInt("007")=7 同 JS。
			if isAllDigits(value) {
				if port, err := strconv.Atoi(value); err == nil && port >= 1 && port <= 65535 {
					v := port
					directives.port = &v
				}
			}
		case "PasswordAuthentication":
			v := parseYesNo(value)
			directives.passwordAuthentication = v
		case "KbdInteractiveAuthentication":
			directives.kbdInteractiveAuthentication = parseYesNo(value)
		case "PubkeyAuthentication":
			v := parseYesNo(value)
			directives.pubkeyAuthentication = v
		case "PermitRootLogin":
			// without-password 是 prohibit-password 的废弃别名（sshd_config(5)）：
			// 归一后交付，调用方的枚举匹配不再被别名打破；无法识别的取值原样保留。
			normalized := strings.ToLower(value)
			if normalized == "without-password" {
				normalized = "prohibit-password"
			}
			directives.permitRootLogin = &normalized
		}
	}

	return directives
}

// sshdDirectiveName 规范指令名（规范大小写）；不在白名单返回空串。
func sshdDirectiveName(keyword string) string {
	if strings.EqualFold(keyword, "ChallengeResponseAuthentication") {
		return "KbdInteractiveAuthentication"
	}
	for _, name := range SSHD_DIRECTIVE_NAMES {
		if strings.ToLower(name) == keyword {
			return name
		}
	}
	return ""
}

// parseYesNo yes/no 取值（大小写不敏感）；其余取值 nil。
func parseYesNo(value string) *bool {
	normalized := strings.ToLower(value)
	if normalized == "yes" {
		v := true
		return &v
	}
	if normalized == "no" {
		v := false
		return &v
	}
	return nil
}

// isAllDigits JS 正则 /^\d+$/ 的 ASCII 等价。
func isAllDigits(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

// PatchSshdConfig 逐行打补丁：已有全局取值就整行替换为规范写法（Port 替换首个
// 未注释行、注释掉其余未注释 Port 行——累积监听指令），没有就插到任何 Include 与
// Match 之前；Include 之后的非 Port 同指令行不替换（可能已被 drop-in 遮蔽）；
// 其余任何行原样保留；空补丁输出与输入逐字相同。
func PatchSshdConfig(text string, patch []sshdPatchEntry) string {
	// pending 按白名单固定顺序初始化（与 TS Map 的插入序一致）。
	var pending []sshdPendingEntry
	for _, name := range SSHD_DIRECTIVE_NAMES {
		for _, p := range patch {
			if p.Name == name {
				pending = append(pending, sshdPendingEntry{name: p.Name, value: p.Value})
			}
		}
	}

	lines := strings.Split(text, "\n")
	// 首个 Include 与首个 Match 的位置：前者决定面板行能否取得首个取值，后者划分全局段。
	firstIncludeIndex := len(lines)
	firstMatchIndex := len(lines)
	for index, raw := range lines {
		line := normalizeConfigLine(raw)
		if line == "" {
			continue
		}
		keyword := strings.ToLower(strings.Fields(line)[0])
		if keyword == "include" && firstIncludeIndex == len(lines) {
			firstIncludeIndex = index
		}
		if keyword == "match" && firstMatchIndex == len(lines) {
			firstMatchIndex = index
		}
	}
	// 插入点：全局段内、任何 Include 与 Match 之前；没有 Match 块则是文件尾
	//（保留结尾空行语义：末尾换行产物不算内容行，插入放它前面）。
	insertIndex := minInt(firstIncludeIndex, firstMatchIndex)
	if insertIndex == len(lines) && insertIndex > 0 && lines[insertIndex-1] == "" {
		insertIndex--
	}

	portPending := false
	for _, p := range pending {
		if p.name == "Port" {
			portPending = true
		}
	}
	portReplaced := false
	for index := 0; index < firstMatchIndex; index++ {
		line := normalizeConfigLine(lines[index])
		if line == "" {
			continue
		}
		keyword := strings.ToLower(strings.Fields(line)[0])

		if portPending && keyword == "port" {
			if !portReplaced {
				// 首个未注释 Port 行整行替换为规范写法。
				lines[index] = "Port " + pendingPortValue(pending)
				portReplaced = true
			} else {
				// Port 为累积监听指令：其余未注释行注释掉，否则旧端口仍在监听而面板只显示新端口。
				lines[index] = "#" + lines[index]
			}
			continue
		}

		for i := range pending {
			// 首次取值生效：只替换首个未注释行，后续行原样保留（本就不生效）。
			// 替换目标还必须先于任何 Include：晚于 Include 的取值可能已被 drop-in 遮蔽。
			if !pending[i].done && strings.ToLower(pending[i].name) == keyword && index < firstIncludeIndex {
				lines[index] = pending[i].name + " " + pending[i].value
				pending[i].done = true
			}
		}
	}
	// Port 已有替换落点时不再追加，避免同一端口写两行。
	if portReplaced {
		for i := range pending {
			if pending[i].name == "Port" {
				pending[i].done = true
			}
		}
	}

	var result []string
	inserted := false
	insertAt := insertIndex
	for i, line := range lines {
		if !inserted && i == insertAt {
			for _, p := range pending {
				if !p.done {
					result = append(result, p.name+" "+p.value)
				}
			}
			inserted = true
		}
		result = append(result, line)
	}
	if !inserted {
		// 插入点在文件尾之后（空文本等极端形态）：直接追加。
		for _, p := range pending {
			if !p.done {
				result = append(result, p.name+" "+p.value)
			}
		}
	}
	return strings.Join(result, "\n")
}

// sshdPendingEntry 补丁落点状态：done 表示已有替换落点或已追加。
type sshdPendingEntry struct {
	name  string
	value string
	done  bool
}

// pendingPortValue 取补丁里的 Port 取值（调用方保证存在）。
func pendingPortValue(pending []sshdPendingEntry) string {
	for _, p := range pending {
		if p.name == "Port" {
			return p.value
		}
	}
	return ""
}

// minInt 取两者较小值。
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
