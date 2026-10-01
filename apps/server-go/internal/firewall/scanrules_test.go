package firewall

import (
	"strconv"
	"strings"
	"testing"
)

// scanRules.test.ts 的对等测试：规则段文本生成/解析、内核输出解析与配置校验。

const scanBaseRules = `*filter
:ufw-before-input - [0:0]
-A ufw-before-input -i lo -j ACCEPT
-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT
COMMIT`

const iptablesListFixture = `Chain ufw-before-input (1 references)
    pkts      bytes target     prot opt in     out     source               destination
     512    30720 ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0
       3      180 DROP       tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: CHECK seconds: 3600 name: ELYSIAN_SCAN_BANNED
      14      840 DROP       tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: CHECK seconds: 60 hit_count: 8 name: ELYSIAN_SCAN
      20     1200            tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: SET name: ELYSIAN_SCAN`

func TestParseScanSectionDisabled(t *testing.T) {
	state := parseScanSection(scanBaseRules)
	if state.Enabled {
		t.Error("规则段缺失应为停用")
	}
	want := DefaultScanConfig()
	if len(state.Config.Ports) != len(want.Ports) ||
		state.Config.WindowSeconds != want.WindowSeconds || state.Config.HitCount != want.HitCount || state.Config.BanSeconds != want.BanSeconds {
		t.Errorf("停用态配置应回落默认：%+v", state.Config)
	}
}

func TestParseScanSectionRoundTrip(t *testing.T) {
	enabled, err := setScanSection(scanBaseRules, true, ScanConfig{Ports: []float64{22, 8080}, WindowSeconds: 120, HitCount: 5, BanSeconds: 1800}, "v4")
	if err != nil {
		t.Fatal(err)
	}
	state := parseScanSection(enabled)
	if !state.Enabled {
		t.Fatal("写入后应启用")
	}
	want := ScanConfig{Ports: []float64{22, 8080}, WindowSeconds: 120, HitCount: 5, BanSeconds: 1800}
	if len(state.Config.Ports) != 2 || state.Config.Ports[0] != 22 || state.Config.Ports[1] != 8080 ||
		state.Config.WindowSeconds != 120 || state.Config.HitCount != 5 || state.Config.BanSeconds != 1800 {
		t.Errorf("配置往返错误：%+v（want %+v）", state.Config, want)
	}
}

func TestScanSectionV6Names(t *testing.T) {
	v6, err := setScanSection(scanBaseRules, true, DefaultScanConfig(), "v6")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(v6, "-A "+scanTables["v6"].Chain+" ") {
		t.Error("v6 规则段应使用独立链名")
	}
	if !strings.Contains(v6, "--name "+scanTables["v6"].Track+" --set") {
		t.Error("v6 跟踪名单名错误")
	}
	if !strings.Contains(v6, "--name "+scanTables["v6"].Banned+" --rcheck") {
		t.Error("v6 封锁名单名错误")
	}
	if ScanBannedRecentPath == ScanBanned6RecentPath {
		t.Error("v4/v6 封锁名单应指向不同 recent 文件")
	}
}

func TestSetScanSection(t *testing.T) {
	enabled, err := setScanSection(scanBaseRules, true, DefaultScanConfig(), "v4")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"--rcheck --seconds 60 --hitcount 8", "--set -j DROP", "--name ELYSIAN_SCAN --set"} {
		if !strings.Contains(enabled, want) {
			t.Errorf("启用段缺少 %s", want)
		}
	}
	if !strings.HasSuffix(strings.TrimRight(enabled, " \t\n\r"), "COMMIT") {
		t.Error("文件应以 COMMIT 结尾")
	}
	disabled, err := setScanSection(enabled, false, DefaultScanConfig(), "v4")
	if err != nil || disabled != scanBaseRules {
		t.Errorf("停用应回到原文（逐字节）：%v", err)
	}
}

