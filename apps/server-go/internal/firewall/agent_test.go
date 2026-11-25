package firewall

import (
	"context"
	"strings"
	"testing"
)

// newAgentFacade 装配走 Agent 窄视图的防火墙，保留端口为 SSH 与面板前后端。
func newAgentFacade(seed fakeUfwDepsSeed) (*AgentFacade, *fakeUfwDeps, *int) {
	fake := createFakeDeps(seed)
	calls := 0
	facade := &AgentFacade{service: newService(fake), ports: []int{22, 48100, 48101}, authorize: func(context.Context) error { calls++; return nil }}
	return facade, fake, &calls
}

func TestAgentFirewallRejectsUnsafeRules(t *testing.T) {
	facade, fake, calls := newAgentFacade(fakeUfwDepsSeed{Active: true})
	for _, id := range []string{
		"tcp:22:192.0.2.4", "tcp:22:any", "tcp:48100:192.0.2.4", "tcp:48100:any",
		"tcp:8080:0.0.0.0", "tcp:8080:0.0.0.0/0", "tcp:8080:192.0.2.0/24", "tcp:08080:192.0.2.4", "tcp:08080:any",
		"tcp:8080:127.0.0.1", "tcp:8080:ANY", "tcp:8080:*", "any:8080:192.0.2.4", "tcp:8080",
	} {
		if _, err := facade.EnsureRule(context.Background(), id); err == nil {
			t.Fatalf("unsafe rule accepted: %s", id)
		}
	}
	if writes := fake.writeCommandCalls(); len(writes) != 0 {
		t.Fatalf("rejected rules wrote: %v", writes)
	}
	before := *calls
	value, err := facade.EnsureRule(context.Background(), "tcp:8080:192.0.2.4")
	if err != nil {
		t.Fatal(err)
	}
	if *calls != before+1 || value.(map[string]any)["changed"] != true {
		t.Fatalf("unexpected rule result=%+v calls=%d", value, *calls-before)
	}
	value, err = facade.EnsureRule(context.Background(), "tcp:8080:192.0.2.4")
	if err != nil || value.(map[string]any)["changed"] != false {
		t.Fatalf("not idempotent: %+v %v", value, err)
	}
	if _, err := (&AgentFacade{service: facade.service}).Snapshot(context.Background()); err == nil {
		t.Fatal("missing authorization accepted")
	}
}

func TestAgentFirewallAllowAllIps(t *testing.T) {
	facade, fake, calls := newAgentFacade(fakeUfwDepsSeed{Active: true})
	value, err := facade.EnsureRule(context.Background(), "tcp:8080:any")
	if err != nil {
		t.Fatal(err)
	}
	// 所有 IP 即 ufw 的 any：不带 from 的一条规则同时覆盖 IPv4 与 IPv6。
	result, _ := value.(map[string]any)
	if *calls != 1 || result["id"] != "tcp:8080:any" || result["changed"] != true {
		t.Fatalf("unexpected rule result=%+v calls=%d", value, *calls)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 1 || writes[0] != "allow 8080/tcp" {
		t.Fatalf("unexpected ufw writes=%v", writes)
	}
	rows, err := facade.service.List()
	if err != nil {
		t.Fatal(err)
	}
	matched := 0
	for _, row := range rows {
		if row.Port != 8080 {
			continue
		}
		matched++
		if row.Source != SourceAllIPs || row.Policy != "allow" || row.Direction != "inbound" || row.PortTo != nil {
			t.Fatalf("unexpected rule row=%+v", row)
		}
	}
	if matched == 0 {
		t.Fatal("rule missing from list")
	}
	value, err = facade.EnsureRule(context.Background(), "tcp:8080:any")
	if err != nil || value.(map[string]any)["changed"] != false {
		t.Fatalf("not idempotent: %+v %v", value, err)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 1 {
		t.Fatalf("idempotent call wrote again: %v", writes)
	}
}

// 同一协议的同一端口只能有一条规则：已有其它来源、端口段或其它策略时不叠加也不改写，
// 在写入前给出精确原因。
func TestAgentFirewallKeepsExistingPortRule(t *testing.T) {
	const narrow = "allow from 192.0.2.4 to any port 8080 proto tcp"
	for _, tc := range []struct{ seeded, id, reason string }{
		{narrow, "tcp:8080:any", "端口 8080/tcp 已有规则（入站放行，来源 192.0.2.4）"},
		{"allow 8080/tcp", "tcp:8080:192.0.2.4", "端口 8080/tcp 已有规则（入站放行，来源 所有IP）"},
		{narrow, "tcp:8080:192.0.2.5", "端口 8080/tcp 已有规则（入站放行，来源 192.0.2.4）"},
		{"allow 8000:9000/tcp", "tcp:8000:any", "端口 8000–9000/tcp 已有规则（入站放行，来源 所有IP）"},
		{"deny 8080/tcp", "tcp:8080:any", "端口 8080/tcp 已有规则（入站拒绝，来源 所有IP）"},
		{"limit 8080/tcp", "tcp:8080:any", "端口 8080/tcp 已有规则（入站限连，来源 所有IP）"},
	} {
		facade, fake, _ := newAgentFacade(fakeUfwDepsSeed{Active: true, Rules: []string{tc.seeded}})
		_, err := facade.EnsureRule(context.Background(), tc.id)
		if err == nil || !strings.Contains(err.Error(), tc.reason) || !strings.Contains(err.Error(), "安全页") {
			t.Fatalf("%s over %q: unexpected conflict: %v", tc.id, tc.seeded, err)
		}
		if writes := fake.writeCommandCalls(); len(writes) != 0 {
			t.Fatalf("%s over %q: conflict wrote rules: %v", tc.id, tc.seeded, writes)
		}
	}
	// 其它协议、出站方向与其它端口的规则互不影响。
	facade, fake, _ := newAgentFacade(fakeUfwDepsSeed{Active: true, Rules: []string{narrow, "allow out 8080/tcp", "allow 8081/tcp"}})
	value, err := facade.EnsureRule(context.Background(), "udp:8080:any")
	if err != nil || value.(map[string]any)["changed"] != true {
		t.Fatalf("udp rule blocked by tcp rule: %+v %v", value, err)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 1 || writes[0] != "allow 8080/udp" {
		t.Fatalf("unexpected ufw writes=%v", writes)
	}
}
