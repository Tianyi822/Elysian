package firewall

import (
	"strings"
	"testing"
)

// pingRules.test.ts 的对等测试：只改 input 链的 echo-request 行。

const beforeRulesPingFixture = `# Don't delete these required lines,
*filter
:ufw-before-input - [0:0]
:ufw-before-output - [0:0]
-A ufw-before-input -i lo -j ACCEPT
-A ufw-before-input -p icmp --icmp-type destination-unreachable -j ACCEPT
-A ufw-before-input -p icmp --icmp-type time-exceeded -j ACCEPT
-A ufw-before-input -p icmp --icmp-type parameter-problem -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
-A ufw-before-forward -p icmp --icmp-type echo-request -j ACCEPT
-A ufw-before-output -o lo -j ACCEPT
COMMIT`

const beforeRulesPingBlocked = `# Don't delete these required lines,
*filter
:ufw-before-input - [0:0]
:ufw-before-output - [0:0]
-A ufw-before-input -i lo -j ACCEPT
-A ufw-before-input -p icmp --icmp-type destination-unreachable -j ACCEPT
-A ufw-before-input -p icmp --icmp-type time-exceeded -j ACCEPT
-A ufw-before-input -p icmp --icmp-type parameter-problem -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j DROP
-A ufw-before-input -p icmp --icmp-type echo-request -j DROP
-A ufw-before-forward -p icmp --icmp-type echo-request -j ACCEPT
-A ufw-before-output -o lo -j ACCEPT
COMMIT`

func TestParsePingBlocked(t *testing.T) {
	if parsePingBlocked(beforeRulesPingFixture) {
		t.Error("input 链 echo-request 为 ACCEPT 时未禁 ping")
	}
	if !parsePingBlocked(beforeRulesPingBlocked) {
		t.Error("input 链 echo-request 为 DROP 时已禁 ping")
	}
}

func TestSetPingBlocked(t *testing.T) {
	next := setPingBlocked(beforeRulesPingFixture, true)
	if next != beforeRulesPingBlocked {
		t.Errorf("禁 ping 只应改 input 链的 echo-request 行：\ngot:  %q\nwant: %q", next, beforeRulesPingBlocked)
	}
	// forward/output 链不受影响。
	if !strings.Contains(next, "-A ufw-before-forward -p icmp --icmp-type echo-request -j ACCEPT") {
		t.Error("forward 链的 echo-request 行不应被动")
	}
	if got := setPingBlocked(beforeRulesPingBlocked, false); got != beforeRulesPingFixture {
		t.Error("恢复放行应回到原始内容")
	}
	if got := setPingBlocked("# empty\nCOMMIT\n", true); got != "# empty\nCOMMIT\n" {
		t.Error("没有 echo-request 行时应原样返回")
	}
}
