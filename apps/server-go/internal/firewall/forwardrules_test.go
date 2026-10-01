package firewall

import (
	"strings"
	"testing"
)

// forwardRules.test.ts 的对等测试：段写入/解析往返、comment 标记、nat 参数与冲突判定。

const baseRulesFixture = `*filter
:ufw-before-input - [0:0]
-A ufw-before-input -i lo -j ACCEPT
COMMIT`

func TestParseAndSetForwardSection(t *testing.T) {
	if got := parseForwardSection(baseRulesFixture); len(got) != 0 {
		t.Fatalf("无段应返回空，got %d", len(got))
	}

	spec := ForwardSpec{Protocol: "tcp", Port: "8080", TargetHost: "10.0.0.5", TargetPort: 80, Note: strp("博客上游")}
	next := setForwardSection(baseRulesFixture, []ForwardSpec{spec})
	parsed := parseForwardSection(next)
	if len(parsed) != 1 || parsed[0].Protocol != spec.Protocol || parsed[0].Port != spec.Port ||
		parsed[0].TargetHost != spec.TargetHost || parsed[0].TargetPort != spec.TargetPort ||
		parsed[0].Note == nil || *parsed[0].Note != *spec.Note {
		t.Fatalf("写入后应解析回规范：%+v", parsed)
	}
	if !strings.HasPrefix(next, "### ELYSIAN 端口转发") {
		t.Error("nat 段应在文件最前")
	}
	if !strings.Contains(next, "-A ufw-before-input -i lo -j ACCEPT") {
		t.Error("filter 表原内容不动")
	}
	if !strings.Contains(next, "*nat") {
		t.Error("应包含 *nat")
	}
	// comment 用双引号：iptables-restore 只认双引号。
	wantLine := `-A PREROUTING -p tcp --dport 8080 -m comment --comment "` + ForwardCommentPrefix + ` 博客上游" -j DNAT --to-destination 10.0.0.5:80`
	if !strings.Contains(next, wantLine) {
		t.Errorf("DNAT 行错误，缺 %s", wantLine)
	}
}

func TestForwardSectionRoundTripNotes(t *testing.T) {
	// 单引号可存活（双引号才是保留字符，单引号被拒在输入校验）。
	spec := ForwardSpec{Protocol: "tcp", Port: "8080", TargetHost: "10.0.0.5", TargetPort: 80, Note: strp("运维's 转发")}
	if parsed := parseForwardSection(setForwardSection(baseRulesFixture, []ForwardSpec{spec})); len(parsed) != 1 || *parsed[0].Note != *spec.Note {
		t.Errorf("单引号备注应无损往返：%+v", parsed)
	}
	// 中文/空格备注往返无损。
	cn := ForwardSpec{Protocol: "udp", Port: "53", TargetHost: "10.0.0.53", TargetPort: 53, Note: strp("内网 DNS · 解析")}
	if parsed := parseForwardSection(setForwardSection(baseRulesFixture, []ForwardSpec{cn})); len(parsed) != 1 || *parsed[0].Note != *cn.Note {
		t.Errorf("中文备注应无损往返：%+v", parsed)
	}
}

func TestForwardSectionMultiAndClear(t *testing.T) {
	specs := []ForwardSpec{
		{Protocol: "tcp", Port: "8080", TargetHost: "10.0.0.5", TargetPort: 80, Note: nil},
		{Protocol: "tcp", Port: "1000:2000", TargetHost: "10.0.0.9", TargetPort: 3000, Note: nil},
	}
	next := setForwardSection(baseRulesFixture, specs)
	if parsed := parseForwardSection(next); len(parsed) != 2 || parsed[0] != specs[0] || parsed[1] != specs[1] {
		t.Fatalf("多条规范一次写入后解析错误：%+v", parsed)
	}
	if cleared := setForwardSection(next, nil); cleared != baseRulesFixture {
		t.Errorf("清空应回到原文：\ngot  %q\nwant %q", cleared, baseRulesFixture)
	}
}

func TestForwardSectionIdempotent(t *testing.T) {
	spec := ForwardSpec{Protocol: "tcp", Port: "8080", TargetHost: "10.0.0.5", TargetPort: 80, Note: nil}
	once := setForwardSection(baseRulesFixture, []ForwardSpec{spec})
	if again := setForwardSection(once, []ForwardSpec{spec}); again != once {
		t.Error("重复应用幂等：同一集合写两次内容应逐字节一致")
	}
}