func TestSetScanSectionValidation(t *testing.T) {
	withConfig := func(mutate func(*ScanConfig)) ScanConfig {
		cfg := DefaultScanConfig()
		mutate(&cfg)
		return cfg
	}
	cases := []struct {
		config ScanConfig
		want   string
	}{
		{withConfig(func(c *ScanConfig) { c.WindowSeconds = 5 }), "判定窗口无效"},
		{withConfig(func(c *ScanConfig) { c.HitCount = 1 }), "阈值无效"},
		{withConfig(func(c *ScanConfig) { c.BanSeconds = 10 }), "封禁时长无效"},
		{withConfig(func(c *ScanConfig) { c.Ports = nil }), "监控端口无效"},
		{withConfig(func(c *ScanConfig) {
			c.Ports = make([]float64, 16)
			for i := range c.Ports {
				c.Ports[i] = float64(10000 + i)
			}
		}), "最多 15 个端口"},
		{withConfig(func(c *ScanConfig) { c.Ports = []float64{22, float64(PanelPort)} }), "面板端口不允许加入防扫描监控"},
		{withConfig(func(c *ScanConfig) { c.Ports = []float64{float64(PanelPort)} }), "面板端口不允许加入防扫描监控"},
	}
	for _, tc := range cases {
		if _, err := setScanSection(scanBaseRules, true, tc.config, "v4"); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("应拒 %q，got err=%v", tc.want, err)
		}
	}
	if _, err := setScanSection(scanBaseRules, true, withConfig(func(c *ScanConfig) { c.Ports = []float64{22, 23} }), "v4"); err != nil {
		t.Errorf("不含面板端口的配置不受影响：%v", err)
	}
	if _, err := setScanSection("-A foo\n", true, DefaultScanConfig(), "v4"); err == nil || !strings.Contains(err.Error(), "before.rules 格式无效") {
		t.Errorf("没有 COMMIT 行应报格式无效，got %v", err)
	}
}

func TestSetScanSectionExactlyFifteenPorts(t *testing.T) {
	ports := make([]float64, 15)
	for i := range ports {
		ports[i] = float64(10000 + i)
	}
	cfg := DefaultScanConfig()
	cfg.Ports = ports
	enabled, err := setScanSection(scanBaseRules, true, cfg, "v4")
	if err != nil {
		t.Fatalf("恰好 15 个端口应可生成：%v", err)
	}
	var want strings.Builder
	for i, p := range ports {
		if i > 0 {
			want.WriteString(",")
		}
		want.WriteString(strconv.FormatInt(int64(p), 10))
	}
	if !strings.Contains(enabled, "--dports "+want.String()) {
		t.Errorf("应包含 --dports %s", want.String())
	}
}

func TestScanSectionLinesDefault(t *testing.T) {
	lines, err := scanSectionLines()
	if err != nil {
		t.Fatal(err)
	}
	drops := 0
	for _, line := range lines {
		if strings.Contains(line, "DROP") {
			drops++
		}
	}
	if drops != 2 {
		t.Errorf("v4 双 DROP 三行应有 2 条 DROP，got %d", drops)
	}
}

func TestParseRecentList(t *testing.T) {
	recent := `src=203.0.113.9 ttl: 64 last_seen: 5123456 oldest_pkt: 1 newest_pkt: 5123456
src=198.51.100.7 ttl: 63 last_seen: 5123400 oldest_pkt: 1 newest_pkt: 5123400
`
	got := parseRecentList(recent)
	if len(got) != 2 || got[0] != "203.0.113.9" || got[1] != "198.51.100.7" {
		t.Errorf("recent 名单解析错误：%v", got)
	}
	if got := parseRecentList(""); len(got) != 0 {
		t.Errorf("空文本回空，got %v", got)
	}
}

func TestParseDropCounter(t *testing.T) {
	if got := parseDropCounter(iptablesListFixture); got != 17 {
		t.Errorf("两条 DROP 规则计数求和应为 17，got %d", got)
	}
	if got := parseDropCounter("Chain ufw-before-input\n"); got != 0 {
		t.Errorf("找不到规则时返回 0，got %d", got)
	}
}

func TestValidateUnblockIp(t *testing.T) {
	if got, err := validateUnblockIp(" 203.0.113.9 "); err != nil || got != "203.0.113.9" {
		t.Errorf("合法 IP 放行并 trim，got %q err=%v", got, err)
	}
	if _, err := validateUnblockIp("203.0.113.0/24"); err == nil || !strings.Contains(err.Error(), "IP 无效") {
		t.Errorf("网段应拒，got %v", err)
	}
	if _, err := validateUnblockIp("example"); err == nil || !strings.Contains(err.Error(), "IP 无效") {
		t.Errorf("垃圾输入应拒，got %v", err)
	}
}
