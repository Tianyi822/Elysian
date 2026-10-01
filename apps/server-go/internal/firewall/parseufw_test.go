package firewall

import (
	"math"
	"strings"
	"testing"
)

// parseUfw.test.ts 的对等测试：夹具全部取自 TS 版（容器内 ufw 0.36.2 真实输出）。

const showAddedFixture = `Added user rules (see 'ufw status' for running firewall):
ufw allow 22/tcp
ufw allow 80/tcp comment 'Web server'
ufw allow 60123/tcp comment '测试备注 note'
ufw allow out 25/udp
ufw deny 23/tcp
ufw limit 2222/tcp
ufw allow from 192.168.1.0/24 to any port 2049 proto tcp
ufw deny from 203.0.113.9
ufw allow from 2001:db8::/32
ufw deny to 10.0.0.5`

func emptyRowContext() ruleRowContext {
	return ruleRowContext{
		Ipv6Enabled: true,
		Listeners:   map[string]bool{"tcp:80": true},
		TimeOf:      func(string) *string { return nil },
	}
}

func strp(s string) *string { return &s }

func specEq(t *testing.T, label string, got ufwRuleSpec, want ufwRuleSpec) {
	t.Helper()
	if got != want {
		t.Errorf("%s：spec = %+v，want %+v", label, got, want)
	}
}

func TestParseShowAdded(t *testing.T) {
	lines := parseShowAdded(showAddedFixture)
	portCount, ipCount := 0, 0
	for _, line := range lines {
		switch line.Kind {
		case "port":
			portCount++
		case "ip":
			ipCount++
		}
	}
	if len(lines) != 9 || portCount != 7 || ipCount != 2 {
		t.Fatalf("应为 7 端口 + 2 IP（deny to 无界面对应物），got %d 行（port=%d ip=%d）", len(lines), portCount, ipCount)
	}

	var ports []parsedUfwLine
	var ips []parsedUfwLine
	for _, line := range lines {
		if line.Kind == "port" {
			ports = append(ports, line)
		} else {
			ips = append(ips, line)
		}
	}

	specEq(t, "第 1 条", ports[0].Spec, ufwRuleSpec{Action: "allow", Direction: "in", Port: "22", Proto: "tcp", From: "any"})
	if ports[1].Comment == nil || *ports[1].Comment != "Web server" {
		t.Errorf("第 2 条 comment = %v", ports[1].Comment)
	}
	if ports[3].Spec.Direction != "out" || ports[3].Spec.Port != "25" || ports[3].Spec.Proto != "udp" {
		t.Errorf("出站规则解析错误：%+v", ports[3].Spec)
	}
	if ports[4].Spec.Action != "deny" || ports[5].Spec.Action != "limit" {
		t.Errorf("deny/limit 解析错误")
	}
	specEq(t, "from 网段 + port + proto", ports[6].Spec, ufwRuleSpec{Action: "allow", Direction: "in", Port: "2049", Proto: "tcp", From: "192.168.1.0/24"})

	if ips[0].IpSpec != (ufwIpSpec{Action: "deny", Direction: "in", From: "203.0.113.9"}) {
		t.Errorf("纯 from 规则解析错误：%+v", ips[0].IpSpec)
	}
	if ips[1].IpSpec != (ufwIpSpec{Action: "allow", Direction: "in", From: "2001:db8::/32"}) {
		t.Errorf("v6 网段规则解析错误：%+v", ips[1].IpSpec)
	}
}

func TestParseShowAddedEmpty(t *testing.T) {
	if got := parseShowAdded("Added user rules (see 'ufw status' for running firewall):\n(None)"); len(got) != 0 {
		t.Errorf("(None) 不应产生规则，got %d", len(got))
	}
}

