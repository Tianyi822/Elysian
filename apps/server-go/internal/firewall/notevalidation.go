package firewall

import (
	"regexp"
	"strings"

	"elysian/server/internal/shared"
)

// 备注禁区校验（shared/noteValidation.ts 等价物；Go 公共层未预置，已登记 gaps）。
// 两类禁区由备注的落点决定：
//   - 换行/回车等控制字符任何场景都拒：转发备注以双引号包进 before.rules 的一行规则，
//     含换行会把一行断成两行，iptables-restore 解析失败、防火墙停用；ufw 备注含换行
//     则写入后回读解析失败、规则从面板消失。
//   - 引号按落点拒绝：转发场景 comment 由双引号包裹（iptables-restore 只认双引号），
//     拒双引号；ufw 场景 comment 由单引号包裹（`ufw ... comment '...'`），拒单引号。

// 控制字符（C0 与 DEL）加 Unicode 行终止符（U+2028/U+2029）：后者虽非 \n，
// 按行切分时同样断行。
var unsafeNoteChars = regexp.MustCompile("[\x00-\x1f\x7f\u2028\u2029]")

// noteScene 备注落点场景。
type noteScene string

const (
	noteSceneForward noteScene = "forward"
	noteSceneUfw     noteScene = "ufw"
)

// hasUnsafeControlChars 是否含换行或控制字符。
func hasUnsafeControlChars(text string) bool {
	return unsafeNoteChars.MatchString(text)
}

// assertNoteSafe 校验备注可安全写进对应场景；不合法返回中文 400 错误，空备注放行。
func assertNoteSafe(note *string, scene noteScene) error {
	if note == nil || *note == "" {
		return nil
	}
	if hasUnsafeControlChars(*note) {
		return shared.InvalidRequest("备注不能包含换行或控制字符")
	}
	if scene == noteSceneForward && strings.ContainsRune(*note, '"') {
		// comment 以双引号包进规则文本，备注里的双引号会破坏规则。
		return shared.InvalidRequest("备注不能包含双引号")
	}
	if scene == noteSceneUfw && strings.ContainsRune(*note, '\'') {
		// ufw comment 参数以单引号包裹，备注里的单引号会被截断。
		return shared.InvalidRequest("备注不能包含单引号")
	}
	return nil
}
