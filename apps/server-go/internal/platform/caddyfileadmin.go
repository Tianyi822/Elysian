package platform

import (
	"errors"
	"regexp"
	"strings"
)

// 把 Caddyfile 的全局段收成面板需要的 admin unix socket（caddyfileAdmin.ts 等价物）。
// 只改全局段里的 admin 指令，站点块原样留下；全局段括号不配对时拒绝改写。

// caddyfileGlobalUnclosed 全局段括号不配对时的失败句（逐字契约）。
const caddyfileGlobalUnclosed = "Caddyfile 全局段没有结束括号"

// errCaddyfileGlobalUnclosed 拒绝改写的哨兵错误（消息即失败句原文）。
var errCaddyfileGlobalUnclosed = errors.New(caddyfileGlobalUnclosed)

// adminLinePattern 全局段内的 admin 指令行。
var adminLinePattern = regexp.MustCompile(`^\s*admin\s+`)

// caddyAdminDirective Caddyfile 全局段的 admin 指令。`unix/` 加绝对路径即文档里的
// `unix//run/...`。
func caddyAdminDirective(socketPath string) string {
	return "admin unix/" + socketPath
}

// indexOfGlobalOpen 跳过空行与 # 注释，找到全局段的起始 `{`；首个非跳过行不是单独
// 的 `{` 就视为没有全局段。
func indexOfGlobalOpen(lines []string) int {
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if trimmed == "{" {
			return index
		}
		return -1
	}
	return -1
}

// indexOfGlobalClose 按字符深度配对找全局段结束行；找不到返回 -1。
func indexOfGlobalClose(lines []string, open int) int {
	depth := 0
	for index := open; index < len(lines); index++ {
		for _, char := range lines[index] {
			if char == '{' {
				depth++
			} else if char == '}' {
				depth--
			}
		}
		if index > open && depth == 0 {
			return index
		}
	}
	return -1
}

// ensureCaddyAdminSocket 保证全局段声明目标 admin 地址。已是该地址则文本不变（只统一
// 换行与尾换行）；已有别的 admin 则换成这一条；没有全局段则在文件头补上。
func ensureCaddyAdminSocket(source, socketPath string) (string, error) {
	directive := caddyAdminDirective(socketPath)
	normalized := strings.ReplaceAll(source, "\r\n", "\n")
	lines := strings.Split(normalized, "\n")
	start := indexOfGlobalOpen(lines)
	if start == -1 {
		body := strings.TrimSpace(normalized)
		if body == "" {
			return "{\n\t" + directive + "\n}\n", nil
		}
		return "{\n\t" + directive + "\n}\n\n" + body + "\n", nil
	}
	end := indexOfGlobalClose(lines, start)
	if end == -1 {
		return "", errCaddyfileGlobalUnclosed
	}
	var adminIndexes []int
	for index := start + 1; index < end; index++ {
		if adminLinePattern.MatchString(lines[index]) {
			adminIndexes = append(adminIndexes, index)
		}
	}
	if len(adminIndexes) == 1 && strings.TrimSpace(lines[adminIndexes[0]]) == directive {
		return withTrailingNewline(normalized), nil
	}
	adminSet := make(map[int]bool, len(adminIndexes))
	for _, index := range adminIndexes {
		adminSet[index] = true
	}
	filtered := make([]string, 0, len(lines))
	for index, line := range lines {
		if !adminSet[index] {
			filtered = append(filtered, line)
		}
	}
	// 在段首后插恰好一条目标 admin（对齐 TS kept.splice(start+1, 0, ...)）。
	kept := make([]string, 0, len(filtered)+1)
	kept = append(kept, filtered[:start+1]...)
	kept = append(kept, "\t"+directive)
	kept = append(kept, filtered[start+1:]...)
	return withTrailingNewline(strings.Join(kept, "\n")), nil
}
