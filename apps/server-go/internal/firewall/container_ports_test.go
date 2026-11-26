package firewall

import (
	"context"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"elysian/server/internal/contract"
)

func TestExistingContainerPolicyRespectsOrderedRules(t *testing.T) {
	for _, tc := range []struct{ rules, want string }{
		{"-p udp --dport 18080 -j DROP", ""},
		{"-p tcp -m multiport --dports 18000:18100,18200 -j ACCEPT", "existing"},
		{"-s 192.0.2.0/24 -p tcp --dport 18080 -j ACCEPT", "skipped"},
		{"-s 192.0.2.0/24 -j DROP\n-A ufw-user-input -p tcp --dport 18080 -j ACCEPT", "skipped"},
		{"-p tcp --dport 18080 -j ACCEPT\n-A ufw-user-input -s 192.0.2.0/24 -j DROP", "existing"},
		{"-p tcp --dport 18080 -j ufw-user-limit", "skipped"},
	} {
		raw := ":ufw-user-input - [0:0]\n-A ufw-user-input " + tc.rules + "\nCOMMIT"
		rules, err := projectDockerInput(raw, "", false)
		if err != nil {
			t.Fatal(err)
		}
		if got := existingContainerPolicy(rules, 18080, "tcp"); got != tc.want {
			t.Errorf("%q: got %q, want %q", tc.rules, got, tc.want)
		}
	}
}

type containerRuleHost struct {
	fakeUfwDeps
	raw    string
	writes int
}

func (h *containerRuleHost) ReadText(path string) (string, error) {
	if path == dockerAllowUserRules {
		return h.raw, nil
	}
	return h.fakeUfwDeps.ReadText(path)
}

func (h *containerRuleHost) RunUfw(args []string) (string, error) {
	h.writes++
	switch args[0] {
	case "allow":
		comment := args[len(args)-1]
		h.raw = fmt.Sprintf(":ufw-user-input - [0:0]\n### tuple ### allow tcp 18080 0.0.0.0/0 any 0.0.0.0/0 in comment=%s\n-A ufw-user-input -p tcp --dport 18080 -j ACCEPT\nCOMMIT",
			hex.EncodeToString([]byte(comment)))
	case "delete":
		h.raw = ":ufw-user-input - [0:0]\nCOMMIT"
	default:
		return "", fmt.Errorf("unexpected UFW command %v", args)
	}
	return "", nil
}

func TestContainerFirewallOwnershipLifecycle(t *testing.T) {
	for _, mode := range []string{"exclusive", "shared", "edited"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			old, next := strings.Repeat("a", 64), strings.Repeat("b", 64)
			binding := contract.DockerPublishedPort{ContainerID: old, HostIP: "0.0.0.0", HostPort: 18080,
				ContainerPort: 80, Protocol: "tcp"}
			ids := map[string]bool{old: true}
			var others []contract.DockerPublishedPort
			host := &containerRuleHost{raw: ":ufw-user-input - [0:0]\nCOMMIT"}
			p := &containerFirewall{host: host, path: filepath.Join(t.TempDir(), "ownership.json"),
				published: func(context.Context) ([]contract.DockerPublishedPort, error) {
					return []contract.DockerPublishedPort{binding}, nil
				},
				inventory: func(context.Context, bool) (map[string]bool, []contract.DockerPublishedPort, error) {
					return ids, others, nil
				}}
			if state, detail := p.Allow(ctx, binding); state != "added" {
				t.Fatalf("allow: %s %s", state, detail)
			}
			if state, detail := p.Allow(ctx, binding); state != "existing" {
				t.Fatalf("reuse: %s %s", state, detail)
			}
			if err := p.Reconcile(ctx); err != nil || host.writes != 1 {
				t.Fatalf("stopped container rule: %d writes, %v", host.writes, err)
			}
			binding.ContainerID = next
			if err := p.Transfer(old, next, []contract.DockerPublishedPort{binding}); err != nil {
				t.Fatal(err)
			}
			ids = map[string]bool{next: true}
			if err := p.Reconcile(ctx); err != nil || host.writes != 1 {
				t.Fatalf("transferred rule: %d writes, %v", host.writes, err)
			}
			delete(ids, next)
			if mode == "shared" {
				ids[old] = true
				binding.ContainerID, binding.HostIP = old, ""
				others = []contract.DockerPublishedPort{binding}
			} else if mode == "edited" {
				host.raw = strings.Replace(host.raw, "comment=", "comment=6d616e75616c", 1)
			}
			if err := p.Reconcile(ctx); err != nil {
				t.Fatal(err)
			}
			wantWrites := 1
			if mode == "exclusive" {
				wantWrites = 2
			}
			if rows, err := p.load(); err != nil || len(rows) != 0 || host.writes != wantWrites {
				t.Fatalf("got %d rows and %d writes: %v", len(rows), host.writes, err)
			}
		})
	}
}