func TestParseStatusVerbose(t *testing.T) {
	status, err := parseStatusVerbose("Status: active\nLogging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)\n")
	if err != nil {
		t.Fatal(err)
	}
	if !status.Active || *status.DefaultIncoming != "deny" || *status.DefaultOutgoing != "allow" {
		t.Errorf("激活态与默认策略解析错误：%+v", status)
	}

	inactive, err := parseStatusVerbose("Status: inactive\n")
	if err != nil {
		t.Fatal(err)
	}
	if inactive.Active || inactive.DefaultIncoming != nil || inactive.DefaultOutgoing != nil {
		t.Errorf("未激活时默认策略应为 null，got %+v", inactive)
	}

	for _, bad := range []string{"Default: deny (incoming), allow (outgoing)\n", ""} {
		if _, err := parseStatusVerbose(bad); err == nil || !strings.Contains(err.Error(), "缺少 Status 行") {
			t.Errorf("缺少 Status 行才是输出无效，got err=%v", err)
		}
	}
}

func TestParseIpv6Enabled(t *testing.T) {
	if !parseIpv6Enabled("IPV6=yes\nIPV6_DENY=no\n") {
		t.Error("IPV6=yes 应启用")
	}
	if parseIpv6Enabled("IPV6=no\n") {
		t.Error("IPV6=no 应停用")
	}
	if !parseIpv6Enabled("") {
		t.Error("缺省视为启用")
	}
}

func allowInput(port float64) RuleInput {
	return RuleInput{Protocol: "tcp", Port: port, Family: "ipv4", Policy: "allow", Direction: "inbound", Source: SourceAllIPs, Note: nil}
}

func TestSpecFromInputAndSpecToArgsRoundTrip(t *testing.T) {
	spec, err := specFromInput(allowInput(8080))
	if err != nil {
		t.Fatal(err)
	}
	if args := specToArgs(spec); strings.Join(args, " ") != "allow 8080/tcp" {
		t.Errorf("所有IP入站应映射短形式，got %v", args)
	}

	portTo := float64(2000)
	spec, err = specFromInput(RuleInput{Protocol: "tcp", Port: 1000, PortTo: &portTo, Family: "ipv4", Policy: "allow", Direction: "inbound", Source: SourceAllIPs, Note: nil})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Port != "1000:2000" {
		t.Errorf("端口段应保留冒号，got %q", spec.Port)
	}
	if args := specToArgs(spec); strings.Join(args, " ") != "allow 1000:2000/tcp" {
		t.Errorf("端口段参数错误，got %v", args)
	}
}

func TestSpecFromInputFullForm(t *testing.T) {
	spec, err := specFromInput(RuleInput{Protocol: "udp", Port: 53, Family: "ipv6", Policy: "limit", Direction: "outbound", Source: "fd00::/8", Note: nil})
	if err != nil {
		t.Fatal(err)
	}
	want := "limit out from fd00::/8 to any port 53 proto udp"
	if got := strings.Join(specToArgs(spec), " "); got != want {
		t.Errorf("出站 + 来源完整形式错误：\ngot  %s\nwant %s", got, want)
	}
}

func TestSpecFromInputRejections(t *testing.T) {
	cases := []struct {
		input RuleInput
		want  string
	}{
		{allowInput(0), "端口无效"},
		{allowInput(70000), "端口无效"},
		{func() RuleInput {
			in := allowInput(2000)
			portTo := float64(1000)
			in.PortTo = &portTo
			return in
		}(), "端口段无效"},
		{func() RuleInput { in := allowInput(80); in.Source = "example.com"; return in }(), "来源无效"},
		{func() RuleInput { in := allowInput(80); in.Source = "evil'; rm -rf /"; return in }(), "来源无效"},
		{func() RuleInput { in := allowInput(80); in.Note = strp("it's"); return in }(), "备注不能包含单引号"},
		{func() RuleInput { in := allowInput(80); in.Note = strp("第一行\n第二行"); return in }(), "备注不能包含换行"},
		{func() RuleInput { in := allowInput(80); in.Note = strp("第一行\r第二行"); return in }(), "备注不能包含换行"},
		{func() RuleInput { in := allowInput(80); in.Protocol = "sctp"; return in }(), "协议无效"},
		{func() RuleInput { in := allowInput(80); in.Policy = "reject"; return in }(), "策略无效"},
	}
	for _, tc := range cases {
		_, err := specFromInput(tc.input)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("应拒 %q，got err=%v", tc.want, err)
		}
	}
	// 端口为 NaN（路由宽进的垃圾输入透传）按 400 拒，消息按 JS String(NaN) 格式化。
	_, err := specFromInput(RuleInput{Protocol: "tcp", Port: math.NaN(), Family: "ipv4", Policy: "allow", Direction: "inbound", Source: SourceAllIPs})
	if err == nil || err.Error() != "端口无效：NaN（应为 1–65535 的整数）" {
		t.Errorf("NaN 端口错误消息错误：got %v", err)
	}

	ok, err := specFromInput(func() RuleInput { in := allowInput(80); in.Note = strp("Web 服务器"); return in }())
	if err != nil || ok.Port != "80" || ok.From != "any" {
		t.Errorf("正常备注不应受影响：%v %v", ok, err)
	}
}