func TestForwardCommentMarker(t *testing.T) {
	if got := noteFromForwardComment(forwardCommentOf(strp("博客"))); got == nil || *got != "博客" {
		t.Errorf("带标记的 comment 应还原备注，got %v", got)
	}
	if got := noteFromForwardComment(forwardCommentOf(nil)); got != nil {
		t.Errorf("无备注标记应还原 null，got %v", got)
	}
	if got := noteFromForwardComment("别人的规则"); got != nil {
		t.Errorf("无标记返回 null，got %v", got)
	}
	long := strings.Repeat("x", 400)
	if got := forwardCommentOf(&long); len([]rune(got)) > 200 {
		t.Errorf("超长备注应截断，got %d 码位", len([]rune(got)))
	}
}

func TestNatRuleArgsOf(t *testing.T) {
	args := natRuleArgsOf(ForwardSpec{Protocol: "tcp", Port: "8080", TargetHost: "10.0.0.5", TargetPort: 80, Note: strp("博客")})
	want := []string{"-p", "tcp", "--dport", "8080", "-m", "comment", "--comment", ForwardCommentPrefix + " 博客", "-j", "DNAT", "--to-destination", "10.0.0.5:80"}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Errorf("nat 参数错误：\ngot  %v\nwant %v", args, want)
	}
}

func TestParseOurNatRuleNumbers(t *testing.T) {
	listing := strings.Join([]string{
		"Chain PREROUTING (policy ACCEPT)",
		"num  target     prot opt source               destination",
		"1    DNAT       tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:8080 to:10.0.0.5:80",
		"2    DNAT       tcp  --  0.0.0.0/0            0.0.0.0/0            tcp dpt:9090 /* ELYSIAN-FWD 新转发 */ to:10.0.0.20:80",
		"3    MASQUERADE  all  --  172.17.0.0/16        0.0.0.0/0",
		"4    DNAT       udp  --  0.0.0.0/0            0.0.0.0/0            udp dpt:53 /* ELYSIAN-FWD */ to:10.0.0.53:53",
	}, "\n")
	got := parseOurNatRuleNumbers(listing)
	if len(got) != 2 || got[0] != 2 || got[1] != 4 {
		t.Errorf("应挑出本面板规则行号 [2 4]，got %v", got)
	}
	if got := parseOurNatRuleNumbers("Chain PREROUTING (policy ACCEPT)\n"); len(got) != 0 {
		t.Errorf("没有本面板规则应回空，got %v", got)
	}
}

func TestForwardIdRoundTrip(t *testing.T) {
	spec := ForwardSpec{Protocol: "tcp", Port: "1000:2000", TargetHost: "10.0.0.5", TargetPort: 80, Note: strp("x")}
	parsed := parseForwardId(forwardIdOf(spec))
	if parsed == nil {
		t.Fatal("id 应能还原")
	}
	if parsed.Protocol != "tcp" || parsed.Port != "1000:2000" || parsed.TargetHost != "10.0.0.5" || parsed.TargetPort != 80 {
		t.Errorf("id 还原错误：%+v", parsed)
	}
	if parseForwardId("not-a-forward-id") != nil {
		t.Error("不认识的 id 应返回 null")
	}
}

func baseForwardInput() ForwardInput {
	return ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80, Note: nil}
}

func TestSpecFromForwardInput(t *testing.T) {
	spec, err := specFromForwardInput(baseForwardInput())
	if err != nil || spec.Port != "8080" {
		t.Fatalf("单端口映射错误：%v %v", spec, err)
	}
	portTo := float64(2000)
	spec, err = specFromForwardInput(func() ForwardInput { in := baseForwardInput(); in.Port = 1000; in.PortTo = &portTo; return in }())
	if err != nil || spec.Port != "1000:2000" {
		t.Fatalf("端口段映射错误：%v %v", spec, err)
	}
}

