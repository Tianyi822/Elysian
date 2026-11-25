package firewall

import (
	"context"
	"strings"
	"testing"
)

func TestDockerStartupRequiresOnlyOneShotFirewallSync(t *testing.T) {
	if !strings.Contains(dockerWatchUnit, "\nEnvironment=HOME=/var/lib/elysian\n") ||
		strings.Contains(dockerWatchUnit, "RequiredBy=") ||
		!strings.Contains(dockerLegacyUnit, "\nType=oneshot\n") ||
		!strings.Contains(dockerLegacyUnit, "\nEnvironment=HOME=/var/lib/elysian\n") ||
		strings.Contains(dockerLegacyUnit, "docker-firewall-watch") {
		t.Fatal("a Docker startup or rollback could depend on a watchdog without HOME")
	}
	for _, ignore := range []string{"no", "yes"} {
		d := &dockerFirewall{run: func(_ context.Context, _ string, command string, args ...string) (string, error) {
			if command != "systemctl" || strings.Join(args, " ") != "show --property=ExecStartPre --value docker.service" {
				t.Fatalf("unexpected service inspection: %s %v", command, args)
			}
			return "{ path=/usr/bin/env ; argv[]=/usr/bin/env HOME=/var/lib/elysian " +
				dockerFirewallRoot + "/elysian docker-firewall-sync ; ignore_errors=" + ignore + " ; }", nil
		}}
		if err := d.verifyDockerBootHook(t.Context()); (err == nil) != (ignore == "no") {
			t.Fatalf("incorrect readiness when ignore_errors=%s: %v", ignore, err)
		}
	}
}
