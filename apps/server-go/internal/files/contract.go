package files

import (
	"strings"
)

/*
 * 契约判据的域内副本（@elysian/contracts 的 files/files.ts 与 security/users.ts 纯函数）。
 * go-plan §4.4 要求这些判据住在 internal/contract，骨架尚未提供——按 gaps 协议在域内
 * 以私用副本顶位（不导出、不跨域共享），集成阶段上提 contract 后切换引用即可。
 * 正则与上限逐字照搬；字符串长度一律按 UTF-16 码元计（对齐 TS .length）。
 */

// fileNameMaxLength 文件名长度上限，沿用常见文件系统的 255 字节约束（TS .length 口径）。
const fileNameMaxLength = 255

// hostUserNameMaxLength 系统账号名长度上限（users 契约同值）。
const hostUserNameMaxLength = 32

// utf16Len 按 UTF-16 码元计长（对齐 JS String.prototype.length：BMP 内一字符一码元，
// 增补平面一字符两码元）。
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// isJSWhitespace JS 的空白字符集（WhiteSpace ∪ LineTerminator，含 BOM/零宽不换行空格）：
// \t \n \v \f \r 空格 U+00A0 U+1680 U+2000-U+200A U+2028 U+2029 U+202F U+205F U+3000 U+FEFF。
// 注意 JS 集不含 U+0085（NEL），与 Go unicode.IsSpace 不同，这里按 JS 口径枚举。
func isJSWhitespace(r rune) bool {
	switch {
	case r == 0x09 || r == 0x0A || r == 0x0B || r == 0x0C || r == 0x0D || r == 0x20:
		return true
	case r == 0xA0 || r == 0x1680:
		return true
	case r >= 0x2000 && r <= 0x200A:
		return true
	case r == 0x2028 || r == 0x2029 || r == 0x202F || r == 0x205F || r == 0x3000 || r == 0xFEFF:
		return true
	default:
		return false
	}
}

// jsTrim 按 JS String.prototype.trim 的空白集去首尾空白（含 BOM）。
func jsTrim(s string) string {
	return strings.TrimFunc(s, isJSWhitespace)
}

// isValidFileName 新条目名称判据：去首尾空白后非空、长度 ≤255、不是 `.` 或 `..`、
// 不含斜杠与控制字符。控制字符在判据层拦下：这类名字一旦落盘，按路径判据（同样拒绝
// 控制字符）在面板内不可再操作。重命名与粘贴前先过这一关，重名与否由数据层判定。
func isValidFileName(name string) bool {
	trimmed := jsTrim(name)
	length := utf16Len(trimmed)
	if length == 0 || length > fileNameMaxLength {
		return false
	}
	if trimmed == "." || trimmed == ".." {
		return false
	}
	if hasControlChars(trimmed) {
		return false
	}
	return !strings.Contains(trimmed, "/")
}

// isValidFileMode 三位八进制权限位判据（'000' 至 '777'，对齐 /^[0-7]{3}$/）。
func isValidFileMode(mode string) bool {
	if len(mode) != 3 {
		return false
	}
	for i := 0; i < 3; i++ {
		if mode[i] < '0' || mode[i] > '7' {
			return false
		}
	}
	return true
}

// normalizeFileSearch 搜索归一化：去全部空白（JS \s 集）并统一小写。
func normalizeFileSearch(text string) string {
	var b strings.Builder
	b.Grow(len(text))
	for _, r := range text {
		if isJSWhitespace(r) {
			continue
		}
		b.WriteRune(r)
	}
	return strings.ToLower(b.String())
}

// matchesFilePath 名称或所在路径任一命中即命中（比对前同样归一化）；空关键词视为命中，
// 是否发起搜索由调用方决定。
func matchesFilePath(keyword, name, path string) bool {
	needle := normalizeFileSearch(keyword)
	if needle == "" {
		return true
	}
	return strings.Contains(normalizeFileSearch(name), needle) ||
		strings.Contains(normalizeFileSearch(path), needle)
}

// isValidHostUserName 用户名判据：沿用 Linux 的取名习惯——小写字母或下划线开头，
// 其余为小写字母、数字、下划线或连字符，最长 32 个字符（对齐 /^[a-z_][a-z0-9_-]*$/）。
func isValidHostUserName(name string) bool {
	if utf16Len(name) > hostUserNameMaxLength || name == "" {
		return false
	}
	for i, r := range name {
		if r >= 0x80 {
			return false
		}
		isLower := r >= 'a' && r <= 'z'
		if i == 0 {
			if !isLower && r != '_' {
				return false
			}
			continue
		}
		if !isLower && !(r >= '0' && r <= '9') && r != '_' && r != '-' {
			return false
		}
	}
	return true
}
