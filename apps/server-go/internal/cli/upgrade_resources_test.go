package cli

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/cli/client"
)

func resourceFixture() client.PanelUpdatePreflight {
	r := client.PanelUpdatePreflight{ID: "preflight-0001", ExpiresAt: time.Now().Add(5 * time.Minute).Format(time.RFC3339), NeedsRelease: true, StopPanelRecommended: true}
	r.Memory.TotalBytes = 2 << 30
	r.Memory.AvailableBytes = 512 << 20
	r.Memory.RequiredBytes = 1536 << 20
	r.Candidates = []client.PanelResourceCandidate{{ID: "container:" + strings.Repeat("a", 64), Kind: "container", Name: "mysql", Recommended: true}, {ID: "service:docker.service", Kind: "service", Name: "docker", DisabledReason: "关键服务"}}
	return r
}
func TestUpgradeYesDoesNotAuthorizeResourceShutdown(t *testing.T) {
	var out bytes.Buffer
	plan, code, err := selectUpgradeResources(resourceFixture(), upgradeOptions{Yes: true}, nil, &out, false)
	if plan != nil || code != 1 || err == nil || !strings.Contains(err.Error(), "--yes 不授权") || !strings.Contains(out.String(), "--stop-panel") {
		t.Fatalf("plan=%+v code=%d err=%v out=%s", plan, code, err, &out)
	}
}
func TestUpgradeResourcesOnlyIncludeExplicitTargetsAndPersist(t *testing.T) {
	var out bytes.Buffer
	id := strings.Repeat("a", 64)
	plan, code, err := selectUpgradeResources(resourceFixture(), upgradeOptions{Yes: true, StopContainers: []string{id}}, nil, &out, false)
	if err != nil || code != 0 || plan.StopPanel || !reflect.DeepEqual(plan.Targets, []string{"container:" + id}) {
		t.Fatalf("plan=%+v code=%d err=%v", plan, code, err)
	}
	store := upgradeStore{path: t.TempDir() + "/upgrade.json"}
	state := upgradeState{Version: 1, BaseURL: "http://127.0.0.1", PanelHome: "/panel", Input: client.PanelUpdateInput{RequestID: "request-0001", ResourcePlan: plan}}
	if err = store.save(state); err != nil {
		t.Fatal(err)
	}
	saved, err := store.read(state.BaseURL, state.PanelHome)
	if err != nil || !reflect.DeepEqual(saved.Input, state.Input) {
		t.Fatalf("saved=%+v err=%v", saved, err)
	}
}
func TestUpgradeResourcesRejectProtectedUnknownAndExpired(t *testing.T) {
	for _, tc := range []struct {
		name    string
		opts    upgradeOptions
		expired bool
	}{
		{"protected", upgradeOptions{StopServices: []string{"docker.service"}}, false},
		{"unknown", upgradeOptions{StopServices: []string{"other.service"}}, false},
		{"expired", upgradeOptions{StopPanel: true}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := resourceFixture()
			if tc.expired {
				r.ExpiresAt = "2000-01-01T00:00:00Z"
			}
			plan, code, err := selectUpgradeResources(r, tc.opts, nil, &bytes.Buffer{}, false)
			if plan != nil || code != 1 || err == nil {
				t.Fatalf("plan=%+v code=%d err=%v", plan, code, err)
			}
		})
	}
}
func TestUpgradeResourceFlagsAreExact(t *testing.T) {
	id := strings.Repeat("a", 64)
	_, opts, _, err := parseCommand([]string{"upgrade", "--stop-container", id, "--stop-service", "caddy.service", "--stop-panel"})
	if err != nil || !opts.StopPanel || !reflect.DeepEqual(opts.StopContainers, []string{id}) || !reflect.DeepEqual(opts.StopServices, []string{"caddy.service"}) {
		t.Fatalf("opts=%+v err=%v", opts, err)
	}
	for _, args := range [][]string{{"upgrade", "--stop-container", "mysql"}, {"upgrade", "--stop-service", "--all"}, {"upgrade", "--stop-service", "docker"}} {
		if _, _, _, err := parseCommand(args); err == nil {
			t.Fatalf("accepted %v", args)
		}
	}
}