func TestSpecFromForwardInputRejections(t *testing.T) {
	mustReject := func(label string, mutate func(*ForwardInput), want string) {
		t.Helper()
		input := baseForwardInput()
		mutate(&input)
		_, err := specFromForwardInput(input)
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s：应拒 %q，got err=%v", label, want, err)
		}
	}
	mustReject("v6 目标", func(in *ForwardInput) { in.TargetHost = "fd00::1" }, "目标地址无效")
	mustReject("域名目标", func(in *ForwardInput) { in.TargetHost = "example.com" }, "目标地址无效")
	mustReject("CIDR 目标", func(in *ForwardInput) { in.TargetHost = "10.0.0.0/24" }, "目标地址无效")
	mustReject("/32 目标", func(in *ForwardInput) { in.TargetHost = "10.0.0.5/32" }, "目标地址无效")
	mustReject("零端口", func(in *ForwardInput) { in.Port = 0 }, "外部端口无效")
	mustReject("倒置段", func(in *ForwardInput) {
		in.Port = 2000
		portTo := float64(1000)
		in.PortTo = &portTo
	}, "端口段无效")
	mustReject("目标端口越界", func(in *ForwardInput) { in.TargetPort = 70000 }, "目标端口无效")
	mustReject("双引号备注", func(in *ForwardInput) { in.Note = strp(`外层"引号`) }, "备注不能包含双引号")
	mustReject("换行备注", func(in *ForwardInput) { in.Note = strp("第一行\n第二行") }, "备注不能包含换行")
	mustReject("回车备注", func(in *ForwardInput) { in.Note = strp("第一行\r第二行") }, "备注不能包含换行")
	mustReject("面板端口单端口", func(in *ForwardInput) { in.Port = float64(PanelPort) }, "面板端口不允许配置转发")
	mustReject("面板端口覆盖区间", func(in *ForwardInput) {
		in.Port = 1000
		portTo := float64(PanelPort + 1)
		in.PortTo = &portTo
	}, "面板端口不允许配置转发")
	mustReject("区间右端点", func(in *ForwardInput) {
		in.Port = 1
		portTo := float64(PanelPort)
		in.PortTo = &portTo
	}, "面板端口不允许配置转发")
	mustReject("跨协议覆盖", func(in *ForwardInput) {
		in.Protocol = "udp"
		in.Port = 1000
		portTo := float64(PanelPort)
		in.PortTo = &portTo
	}, "面板端口不允许配置转发")

	// 不覆盖面板端口的边界值放行；正常备注不受影响。
	edgeLow := func() ForwardInput {
		in := baseForwardInput()
		in.Port = 5000
		portTo := float64(PanelPort - 1)
		in.PortTo = &portTo
		return in
	}()
	if spec, err := specFromForwardInput(edgeLow); err != nil || spec.Port != "5000:48099" {
		t.Errorf("不覆盖区间的下边界应放行：%v %v", spec, err)
	}
	edgeHigh := func() ForwardInput {
		in := baseForwardInput()
		in.Port = PanelPort + 1
		portTo := float64(PanelPort + 2)
		in.PortTo = &portTo
		return in
	}()
	if spec, err := specFromForwardInput(edgeHigh); err != nil || spec.Port != "48101:48102" {
		t.Errorf("不覆盖区间的上边界应放行：%v %v", spec, err)
	}
	ok := baseForwardInput()
	ok.Note = strp("博客上游 8080")
	if spec, err := specFromForwardInput(ok); err != nil || *spec.Note != "博客上游 8080" {
		t.Errorf("正常备注不受影响：%v %v", spec, err)
	}
}

func TestForwardRowFromSpec(t *testing.T) {
	at := "2026-09-19T08:00:00.000Z"
	row := forwardRowFromSpec(ForwardSpec{Protocol: "tcp", Port: "1000:2000", TargetHost: "10.0.0.5", TargetPort: 80, Note: nil}, &at)
	if row.Port != 1000 || *row.PortTo != 2000 || row.TargetHost != "10.0.0.5" || row.TargetPort != 80 || *row.UpdatedAt != at {
		t.Errorf("端口段展开错误：%+v", row)
	}
}

func TestForwardPortsOverlap(t *testing.T) {
	spec := func(port string) ForwardSpec {
		return ForwardSpec{Protocol: "tcp", Port: port, TargetHost: "10.0.0.5", TargetPort: 80}
	}
	overlaps := [][2]string{
		{"1000:2000", "1500"},
		{"1000:2000", "2000:3000"},
		{"1500", "1000:2000"},
		{"8080", "8080"},
	}
	for _, pair := range overlaps {
		if !forwardPortsOverlap(spec(pair[0]), spec(pair[1])) {
			t.Errorf("%s 与 %s 应重叠", pair[0], pair[1])
		}
	}
	disjoint := [][2]string{
		{"1000:2000", "2001:3000"},
		{"8080", "9090"},
	}
	for _, pair := range disjoint {
		if forwardPortsOverlap(spec(pair[0]), spec(pair[1])) {
			t.Errorf("%s 与 %s 不应重叠", pair[0], pair[1])
		}
	}
	udp := spec("8080")
	udp.Protocol = "udp"
	if forwardPortsOverlap(udp, spec("8080")) {
		t.Error("协议不同不应冲突")
	}
}