func TestIpSpecFromInput(t *testing.T) {
	spec, err := ipSpecFromInput(IpRuleInput{Policy: "deny", Source: "203.0.113.0/24", Note: nil})
	if err != nil {
		t.Fatal(err)
	}
	if spec != (ufwIpSpec{Action: "deny", Direction: "in", From: "203.0.113.0/24"}) {
		t.Errorf("合法来源映射错误：%+v", spec)
	}

	cases := []struct {
		input IpRuleInput
		want  string
	}{
		{IpRuleInput{Policy: "deny", Source: SourceAllIPs}, "来源无效"},
		{IpRuleInput{Policy: "deny", Source: "example.com"}, "来源无效"},
		{IpRuleInput{Policy: "weird", Source: "1.2.3.4"}, "策略无效"},
		{IpRuleInput{Policy: "deny", Source: "203.0.113.9", Note: strp("it's")}, "备注不能包含单引号"},
		{IpRuleInput{Policy: "deny", Source: "203.0.113.9", Note: strp("第一行\n第二行")}, "备注不能包含换行"},
		{IpRuleInput{Policy: "deny", Source: "203.0.113.9", Note: strp("第一行\r第二行")}, "备注不能包含换行"},
	}
	for _, tc := range cases {
		if _, err := ipSpecFromInput(tc.input); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("应拒 %q，got err=%v", tc.want, err)
		}
	}
	if _, err := ipSpecFromInput(IpRuleInput{Policy: "deny", Source: "203.0.113.9", Note: strp("扫描源")}); err != nil {
		t.Errorf("正常备注不应受影响：%v", err)
	}
}

func TestIsValidFirewallAddress(t *testing.T) {
	valid := []string{"192.168.1.1", "10.0.0.0/8", "fd00::1", "2001:db8::/32"}
	invalid := []string{"999.1.1.1", "10.0.0.0/40", "所有IP"}
	for _, v := range valid {
		if !isValidFirewallAddress(v) {
			t.Errorf("%s 应接受", v)
		}
	}
	for _, v := range invalid {
		if isValidFirewallAddress(v) {
			t.Errorf("%s 应拒绝", v)
		}
	}
}

