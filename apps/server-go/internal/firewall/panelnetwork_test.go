package firewall

import (
	"context"
	"elysian/server/internal/config"
	"testing"
)

func TestDynamicPanelPortsProtectNewPortsAndReleaseOldDefault(t *testing.T) {
	p := config.PanelNetwork{FrontendPort: 49000, BackendPort: 49001}
	if _, err := specFromForwardInput(ForwardInput{Protocol: "tcp", Port: 49000, TargetHost: "10.0.0.5", TargetPort: 8080}, p.FrontendPort, p.BackendPort); err == nil {
		t.Fatal("新前端端口可被转发")
	}
	if _, err := specFromForwardInput(ForwardInput{Protocol: "tcp", Port: 49001, TargetHost: "10.0.0.5", TargetPort: 8080}, p.FrontendPort, p.BackendPort); err == nil {
		t.Fatal("后端端口可被转发")
	}
	if _, err := specFromForwardInput(ForwardInput{Protocol: "tcp", Port: 48100, TargetHost: "10.0.0.5", TargetPort: 8080}, p.FrontendPort, p.BackendPort); err != nil {
		t.Fatal("旧默认端口仍被保护：", err)
	}
	c := DefaultScanConfig()
	c.Ports = []float64{49000}
	if _, err := validateScanConfig(c, p.FrontendPort, p.BackendPort); err == nil {
		t.Fatal("新前端端口可被监控")
	}
	c.Ports = []float64{48100}
	if _, err := validateScanConfig(c, p.FrontendPort, p.BackendPort); err != nil {
		t.Fatal("旧默认端口仍被禁止：", err)
	}
}

func TestAutomaticPortOpenerRejectsConfiguredBackend(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	opener := portOpenerService{host: fake, backendPort: 49001}
	result := opener.EnsurePortRule(context.Background(), 49001, "网站")
	if result.State != "failed" || len(fake.writeCommandCalls()) != 0 {
		t.Fatalf("后台接缝不应开放后端：%+v", result)
	}
}
