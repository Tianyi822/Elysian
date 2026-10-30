package firewall

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestSSHPortOpenerRequiresInboundAnySourceAndBothFamilies(t *testing.T) {
	for _, rules := range [][]string{nil, {"allow out 2222/tcp"}, {"allow from 192.0.2.1 to any port 2222 proto tcp"}, {"allow 2222/tcp"}, {"limit 2222/tcp"}} {
		fake := createFakeDeps(fakeUfwDepsSeed{Active: true, Ipv6: "yes", Rules: rules})
		p := &sshPortOpener{host: fake, backend: 48101}
		result := p.EnsurePortRule(context.Background(), 2222, "SSH 端口联动放行")
		if result.State == "failed" {
			t.Fatalf("%v：%+v", rules, result)
		}

	}
}
func TestSSHPortOpenerRejectsDenyAndKeepsRules(t *testing.T) {
	for _, rule := range []string{"deny 2222/tcp", "reject in 2200:2300/tcp", "deny from 192.0.2.1 to any port 2222 proto tcp"} {
		fake := createFakeDeps(fakeUfwDepsSeed{Active: true, Rules: []string{rule}})
		p := &sshPortOpener{host: fake, backend: 48101}
		result := p.EnsurePortRule(context.Background(), 2222, "SSH")
		if result.State != "failed" {
			t.Fatalf("拒绝规则未保留：%s %+v", rule, result)
		}
		for _, call := range fake.calls() {
			if strings.HasPrefix(call, "allow ") || strings.HasPrefix(call, "delete ") {
				t.Fatal("拒绝时不得改规则", call)
			}
		}
	}
}
func TestSSHPortOpenerDisabledAndFailure(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	p := &sshPortOpener{host: fake, backend: 48101}
	if result := p.EnsurePortRule(context.Background(), 2222, "SSH"); result.State != "skipped" {
		t.Fatal(result)
	}
	if result := p.EnsurePortRule(context.Background(), 48101, "SSH"); result.State != "failed" {
		t.Fatal("不得放开后端", result)
	}
	fake = createFakeDeps(fakeUfwDepsSeed{Active: true})
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		if args[0] == "allow" {
			return "", errors.New("写入失败")
		}
		return next()
	}
	p.host = fake
	if result := p.EnsurePortRule(context.Background(), 2222, "SSH"); result.State != "failed" {
		t.Fatal(result)
	}
}