func TestRuleRowsFromSpec(t *testing.T) {
	spec, err := specFromInput(func() RuleInput { in := allowInput(80); in.Note = strp("Web"); return in }())
	if err != nil {
		t.Fatal(err)
	}
	rows := ruleRowsFromSpec(spec, strp("Web"), emptyRowContext())
	if len(rows) != 2 || rows[0].Family != "ipv4" || rows[1].Family != "ipv6" {
		t.Fatalf("any 来源在 IPv6 启用时应派生 v4/v6 两行，got %d", len(rows))
	}
	first := rows[0]
	if first.Protocol != "tcp" || first.Port != 80 || first.PortTo != nil || first.Status != "normal" ||
		first.Policy != "allow" || first.Direction != "inbound" || first.Source != SourceAllIPs ||
		first.Note == nil || *first.Note != "Web" || first.UpdatedAt != nil {
		t.Errorf("行内容错误：%+v", first)
	}
	if !strings.HasSuffix(first.ID, ".ipv4") || !strings.HasSuffix(rows[1].ID, ".ipv6") {
		t.Errorf("id 后缀错误：%s / %s", first.ID, rows[1].ID)
	}

	portTo := float64(2000)
	rangeSpec, _ := specFromInput(RuleInput{Protocol: "tcp", Port: 1000, PortTo: &portTo, Family: "ipv4", Policy: "allow", Direction: "inbound", Source: SourceAllIPs, Note: strp("被动模式")})
	rangeRows := ruleRowsFromSpec(rangeSpec, strp("被动模式"), emptyRowContext())
	if rangeRows[0].Port != 1000 || *rangeRows[0].PortTo != 2000 || *rangeRows[0].Note != "端口段 1000:2000；被动模式" {
		t.Errorf("端口段行内容错误：%+v", rangeRows[0])
	}
	if got := portToOf(rangeSpec); got == nil || *got != 2000 {
		t.Errorf("portToOf = %v", got)
	}
	if displayPortOf(rangeSpec) != 1000 {
		t.Errorf("displayPortOf = %v", displayPortOf(rangeSpec))
	}
}

func TestRuleRowsFromSpecLimitAndLedger(t *testing.T) {
	spec, _ := specFromInput(func() RuleInput { in := allowInput(22); in.Policy = "limit"; return in }())
	at := "2026-09-19T00:00:00.000Z"
	ctx := ruleRowContext{Ipv6Enabled: true, Listeners: map[string]bool{}, TimeOf: func(canonical string) *string {
		if canonical == canonicalId(spec) {
			return &at
		}
		return nil
	}}
	rows := ruleRowsFromSpec(spec, nil, ctx)
	if rows[0].Policy != "limit" || rows[0].Status != "unused" || rows[0].UpdatedAt == nil || *rows[0].UpdatedAt != at {
		t.Errorf("limit 行为与账本时间错误：%+v", rows[0])
	}
}

func TestRuleRowsFromSpecFamilyBySource(t *testing.T) {
	spec := ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: "2049", From: "192.168.1.0/24"}
	rows := ruleRowsFromSpec(spec, nil, emptyRowContext())
	if len(rows) != 1 || rows[0].Family != "ipv4" || rows[0].Source != "192.168.1.0/24" {
		t.Errorf("来源网段决定单地址族行：%+v", rows)
	}
}

func TestIpRuleRows(t *testing.T) {
	spec := ufwIpSpec{Action: "deny", Direction: "in", From: "203.0.113.9"}
	row := ipRuleRowFromSpec(spec, strp("恶意扫描"), emptyRowContext())
	if row.Source != "203.0.113.9" || row.Family != "ipv4" || row.Policy != "deny" ||
		row.Note == nil || *row.Note != "恶意扫描" || row.UpdatedAt != nil {
		t.Errorf("IP 规则行内容错误：%+v", row)
	}
	if row.ID != ipRuleIdOf(spec) || row.ID != ipCanonicalId(spec)+".ipv4" {
		t.Errorf("id 与 canonical 指纹不对应：%s", row.ID)
	}
	if v6 := ipRuleRowFromSpec(ufwIpSpec{Action: "allow", Direction: "in", From: "fd00::/8"}, nil, emptyRowContext()); v6.Family != "ipv6" {
		t.Errorf("v6 来源应归 ipv6：%+v", v6)
	}
}

