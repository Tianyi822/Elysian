package firewall

import (
	"context"
	"testing"
)

func TestAgentFirewallOnlyPreciseBusinessRules(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	calls := 0
	facade := &AgentFacade{service: newService(fake), ports: []int{22, 48100, 48101}, authorize: func(context.Context) error { calls++; return nil }}
	for _, id := range []string{"tcp:22:192.0.2.4", "tcp:48100:192.0.2.4", "tcp:8080:0.0.0.0", "tcp:8080:192.0.2.0/24", "tcp:08080:192.0.2.4", "tcp:8080:127.0.0.1", "any:8080:192.0.2.4"} {
		if _, err := facade.EnsureRule(context.Background(), id); err == nil {
			t.Fatalf("unsafe rule accepted: %s", id)
		}
	}
	before := calls
	value, err := facade.EnsureRule(context.Background(), "tcp:8080:192.0.2.4")
	if err != nil {
		t.Fatal(err)
	}
	if calls != before+1 || value.(map[string]any)["changed"] != true {
		t.Fatalf("unexpected rule result=%+v calls=%d", value, calls-before)
	}
	value, err = facade.EnsureRule(context.Background(), "tcp:8080:192.0.2.4")
	if err != nil || value.(map[string]any)["changed"] != false {
		t.Fatalf("not idempotent: %+v %v", value, err)
	}
	if _, err := (&AgentFacade{service: facade.service}).Snapshot(context.Background()); err == nil {
		t.Fatal("missing authorization accepted")
	}
}
