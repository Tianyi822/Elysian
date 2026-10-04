package firewall

import (
	"elysian/server/internal/config"
	"fmt"
	"strings"
	"testing"
)

func TestRuntimeEntryProtection(t *testing.T) {
	for _, mode := range []config.RuntimeMode{config.ModeDocker, config.ModeBareMetal} {
		t.Run(fmt.Sprint(mode), func(t *testing.T) {
			fake := createFakeDeps(fakeUfwDepsSeed{})
			network := config.PanelNetwork{FrontendPort: 49000, BackendPort: 49001}
			s := newServiceForMode(fake, network, mode).(*service)
			entry := 49000
			if mode == config.ModeDocker {
				entry = config.ListenPort
			}
			if _, err := s.SetToggles(FirewallToggles{FirewallEnabled: true, PingBlocked: true}); err != nil {
				t.Fatal(err)
			}
			for _, family := range [][]string{fake.bookV4, fake.bookV6} {
				if !containsStr(family, fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", entry)) {
					t.Fatalf("入口未双栈开放：%v", family)
				}
				if mode == config.ModeBareMetal && containsStr(family, "allow 49001/tcp comment 'Elysian 面板'") {
					t.Fatal("正式后端被开放")
				}
			}
			if _, err := s.SetToggles(FirewallToggles{FirewallEnabled: true, PingBlocked: false}); err != nil {
				t.Fatal(err)
			}
			id := s.panelCanonical + ".ipv4"
			if err := s.Remove(id); err == nil {
				t.Fatal("系统入口可删除")
			}
			if _, err := s.Update(id, allowInputWith(float64(entry))); err == nil {
				t.Fatal("系统入口可修改")
			}
			deny := allowInputWith(float64(entry))
			deny.Policy = "deny"
			if _, err := s.Create(deny); err == nil {
				t.Fatal("系统入口可拒绝")
			}
			for _, port := range []int{network.FrontendPort, network.BackendPort, entry} {
				if _, err := s.CreateForward(ForwardInput{Protocol: "tcp", Port: float64(port), TargetHost: "10.0.0.5", TargetPort: 80}); err == nil {
					t.Fatal("面板端口可配置转发", port)
				}
				if _, err := s.SetScanConfig(ScanConfig{Ports: []float64{float64(port)}, WindowSeconds: 60, HitCount: 8, BanSeconds: 3600}); err == nil {
					t.Fatal("面板端口可配置防扫描", port)
				}
			}
		})
	}
}

func TestEntryRestoresIPv6AndReportsBrokenFamily(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true, Rules: []string{"allow 48101/tcp comment 'Elysian 面板'"}})
	fake.bookV6 = nil
	if err := ensurePanelRule(fake, 48101); err != nil {
		t.Fatal(err)
	}
	if len(fake.bookV6) == 0 {
		t.Fatal("IPv6 半条没有修复")
	}
	fake.bookV6 = nil
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		if args[0] == "allow" {
			return "跳过", nil
		}
		return next()
	}
	if err := ensurePanelRule(fake, 48101); err == nil || !strings.Contains(err.Error(), "IPv6") {
		t.Fatalf("地址族修复失败应明确报错：%v", err)
	}
}

func TestStartupRebuildsMissingKernelChains(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{UfwConf: "ENABLED=yes\n"})
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		if args[0] == "status" && !fake.active {
			return "", fmt.Errorf("ERROR: problem running")
		}
		return next()
	}
	if err := restoreIfNeeded(fake, 48101); err != nil {
		t.Fatal(err)
	}
	if !hasPanelAllowRow(parseStatusRows(func() string { out, _ := fake.RunUfw([]string{"status", "verbose"}); return out }()), 48101) {
		t.Fatal("恢复后入口缺失")
	}
}