func TestParseRuleIdRoundTrip(t *testing.T) {
	spec := ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: "2049", From: "192.168.1.0/24"}
	parsed := parseRuleId(canonicalId(spec) + ".ipv6")
	if parsed == nil {
		t.Fatal("应能还原")
	}
	if parsed.Spec != spec || parsed.Family != "ipv6" {
		t.Errorf("还原错误：%+v %+v", parsed.Spec, parsed.Family)
	}

	ipParsed := parseIpRuleId(ipCanonicalId(ufwIpSpec{Action: "deny", Direction: "in", From: "203.0.113.9"}) + ".ipv4")
	if ipParsed == nil || ipParsed.Spec != (ufwIpSpec{Action: "deny", Direction: "in", From: "203.0.113.9"}) || ipParsed.Family != "ipv4" {
		t.Errorf("IP 规则 id 还原错误：%+v", ipParsed)
	}

	for _, bad := range []string{"fw-80-ipv4", "ufw-allow-tcp-22-any"} {
		if parseRuleId(bad) != nil {
			t.Errorf("%s 不应被认识", bad)
		}
	}
	if parseIpRuleId("fwip-x") != nil {
		t.Error("fwip-x 不应被认识")
	}
}

func TestParseStatusRows(t *testing.T) {
	stdout := strings.Join([]string{
		"Status: active",
		"Logging: on (low)",
		"Default: deny (incoming), allow (outgoing), deny (routed)",
		"New profiles: skip",
		"",
		"To                         Action      From",
		"--                         ------      ----",
		"22/tcp                     ALLOW IN    Anywhere                   # ssh",
		"48100/tcp                  ALLOW IN    Anywhere                   # Elysian 面板",
		"22/tcp (v6)                ALLOW IN    Anywhere (v6)              # ssh",
		"48100/tcp (v6)             ALLOW IN    Anywhere (v6)              # Elysian 面板",
	}, "\n")
	rows := parseStatusRows(stdout)
	want := []ufwStatusRow{
		{To: "22/tcp", Action: "allow", Direction: "in", From: "Anywhere", V6: false},
		{To: "48100/tcp", Action: "allow", Direction: "in", From: "Anywhere", V6: false},
		{To: "22/tcp", Action: "allow", Direction: "in", From: "Anywhere", V6: true},
		{To: "48100/tcp", Action: "allow", Direction: "in", From: "Anywhere", V6: true},
	}
	if len(rows) != len(want) {
		t.Fatalf("行数 = %d，want %d", len(rows), len(want))
	}
	for i := range want {
		if rows[i] != want[i] {
			t.Errorf("第 %d 行 = %+v，want %+v", i, rows[i], want[i])
		}
	}

	// 事故形态：只剩 (v6) 行时能看出 IPv4 放行缺失。
	accident := strings.Join([]string{
		"Status: active",
		"Logging: on (low)",
		"Default: deny (incoming), allow (outgoing), deny (routed)",
		"New profiles: skip",
		"",
		"To                         Action      From",
		"--                         ------      ----",
		"22/tcp (v6)                ALLOW IN    Anywhere (v6)              # ssh",
		"48100/tcp (v6)             ALLOW IN    Anywhere (v6)              # Elysian 面板",
	}, "\n")
	accidentRows := parseStatusRows(accident)
	if len(accidentRows) != 2 {
		t.Fatalf("事故形态行数 = %d", len(accidentRows))
	}
	for _, row := range accidentRows {
		if !row.V6 {
			t.Error("事故形态只应有 v6 行")
		}
	}

	if got := parseStatusRows("Status: inactive\n"); len(got) != 0 {
		t.Errorf("未激活输出应返回空表，got %d", len(got))
	}

	// 非 verbose 形态（动作列无方向）同样解析，读不懂的行跳过。
	plain := strings.Join([]string{
		"Status: active",
		"",
		"To                         Action      From",
		"--                         ------      ----",
		"22/tcp                     ALLOW       Anywhere",
		"23/tcp                     DENY        Anywhere",
		"Anywhere                   ALLOW FWD   192.168.1.5",
		"垃圾桶行不解析",
	}, "\n")
	plainRows := parseStatusRows(plain)
	if len(plainRows) != 2 || plainRows[0].To != "22/tcp" || plainRows[1].To != "23/tcp" || plainRows[0].Direction != "in" {
		t.Errorf("非 verbose 形态解析错误：%+v", plainRows)
	}
}
