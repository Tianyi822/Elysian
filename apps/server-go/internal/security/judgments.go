package security

// 契约判据（@elysian/contracts 的 security/ssh.ts 与 users.ts 等价物）：界面与服务端
// 复验共用同一函数，错误消息是 API 契约（中文，逐字）。go-plan §4.4 列在 internal/contract，
// 骨架未预置，本域先行落在包内，已登记 gaps 由集成阶段归位。

import (
	"math"
	"strings"
)

// SSHDefaultPort sshd_config 缺省端口（sshd_config(5)：Port 22）。
const SSHDefaultPort = 22

// SSHKeyNameMaxLength 密钥名称长度上限。
const SSHKeyNameMaxLength = 32

// SSHRootLoginPolicies Root 登录策略取值表（sshd_config(5) 的 PermitRootLogin）。
var SSHRootLoginPolicies = []string{"no", "prohibit-password", "forced-commands-only", "yes"}

// HostUserNameMaxLength 用户名长度上限。
const HostUserNameMaxLength = 32

// HostUserLoginMethods 单个账号允许的认证方式。
var HostUserLoginMethods = []string{"password", "key", "password-or-key", "none"}

// HostUserStatuses 账号状态取值。
var HostUserStatuses = []string{"active", "disabled"}

// IsValidSshPort 端口是否可用：整数且落在 1-65535（JS Number.isInteger 语义：
// NaN 与 ±Infinity 都不是整数）。
func IsValidSshPort(port float64) bool {
	if math.IsNaN(port) || math.IsInf(port, 0) {
		return false
	}
	return port == math.Trunc(port) && port >= 1 && port <= 65535
}

// IsValidSshKeyName 密钥名称是否可用：去空白后非空且不超上限。
func IsValidSshKeyName(name string) bool {
	trimmed := strings.TrimSpace(name)
	return len([]rune(trimmed)) > 0 && len([]rune(trimmed)) <= SSHKeyNameMaxLength
}

// EvaluateSshPasswordStrength 演示级弱密码判定：长度与字符类别两条尺子（weak|medium|strong）。
func EvaluateSshPasswordStrength(password string) string {
	classes := characterClassCount(password)
	if len([]rune(password)) >= 12 && classes >= 3 {
		return "strong"
	}
	if len([]rune(password)) >= 8 && classes >= 2 {
		return "medium"
	}
	return "weak"
}

// characterClassCount 小写、大写、数字、符号四类的命中数。
func characterClassCount(password string) int {
	classes := 0
	hasLower, hasUpper, hasDigit, hasOther := false, false, false, false
	for _, r := range password {
		switch {
		case r >= 'a' && r <= 'z':
			hasLower = true
		case r >= 'A' && r <= 'Z':
			hasUpper = true
		case r >= '0' && r <= '9':
			hasDigit = true
		default:
			hasOther = true
		}
	}
	if hasLower {
		classes++
	}
	if hasUpper {
		classes++
	}
	if hasDigit {
		classes++
	}
	if hasOther {
		classes++
	}
	return classes
}

// IsValidHostUserName 用户名判据：小写字母或下划线开头，其余为小写字母、数字、
// 下划线或连字符，最长 32 个字符。
func IsValidHostUserName(name string) bool {
	if len(name) > HostUserNameMaxLength {
		return false
	}
	for i, r := range name {
		switch {
		case r >= 'a' && r <= 'z' || r == '_':
			// 首字符与续字符都允许
		case r >= '0' && r <= '9' || r == '-':
			if i == 0 {
				return false
			}
		default:
			return false
		}
	}
	return len(name) > 0
}

// hasUnsafeControlChars 控制字符（C0 与 DEL）加 Unicode 行终止符（U+2028/U+2029）：
// 会进命令参数或按行落盘的自由文本共用同一条禁区判据。
func hasUnsafeControlChars(text string) bool {
	for _, r := range text {
		if r <= 0x1f || r == 0x7f || r == 0x2028 || r == 0x2029 {
			return true
		}
	}
	return false
}
