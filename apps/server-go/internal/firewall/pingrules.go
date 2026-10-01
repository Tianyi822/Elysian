package firewall

import (
	"regexp"
	"strings"
)

// /etc/ufw/before.rules 的禁 ping 切换（pingRules.ts 等价物）。这是 Ubuntu 下禁 ping
// 的标准做法：把 input 链的 echo-request 放行改成丢弃，再走完整 disable→enable 生效。
// 只动 ufw-before-input（与 v6 文件的 ufw6-before-input）链；forward/output 链不碰。

var (
	reEchoRequestInput = regexp.MustCompile(`^(-A\s+ufw6?-before-input\s+.*--icmp(?:v6)?-type\s+echo-request\s+.*)-j\s+(ACCEPT|DROP)\s*$`)
	reEchoRequestDrop  = regexp.MustCompile(`-A\s+ufw6?-before-input\s+.*--icmp(?:v6)?-type\s+echo-request\s+.*-j\s+DROP\s*$`)
)

// parsePingBlocked 是否处于禁 ping（input 链存在 DROP 的 echo-request 规则）。
func parsePingBlocked(beforeRules string) bool {
	for _, line := range strings.Split(beforeRules, "\n") {
		if reEchoRequestDrop.MatchString(line) {
			return true
		}
	}
	return false
}

// setPingBlocked 在 input 链的 echo-request 行上切换 ACCEPT 与 DROP；其余行原样保留。
func setPingBlocked(beforeRules string, blocked bool) string {
	target := "ACCEPT"
	if blocked {
		target = "DROP"
	}
	lines := strings.Split(beforeRules, "\n")
	for i, line := range lines {
		m := reEchoRequestInput.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		lines[i] = m[1] + "-j " + target
	}
	return strings.Join(lines, "\n")
}
