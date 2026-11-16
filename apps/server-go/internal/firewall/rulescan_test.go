package firewall

import (
	"net/http"
	"reflect"
	"sync"
	"testing"
)

func TestRuleScanIndependentPortsAndDualStack(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp", "allow 8443/tcp"}})
	svc := newService(fake)
	first, err := svc.SetRuleScanProtection("ufw-allow-in-tcp-8080-any.ipv4", true)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first.Config.Ports, []float64{8080}) {
		t.Fatalf("首次只启用目标端口，不启用默认列表：%+v", first)
	}
	var wg sync.WaitGroup
	for _, id := range []string{"ufw-allow-in-tcp-8080-any.ipv6", "ufw-allow-in-tcp-8443-any.ipv4"} {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			if _, err := svc.SetRuleScanProtection(id, true); err != nil {
				t.Error(err)
			}
		}(id)
	}
	wg.Wait()
	scan, err := svc.SetRuleScanProtection("ufw-allow-in-tcp-8080-any.ipv6", false)
	if err != nil {
		t.Fatal(err)
	}
	if !scan.Enabled || !reflect.DeepEqual(scan.Config.Ports, []float64{8443}) {
		t.Fatalf("v6 操作同端口，不影响其它端口：%+v", scan)
	}
	for _, path := range []string{defaultFirewallPaths.BeforeRules, defaultFirewallPaths.BeforeRulesV6} {
		text, err := fake.ReadText(path)
		if err != nil || !reflect.DeepEqual(parseScanSection(text).Config.Ports, []float64{8443}) {
			t.Fatalf("双栈文件保持相同端口集合：%s %v", path, err)
		}
	}
	scan, err = svc.SetRuleScanProtection("ufw-allow-in-tcp-8443-any.ipv4", false)
	if err != nil || scan.Enabled || parseScanSection(fake.getBeforeRules()).Enabled {
		t.Fatalf("关闭最后一个端口移除监控段：%+v %v", scan, err)
	}
}

func TestRuleScanRejectsInvalidTargetsWithoutWriting(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 53/udp", "allow out 8080/tcp", "allow 48100/tcp", "allow 60000:60020/tcp", "allow 22/tcp"}})
	svc := newService(fake)
	for _, id := range []string{
		"ufw-allow-in-udp-53-any.ipv4", "ufw-allow-out-tcp-8080-any.ipv4", "ufw-allow-in-tcp-48100-any.ipv4",
		"ufw-allow-in-tcp-60000:60020-any.ipv4", "ufw-allow-in-tcp-9999-any.ipv4",
	} {
		if _, err := svc.SetRuleScanProtection(id, true); err == nil {
			t.Errorf("应拒绝：%s", id)
		}
	}
	if len(fake.fileWritesOf()) != 0 {
		t.Fatal("拒绝应发生在写入前")
	}
}

func TestRuleScanRangeCapacityAndThresholdPreservation(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp", "allow 60000:60013/tcp", "allow 8443/tcp"}})
	svc := newService(fake)
	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}
	config := ScanConfig{Ports: []float64{8080}, WindowSeconds: 120, HitCount: 6, BanSeconds: 7200}
	if _, err := svc.SetScanConfig(config); err != nil {
		t.Fatal(err)
	}
	scan, err := svc.SetRuleScanProtection("ufw-allow-in-tcp-60000:60013-any.ipv4", true)
	if err != nil || len(scan.Config.Ports) != 15 || scan.Config.WindowSeconds != 120 || scan.Config.HitCount != 6 || scan.Config.BanSeconds != 7200 {
		t.Fatalf("保留阈值，端口段整体加入：%+v %v", scan, err)
	}
	before := fake.getBeforeRules()
	if _, err := svc.SetRuleScanProtection("ufw-allow-in-tcp-8443-any.ipv4", true); err == nil {
		t.Fatal("应拒绝超过 15 个端口")
	}
	if fake.getBeforeRules() != before {
		t.Fatal("超过容量不能改变现有配置")
	}
}

func TestRouterRuleScan(t *testing.T) {
	calls := 0
	svc := &fakeService{setRuleScan: func(id string, enabled bool) (FirewallScanProtection, error) {
		calls++
		if id != sampleRule.ID || !enabled {
			t.Fatalf("目标或开关错误：%s %v", id, enabled)
		}
		return scanFixture(enabled), nil
	}}
	app := mountApp(Deps{Available: true, service: svc})
	path := "/rules/" + sampleRule.ID + "/scan"
	code, body := doJSON(t, app, jsonRequest("PUT", path, map[string]any{"enabled": true}))
	if code != http.StatusOK || body["enabled"] != true || calls != 1 {
		t.Fatalf("沿用原防扫描响应：%d %+v", code, body)
	}
	code, _ = doJSON(t, app, jsonRequest("PUT", path, map[string]any{"enabled": "yes"}))
	if code != http.StatusBadRequest || calls != 1 {
		t.Fatal("非法布尔值不能派发")
	}
	req := requestOf("PUT", path, `{"enabled":true}`, map[string]string{"Origin": "https://other.example", "Content-Type": "application/json"})
	code, _ = doJSON(t, app, req)
	if code != http.StatusForbidden || calls != 1 {
		t.Fatal("逐端口写入必须经过同源守卫")
	}
}
