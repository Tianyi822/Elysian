package firewall

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/shared"
)

// firewallService.test.ts 的对等测试：fake 依赖驱动编排逻辑。

// stubRuleTimes 测试用时间账本桩。
type stubRuleTimes struct {
	mu       sync.Mutex
	getFunc  func(canonical string) (string, bool)
	touched  [][2]string
	removed  []string
	recordOn bool
}

func (s *stubRuleTimes) Get(canonical string) (string, bool) {
	if s.getFunc != nil {
		return s.getFunc(canonical)
	}
	return "", false
}

func (s *stubRuleTimes) Set(canonical, at string) {
	if !s.recordOn {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.touched = append(s.touched, [2]string{canonical, at})
}

func (s *stubRuleTimes) Remove(canonical string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.removed = append(s.removed, canonical)
}

func (s *stubRuleTimes) Close() {}

// withTimes 给 fake 接上一个时间账本桩。
type fakeWithTimes struct {
	*fakeUfwDeps
	times *stubRuleTimes
}

func (f fakeWithTimes) RuleTimes() ruleTimes { return f.times }

func allowInputWith(port float64) RuleInput {
	return RuleInput{Protocol: "tcp", Port: port, Family: "ipv4", Policy: "allow", Direction: "inbound", Source: SourceAllIPs, Note: strp("Web")}
}

func isInvalidStatus(err error, status int) bool {
	var invalid *shared.InvalidRequestError
	return errors.As(err, &invalid) && invalid.Status == status
}

func TestServiceListAndToggles(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{
		Active:    true,
		Rules:     []string{"allow 22/tcp", fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)},
		Listeners: []string{fmt.Sprintf("tcp:%d", PanelPort)},
	})
	svc := newService(fake)

	toggles, err := svc.Toggles()
	if err != nil {
		t.Fatal(err)
	}
	if !toggles.FirewallEnabled || toggles.PingBlocked ||
		toggles.DefaultIncoming == nil || *toggles.DefaultIncoming != "deny" ||
		toggles.DefaultOutgoing == nil || *toggles.DefaultOutgoing != "allow" {
		t.Errorf("开关与默认策略解析错误：%+v", toggles)
	}
	rules, err := svc.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 4 {
		t.Fatalf("每条规则 v4+v6 两行，got %d", len(rules))
	}
	var panelRow *FirewallRule
	for i := range rules {
		if rules[i].Port == PanelPort && rules[i].Family == "ipv4" {
			panelRow = &rules[i]
		}
	}
	if panelRow == nil || panelRow.Status != "normal" || panelRow.Note == nil || *panelRow.Note != "Elysian 面板" || panelRow.UpdatedAt != nil {
		t.Errorf("面板行错误：%+v", panelRow)
	}
	var sshRow *FirewallRule
	for i := range rules {
		if rules[i].Port == 22 && rules[i].Family == "ipv4" {
			sshRow = &rules[i]
		}
	}
	if sshRow == nil || sshRow.Status != "unused" || sshRow.Source != SourceAllIPs {
		t.Errorf("ssh 行监听状态错误：%+v", sshRow)
	}
}

func TestServiceListCliTypedIpRule(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true, Rules: []string{"deny from 203.0.113.9"}})
	svc := newService(fake)

	ipRules, _ := svc.ListIpRules()
	rules, _ := svc.List()
	if len(rules) != 0 {
		t.Errorf("纯来源规则不算端口规则，got %d", len(rules))
	}
	if len(ipRules) != 1 || ipRules[0].Source != "203.0.113.9" || ipRules[0].Family != "ipv4" || ipRules[0].Policy != "deny" {
		t.Errorf("命令行手敲的 IP 规则应可读回：%+v", ipRules)
	}
}

func TestServiceCreateExecutesAndTouches(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	times := &stubRuleTimes{recordOn: true}
	svc := newService(fakeWithTimes{fakeUfwDeps: fake, times: times})

	rule, err := svc.Create(allowInputWith(8080))
	if err != nil {
		t.Fatal(err)
	}
	calls := fake.calls()
	if len(calls) < 3 || calls[2] != "allow 8080/tcp comment Web" {
		t.Errorf("应在两次读态后执行 allow，calls=%v", calls)
	}
	if rule.Port != 8080 || rule.Note == nil || *rule.Note != "Web" || rule.UpdatedAt == nil || *rule.UpdatedAt != "2026-09-19T08:00:00.000Z" {
		t.Errorf("创建返回行错误：%+v", rule)
	}
	wantId := canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: "8080", From: "any"})
	if len(times.touched) != 1 || times.touched[0] != [2]string{wantId, "2026-09-19T08:00:00.000Z"} {
		t.Errorf("持久化账本应登记：%v", times.touched)
	}
}

func TestServiceCreateReadsPersistedTimes(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp"}})
	id := canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: "8080", From: "any"})
	svc := newService(fakeWithTimes{fakeUfwDeps: fake, times: &stubRuleTimes{getFunc: func(canonical string) (string, bool) {
		if canonical == id {
			return "2026-01-02T03:04:05.000Z", true
		}
		return "", false
	}}})

	rules, err := svc.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) == 0 || rules[0].UpdatedAt == nil || *rules[0].UpdatedAt != "2026-01-02T03:04:05.000Z" {
		t.Errorf("持久化账本的时间应参与读取：%+v", rules)
	}
}

func TestServiceCreateDuplicate409(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp"}})
	svc := newService(fake)

	_, err := svc.Create(allowInputWith(8080))
	if err == nil || !strings.Contains(err.Error(), "端口规则已存在") {
		t.Fatalf("应判重：%v", err)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 0 {
		t.Errorf("判重时不执行任何写命令：%v", writes)
	}

	// 地址族语义：输入 ipv6 也不把地址族说成已存在。
	fake22 := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 22/tcp"}})
	svc22 := newService(fake22)
	in := allowInputWith(22)
	in.Family = "ipv6"
	_, err = svc22.Create(in)
	if !isInvalidStatus(err, 409) {
		t.Fatalf("重复判定应为 409：%v", err)
	}
	if strings.Contains(err.Error(), "（ipv6）") || !strings.Contains(err.Error(), "IPv4 与 IPv6 由同一条规则覆盖") {
		t.Errorf("判重文案应讲清地址族语义：%v", err)
	}
}

func TestServiceCreateRangeAndOutbound(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)

	in := allowInputWith(1000)
	portTo := float64(2000)
	in.PortTo = &portTo
	in.Direction = "outbound"
	in.Policy = "limit"
	if _, err := svc.Create(in); err != nil {
		t.Fatal(err)
	}
	calls := fake.calls()
	if calls[2] != "limit out 1000:2000/tcp comment Web" {
		t.Errorf("端口段与出站应透传到 ufw 参数：calls=%v", calls)
	}
}

func TestServiceCreateLimit200(t *testing.T) {
	var rules []string
	for i := 0; i < firewallLimitUserRules; i++ {
		rules = append(rules, fmt.Sprintf("allow %d/tcp", 20000+i))
	}
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: rules})
	svc := newService(fake)

	_, err := svc.Create(allowInputWith(8080))
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("端口规则已达上限（最多 %d 条）", firewallLimitUserRules)) {
		t.Fatalf("应拒超限：%v", err)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 0 {
		t.Errorf("超限时不执行写命令：%v", writes)
	}
}

func TestServiceRemoveByCanonical(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp"}})
	svc := newService(fake)

	id := canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: "8080", From: "any"}) + ".ipv4"
	if err := svc.Remove(id); err != nil {
		t.Fatal(err)
	}
	if calls := fake.calls(); calls[2] != "delete allow 8080/tcp" {
		t.Errorf("删除命令错误：%v", calls)
	}
	if got := fake.getAdded(); len(got) != 0 {
		t.Errorf("规则应已删除：%v", got)
	}
}

func TestServiceRemovePanelDenied(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)}})
	svc := newService(fake)

	panelId := canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: fmt.Sprintf("%d", PanelPort), From: "any"}) + ".ipv4"
	if err := svc.Remove(panelId); err == nil || !strings.Contains(err.Error(), "面板端口规则不允许删除") {
		t.Fatalf("面板保底不可删：%v", err)
	}
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, "delete") {
			t.Errorf("不应执行删除：%v", call)
		}
	}
}

func TestServiceUpdateBuildFirstThenDelete(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp"}})
	svc := newService(fake)
	ruleId := canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: "8080", From: "any"}) + ".ipv4"

	in := allowInputWith(9090)
	in.Note = nil
	if _, err := svc.Update(ruleId, in); err != nil {
		t.Fatal(err)
	}
	calls := fake.calls()
	if calls[2] != "allow 9090/tcp" || calls[3] != "delete allow 8080/tcp" {
		t.Errorf("改端口应先建后删：%v", calls)
	}
	if got := fake.getAdded(); len(got) != 1 || got[0] != "allow 9090/tcp" {
		t.Errorf("账本应只剩新规则：%v", got)
	}
}

func TestServiceUpdateNoteOnlyDeleteFirst(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp comment '旧备注'"}})
	svc := newService(fake)
	ruleId := canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: "8080", From: "any"}) + ".ipv6"

	rule, err := svc.Update(ruleId, allowInputWith(8080))
	if err != nil {
		t.Fatal(err)
	}
	calls := fake.calls()
	if calls[2] != "delete allow 8080/tcp" || calls[3] != "allow 8080/tcp comment Web" {
		t.Errorf("只改备注应先删后建：%v", calls)
	}
	if rule.Note == nil || *rule.Note != "Web" {
		t.Errorf("返回行备注错误：%+v", rule)
	}
}

func TestServiceUpdatePanelDenyDenied(t *testing.T) {
	panelLine := fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{panelLine}})
	svc := newService(fake)
	panelId := canonicalId(panelSpec) + ".ipv4"

	in := allowInputWith(PanelPort)
	in.Policy = "deny"
	in.Note = nil
	_, err := svc.Update(panelId, in)
	if err == nil || !strings.Contains(err.Error(), "面板端口规则不允许变更") {
		t.Fatalf("面板保底改 deny 应被拒：%v", err)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 0 {
		t.Errorf("拒绝时不执行任何写命令：%v", writes)
	}
	if got := fake.getAdded(); len(got) != 1 || got[0] != panelLine {
		t.Errorf("账本应保持原样：%v", got)
	}
}

func TestServiceUpdatePanelNoteRejected(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)}})
	svc := newService(fake)
	in := allowInputWith(PanelPort)
	in.Note = strp("面板保底")
	if _, err := svc.Update(canonicalId(panelSpec)+".ipv4", in); err == nil {
		t.Fatal("系统入口规则不能修改备注")
	}
	if len(fake.writeCommandCalls()) != 0 {
		t.Fatal("保护规则不得被先删后建")
	}
}

func TestServiceImportRules(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp"}})
	svc := newService(fake)

	in2 := allowInputWith(3306)
	in2.Note = strp("MySQL")
	in3 := allowInputWith(3306)
	result, err := svc.ImportRules([]RuleInput{allowInputWith(8080), in2, in3})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Added) != 1 || result.Added[0].Port != 3306 || result.Added[0].Note == nil || *result.Added[0].Note != "MySQL" {
		t.Errorf("新增列表错误：%+v", result.Added)
	}
	if result.Skipped != 2 {
		t.Errorf("跳过数 = %d，want 2", result.Skipped)
	}
}

func TestServiceImportRulesBatchValidation(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)

	bad := allowInputWith(0)
	_, err := svc.ImportRules([]RuleInput{allowInputWith(8080), bad, allowInputWith(9090)})
	if err == nil || !strings.Contains(err.Error(), "第 2 条规则无效") {
		t.Fatalf("整批先校验应报第几条：%v", err)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 0 {
		t.Errorf("整批拒绝时合法条目也不执行：%v", writes)
	}
}

func TestServiceImportRulesMidFailure(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	writes := 0
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		if args[0] == "allow" || args[0] == "deny" || args[0] == "limit" {
			writes++
			if writes == 2 {
				return "", fmt.Errorf("ERROR: 规则写入失败")
			}
		}
		return next()
	}
	svc := newService(fake)

	_, err := svc.ImportRules([]RuleInput{allowInputWith(8080), allowInputWith(9090), allowInputWith(9091)})
	if err == nil {
		t.Fatal("执行阶段中途失败应报错")
	}
	if !strings.Contains(err.Error(), "第 2 条规则写入失败") || !strings.Contains(err.Error(), "此前 1 条已写入防火墙") {
		t.Errorf("失败消息应带第几条与已写入条数：%v", err)
	}
	// 消息里的条数与防火墙真实状态一致：第 1 条确实已写入。
	if got := fake.getAdded(); len(got) != 1 || got[0] != "allow 8080/tcp comment 'Web'" {
		t.Errorf("账本真实状态错误：%v", got)
	}
}

func TestServiceImportRulesLimitProjection(t *testing.T) {
	full := make([]string, firewallLimitUserRules)
	for i := range full {
		full[i] = fmt.Sprintf("allow %d/tcp", 20000+i)
	}
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: full})
	svc := newService(fake)

	in1 := allowInputWith(3306)
	in1.Note = nil
	in2 := allowInputWith(3306)
	if _, err := svc.ImportRules([]RuleInput{in1, in2}); err == nil ||
		!strings.Contains(err.Error(), fmt.Sprintf("端口规则数将超出上限（最多 %d 条）", firewallLimitUserRules)) {
		t.Fatalf("将超上限应整批拒绝：%v", err)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 0 {
		t.Errorf("整批拒绝不执行写命令：%v", writes)
	}

	nearly := make([]string, firewallLimitUserRules-1)
	for i := range nearly {
		nearly[i] = fmt.Sprintf("allow %d/tcp", 20000+i)
	}
	fake2 := createFakeDeps(fakeUfwDepsSeed{Rules: nearly})
	svc2 := newService(fake2)
	in := allowInputWith(3306)
	in.Note = strp("MySQL")
	result, err := svc2.ImportRules([]RuleInput{in})
	if err != nil {
		t.Fatalf("恰好到上限应允许导入：%v", err)
	}
	if len(result.Added) != 1 || result.Skipped != 0 {
		t.Errorf("恰好在上限内的导入结果错误：%+v", result)
	}
}

func TestServiceIpRules(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)

	rule, err := svc.CreateIpRule(IpRuleInput{Policy: "deny", Source: "203.0.113.0/24", Note: strp("恶意扫描段")})
	if err != nil {
		t.Fatal(err)
	}
	if calls := fake.calls(); calls[2] != "deny from 203.0.113.0/24 comment 恶意扫描段" {
		t.Errorf("IP 规则命令错误：%v", calls)
	}
	if rule.Source != "203.0.113.0/24" || rule.Family != "ipv4" || rule.Policy != "deny" {
		t.Errorf("IP 规则行错误：%+v", rule)
	}
}

func TestServiceIpRulesDuplicateAndV6(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"deny from 203.0.113.9"}})
	svc := newService(fake)

	if _, err := svc.CreateIpRule(IpRuleInput{Policy: "deny", Source: "203.0.113.9"}); err == nil || !strings.Contains(err.Error(), "IP 规则已存在") {
		t.Fatalf("重复来源应报中文错误：%v", err)
	}
	v6, err := svc.CreateIpRule(IpRuleInput{Policy: "allow", Source: "fd00::/8"})
	if err != nil || v6.Family != "ipv6" {
		t.Errorf("v6 来源应归 ipv6：%v %v", v6, err)
	}
}

func TestServiceIpRulesLimit(t *testing.T) {
	rules := make([]string, firewallLimitIpRules)
	for i := range rules {
		rules[i] = fmt.Sprintf("deny from 198.18.0.%d", i)
	}
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: rules})
	svc := newService(fake)

	_, err := svc.CreateIpRule(IpRuleInput{Policy: "deny", Source: "203.0.113.9"})
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("IP 规则已达上限（最多 %d 条）", firewallLimitIpRules)) {
		t.Fatalf("应拒超限：%v", err)
	}
	if writes := fake.writeCommandCalls(); len(writes) != 0 {
		t.Errorf("超限不执行写命令：%v", writes)
	}
}

func TestServiceIpRulesUpdateRemoveByCanonical(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"deny from 203.0.113.9 comment '旧'"}})
	svc := newService(fake)
	id := ipCanonicalId(ufwIpSpec{Action: "deny", Direction: "in", From: "203.0.113.9"}) + ".ipv4"

	if err := svc.RemoveIpRule(id); err != nil {
		t.Fatal(err)
	}
	if got := fake.getAdded(); len(got) != 0 {
		t.Errorf("应删除：%v", got)
	}

	if _, err := svc.CreateIpRule(IpRuleInput{Policy: "allow", Source: "10.0.0.0/8"}); err != nil {
		t.Fatal(err)
	}
	id2 := ipCanonicalId(ufwIpSpec{Action: "allow", Direction: "in", From: "10.0.0.0/8"}) + ".ipv4"
	updated, err := svc.UpdateIpRule(id2, IpRuleInput{Policy: "deny", Source: "10.0.0.0/8", Note: strp("改拒绝")})
	if err != nil || updated.Policy != "deny" {
		t.Errorf("按指纹修改失败：%v %+v", err, updated)
	}
}

func TestServiceCreateForwardWritesNatAndKernel(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)

	rule, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80, Note: strp("博客内网上游")})
	if err != nil {
		t.Fatal(err)
	}
	if rule.Port != 8080 || rule.PortTo != nil || rule.TargetHost != "10.0.0.5" || rule.TargetPort != 80 {
		t.Errorf("转发行错误：%+v", rule)
	}

	var written *string
	for _, w := range fake.fileWritesOf() {
		if w.Path == "/etc/ufw/before.rules" {
			content := w.Content
			written = &content
		}
	}
	if written == nil {
		t.Fatal("应写入 before.rules")
	}
	if !strings.HasPrefix(*written, "### ELYSIAN 端口转发") {
		t.Error("nat 标记段应置于文件最前")
	}
	if !strings.Contains(*written, "*nat") {
		t.Error("应包含 *nat")
	}
	if got := parseForwardSection(*written); len(got) != 1 {
		t.Errorf("段内应恰有一条：%d", len(got))
	}
	if !strings.Contains(*written, "-A ufw-before-forward -p tcp -d 10.0.0.5 --dport 80") {
		t.Error("filter 放行段缺失")
	}
	// 内核里成对出现：PREROUTING 的 DNAT + POSTROUTING 的 MASQUERADE。
	nat := fake.getNatRules()
	if len(nat) != 2 ||
		nat[0].Chain != "PREROUTING" || nat[0].Protocol != "tcp" || nat[0].Port != "8080" || nat[0].TargetHost != "10.0.0.5" || nat[0].TargetPort != 80 ||
		nat[1].Chain != "POSTROUTING" || nat[1].TargetHost != "10.0.0.5" || nat[1].TargetPort != 80 {
		t.Errorf("内核 nat 规则错误：%+v", nat)
	}
	// 放行段要经完整的 disable→enable 周期生效。
	enabled := false
	for _, call := range fake.calls() {
		if call == "--force enable" {
			enabled = true
		}
	}
	if !enabled {
		t.Error("应走完整 disable→enable 周期")
	}
}

func TestServiceForwardNoKernelAccumulation(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)

	rule, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateForward(rule.ID, ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.9", TargetPort: 80}); err != nil {
		t.Fatal(err)
	}
	nat := fake.getNatRules()
	if len(nat) != 2 || nat[0].TargetHost != "10.0.0.9" || nat[1].TargetHost != "10.0.0.9" {
		t.Errorf("更新后内核应只有新目标一对规则：%+v", nat)
	}
}

func TestServiceForwardConflicts(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)
	if _, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80}); err != nil {
		t.Fatal(err)
	}

	if _, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.6", TargetPort: 81}); err == nil || !strings.Contains(err.Error(), "端口转发已存在") {
		t.Fatalf("同端口应判冲突：%v", err)
	}
	if _, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 9090, TargetHost: "fd00::1", TargetPort: 80}); err == nil || !strings.Contains(err.Error(), "目标地址无效") {
		t.Fatalf("v6 目标应拒：%v", err)
	}
	before := len(fake.getNatRules())
	_, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 9090, TargetHost: "10.0.0.0/24", TargetPort: 80})
	if !isInvalidStatus(err, 400) || err.Error() != "目标地址无效：10.0.0.0/24（应为单个 IPv4 地址，不含网段）" {
		t.Fatalf("CIDR 目标应按 400 拒且文案逐字：%v", err)
	}
	if got := len(fake.getNatRules()); got != before {
		t.Errorf("拒绝时不动内核：%d → %d", before, got)
	}
}

func TestServiceForwardRangeConflicts(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)
	in := ForwardInput{Protocol: "tcp", Port: 1000, TargetHost: "10.0.0.5", TargetPort: 80}
	portTo := float64(2000)
	in.PortTo = &portTo
	if _, err := svc.CreateForward(in); err != nil {
		t.Fatal(err)
	}

	// 单端口落入既有区间：后建者会静默失效，判冲突。
	if _, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 1500, TargetHost: "10.0.0.9", TargetPort: 81}); err == nil || !strings.Contains(err.Error(), "端口转发已存在") {
		t.Fatalf("单端口落入区间应判冲突：%v", err)
	}
	// 区间端点重叠。
	edge := ForwardInput{Protocol: "tcp", Port: 2000, TargetHost: "10.0.0.9", TargetPort: 81}
	edgeTo := float64(3000)
	edge.PortTo = &edgeTo
	if _, err := svc.CreateForward(edge); err == nil || !strings.Contains(err.Error(), "端口转发已存在") {
		t.Fatalf("端点重叠应判冲突：%v", err)
	}
	// 协议不同或区间不相交：允许。
	if _, err := svc.CreateForward(ForwardInput{Protocol: "udp", Port: 1500, TargetHost: "10.0.0.9", TargetPort: 81}); err != nil {
		t.Fatal(err)
	}
	tail := ForwardInput{Protocol: "tcp", Port: 2001, TargetHost: "10.0.0.9", TargetPort: 81}
	tailTo := float64(3000)
	tail.PortTo = &tailTo
	if _, err := svc.CreateForward(tail); err != nil {
		t.Fatal(err)
	}
	if got := parseForwardSection(fake.getBeforeRules()); len(got) != 3 {
		t.Errorf("应有三条转发：%d", len(got))
	}
}

func TestServiceForwardPanelPortDenied(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)

	_, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: float64(PanelPort), TargetHost: "10.0.0.5", TargetPort: 8080})
	if !isInvalidStatus(err, 400) || err.Error() != fmt.Sprintf("面板端口不允许配置转发：外部端口段覆盖 %d（工作台自身的访问通道）", PanelPort) {
		t.Fatalf("面板端口单端口应 400 且文案逐字：%v", err)
	}
	cover := ForwardInput{Protocol: "tcp", Port: 1000, TargetHost: "10.0.0.5", TargetPort: 80}
	coverTo := float64(PanelPort + 1)
	cover.PortTo = &coverTo
	if _, err := svc.CreateForward(cover); err == nil || !strings.Contains(err.Error(), "面板端口不允许配置转发") {
		t.Fatalf("覆盖区间应拒：%v", err)
	}
	var writes int
	for _, w := range fake.fileWritesOf() {
		if w.Path == "/etc/ufw/before.rules" {
			writes++
		}
	}
	if writes != 0 {
		t.Errorf("拒绝时零写盘：%d", writes)
	}
	if got := len(fake.getNatRules()); got != 0 {
		t.Errorf("拒绝时不动内核：%d", got)
	}
}

func TestServiceForwardUpdateToPanelPortDenied(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)
	rule, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80})
	if err != nil {
		t.Fatal(err)
	}
	upd := ForwardInput{Protocol: "tcp", Port: 5000, TargetHost: "10.0.0.5", TargetPort: 80}
	updTo := float64(PanelPort + 1)
	upd.PortTo = &updTo
	if _, err := svc.UpdateForward(rule.ID, upd); err == nil || !strings.Contains(err.Error(), "面板端口不允许配置转发") {
		t.Fatalf("更新到覆盖面板端口同样应拒：%v", err)
	}
}

func TestServiceForwardLimit32(t *testing.T) {
	specs := make([]ForwardSpec, firewallLimitForwards)
	for i := range specs {
		specs[i] = ForwardSpec{Protocol: "tcp", Port: fmt.Sprintf("%d", 20000+i), TargetHost: "10.0.0.5", TargetPort: 80}
	}
	base := createFakeDeps(fakeUfwDepsSeed{})
	fake := createFakeDeps(fakeUfwDepsSeed{BeforeRules: setForwardSection(base.getBeforeRules(), specs)})
	svc := newService(fake)

	_, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 30000, TargetHost: "10.0.0.5", TargetPort: 80})
	if err == nil || !strings.Contains(err.Error(), fmt.Sprintf("端口转发已达上限（最多 %d 条）", firewallLimitForwards)) {
		t.Fatalf("应拒超限：%v", err)
	}
	if got := parseForwardSection(fake.getBeforeRules()); len(got) != firewallLimitForwards {
		t.Errorf("段应保持不变：%d", len(got))
	}
}

func TestServiceForwardRemoveLastClears(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)
	rule, err := svc.CreateForward(ForwardInput{Protocol: "udp", Port: 53, TargetHost: "10.0.0.53", TargetPort: 53})
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.RemoveForward(rule.ID); err != nil {
		t.Fatal(err)
	}
	if got := parseForwardSection(fake.getBeforeRules()); len(got) != 0 {
		t.Errorf("段应清空：%d", len(got))
	}
	if got := len(fake.getNatRules()); got != 0 {
		t.Errorf("内核规则应清空：%d", got)
	}
}

func TestServiceForwardUpdateReplaces(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)
	rule, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := svc.UpdateForward(rule.ID, ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.9", TargetPort: 8080, Note: strp("换目标")})
	if err != nil {
		t.Fatal(err)
	}
	if updated.TargetHost != "10.0.0.9" {
		t.Errorf("目标应替换：%+v", updated)
	}
	if got := parseForwardSection(fake.getBeforeRules()); len(got) != 1 {
		t.Errorf("更新应替换而非新增：%d", len(got))
	}
}

func TestServiceForwardApplyRulesFileKeepsNatSingle(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)
	if _, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80}); err != nil {
		t.Fatal(err)
	}
	prerouting := 0
	for _, rule := range fake.getNatRules() {
		if rule.Chain == "PREROUTING" {
			prerouting++
		}
	}
	if prerouting != 1 {
		t.Fatalf("创建后 PREROUTING 应只有一条：%d", prerouting)
	}

	// 防扫描配置变更会走一轮完整重启；enable 会把文件里的 nat 段再追加一次。
	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}
	enableCount := 0
	for _, call := range fake.calls() {
		if call == "--force enable" {
			enableCount++
		}
	}
	if enableCount < 2 {
		t.Errorf("应至少两次 enable（创建转发 + 扫描段变更）：%d", enableCount)
	}
	// 服务层在 enable 后删净重建：内核里仍只有一条，文件里的段也完好。
	prerouting = 0
	for _, rule := range fake.getNatRules() {
		if rule.Chain == "PREROUTING" {
			prerouting++
		}
	}
	if prerouting != 1 {
		t.Errorf("enable 后 nat 不累加：%d", prerouting)
	}
	if got := parseForwardSection(fake.getBeforeRules()); len(got) != 1 {
		t.Errorf("文件里的段应完好：%d", len(got))
	}
	if !fake.isActive() {
		t.Error("防火墙应保持激活")
	}
}

func TestServiceEnableFailureMessage(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		if args[0] == "--force" && args[1] == "enable" {
			// 模拟坏规则文件：ufw 的 enable 没有把防火墙拉起来。
			return "", nil
		}
		return next()
	}
	svc := newService(fake)

	_, err := svc.SetScanProtection(true)
	if err == nil {
		t.Fatal("应报错")
	}
	for _, want := range []string{"规则重载后防火墙未处于激活状态", "备份", "ufw enable"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("错误消息缺少 %q：%v", want, err)
		}
	}
}

func TestServiceSetTogglesEnableOrder(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)

	toggles, err := svc.SetToggles(FirewallToggles{FirewallEnabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if !toggles.FirewallEnabled {
		t.Error("应启用")
	}
	enableIndex, allowIndex := -1, -1
	for i, call := range fake.calls() {
		if call == "--force enable" && enableIndex == -1 {
			enableIndex = i
		}
		if strings.HasPrefix(call, "allow") && allowIndex == -1 {
			allowIndex = i
		}
	}
	if enableIndex == -1 || allowIndex == -1 || enableIndex < allowIndex {
		t.Errorf("启用前应先补保底再 enable：allow@%d enable@%d calls=%v", allowIndex, enableIndex, fake.calls())
	}
	if !fake.isActive() {
		t.Error("应激活")
	}
}

func TestServiceSetTogglesDisableReadsNullDefaults(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{
		Active: true,
		Rules:  []string{fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)},
	})
	svc := newService(fake)

	toggles, err := svc.SetToggles(FirewallToggles{FirewallEnabled: false})
	if err != nil {
		t.Fatal(err)
	}
	if toggles.FirewallEnabled || toggles.DefaultIncoming != nil || toggles.DefaultOutgoing != nil {
		t.Errorf("关闭后默认策略读作未知：%+v", toggles)
	}
}

func TestServiceTogglesInactiveReadable(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)
	toggles, err := svc.Toggles()
	if err != nil {
		t.Fatal(err)
	}
	if toggles.FirewallEnabled || toggles.DefaultIncoming != nil || toggles.DefaultOutgoing != nil {
		t.Errorf("未激活时也能读开关：%+v", toggles)
	}
}

func TestServiceSetTogglesIdempotentPanelAllow(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)}})
	svc := newService(fake)

	if _, err := svc.SetToggles(FirewallToggles{FirewallEnabled: true}); err != nil {
		t.Fatal(err)
	}
	allowCount := 0
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, "allow") {
			allowCount++
		}
	}
	if allowCount != 1 {
		t.Errorf("未激活无法按行核验，幂等补写恰好一次：%d", allowCount)
	}
}

func TestServiceSetTogglesPingBlocked(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)

	if _, err := svc.SetToggles(FirewallToggles{FirewallEnabled: true, PingBlocked: true}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fake.getBeforeRules(), "--icmp-type echo-request -j DROP") {
		t.Error("v4 应禁 ping")
	}
	// v6 文件也应改写（读原文件确认）。
	v6, err := fake.ReadText("/etc/ufw/before6.rules")
	if err != nil || !strings.Contains(v6, "--icmpv6-type echo-request -j DROP") {
		t.Errorf("v6 应禁 ping：%v", err)
	}
	enabled := false
	for _, call := range fake.calls() {
		if call == "--force enable" {
			enabled = true
		}
	}
	if !enabled || !fake.isActive() {
		t.Error("应经完整重启并保持激活")
	}
}

func TestServiceSetTogglesPingFileOnlyWhenInactive(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: false})
	svc := newService(fake)

	if _, err := svc.SetToggles(FirewallToggles{PingBlocked: true}); err != nil {
		t.Fatal(err)
	}
	for _, call := range fake.calls() {
		if strings.Contains(call, "reload") {
			t.Errorf("未激活时不 reload：%v", call)
		}
	}
}

func TestServiceSetTogglesDisableRunsUfwDisable(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)

	if _, err := svc.SetToggles(FirewallToggles{FirewallEnabled: false}); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, call := range fake.calls() {
		if call == "disable" {
			found = true
		}
	}
	if !found || fake.isActive() {
		t.Errorf("停用应执行 ufw disable：found=%v active=%v", found, fake.isActive())
	}
}

func TestServiceScanDisabledZeroStats(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)

	scan, err := svc.ScanProtection()
	if err != nil {
		t.Fatal(err)
	}
	if scan.Enabled || scan.Stats != (FirewallScanStats{}) || len(scan.Blocked) != 0 {
		t.Errorf("停用态应零统计：%+v", scan)
	}
	want := DefaultScanConfig()
	if len(scan.Config.Ports) != len(want.Ports) || scan.Config.WindowSeconds != want.WindowSeconds {
		t.Errorf("停用态配置回落默认：%+v", scan.Config)
	}
}

func TestServiceScanEnableDualStack(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	fake.setDropCount(100, "v4")
	svc := newService(fake)

	scan, err := svc.SetScanProtection(true)
	if err != nil {
		t.Fatal(err)
	}
	if !scan.Enabled {
		t.Fatal("应启用")
	}
	var v4Write, v6Write *string
	for _, w := range fake.fileWritesOf() {
		switch w.Path {
		case "/etc/ufw/before.rules":
			c := w.Content
			v4Write = &c
		case "/etc/ufw/before6.rules":
			c := w.Content
			v6Write = &c
		}
	}
	if v4Write == nil || !parseScanSection(*v4Write).Enabled {
		t.Error("v4 段应写入")
	}
	if v6Write == nil || !strings.Contains(*v6Write, scanTables["v6"].Track) {
		t.Error("v6 段应写入")
	}
	enabled := false
	for _, call := range fake.calls() {
		if call == "--force enable" {
			enabled = true
		}
	}
	if !enabled {
		t.Error("激活时应 reload（完整重启）")
	}
	if scan.Stats.CurrentFailedConnections != 0 {
		t.Errorf("开启时快照从零起算：%d", scan.Stats.CurrentFailedConnections)
	}
}

func TestServiceScanConfigRoundTrip(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)
	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}

	scan, err := svc.SetScanConfig(ScanConfig{Ports: []float64{22, 8080}, WindowSeconds: 120, HitCount: 5, BanSeconds: 1800})
	if err != nil {
		t.Fatal(err)
	}
	want := ScanConfig{Ports: []float64{22, 8080}, WindowSeconds: 120, HitCount: 5, BanSeconds: 1800}
	if len(scan.Config.Ports) != 2 || scan.Config.Ports[0] != 22 || scan.Config.Ports[1] != 8080 ||
		scan.Config.WindowSeconds != 120 || scan.Config.HitCount != 5 || scan.Config.BanSeconds != 1800 {
		t.Errorf("配置应解析回：%+v（want %+v）", scan.Config, want)
	}
	var last string
	for _, w := range fake.fileWritesOf() {
		if w.Path == "/etc/ufw/before.rules" {
			last = w.Content
		}
	}
	for _, wantSub := range []string{"--dports 22,8080", "--hitcount 5", "--seconds 1800"} {
		if !strings.Contains(last, wantSub) {
			t.Errorf("规则文本缺少 %s", wantSub)
		}
	}
}

func TestServiceScanConfigValidationBeforeToggleState(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)

	// 未开启：配置合法只是开关没开 → 409。
	_, err := svc.SetScanConfig(DefaultScanConfig())
	if !isInvalidStatus(err, 409) || err.Error() != "防扫描未启用：先开启开关再调整配置" {
		t.Fatalf("未开启应为 409 且文案逐字：%v", err)
	}

	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}
	cfg := DefaultScanConfig()
	cfg.HitCount = 1
	_, err = svc.SetScanConfig(cfg)
	if !isInvalidStatus(err, 400) || !strings.Contains(err.Error(), "阈值无效") {
		t.Fatalf("越界配置应为 400：%v", err)
	}
}

func TestServiceScanConfigPanelPort(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)
	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}

	cfg := DefaultScanConfig()
	cfg.Ports = []float64{22, float64(PanelPort)}
	_, err := svc.SetScanConfig(cfg)
	if !isInvalidStatus(err, 400) || err.Error() != fmt.Sprintf("面板端口不允许加入防扫描监控：%d 是工作台自身的访问通道", PanelPort) {
		t.Fatalf("面板端口应 400 且文案逐字：%v", err)
	}
	// 配置未被写入：段里的端口仍是默认值。
	state := parseScanSection(fake.getBeforeRules())
	if len(state.Config.Ports) != len(DefaultScanConfig().Ports) {
		t.Errorf("配置未写入：%+v", state.Config)
	}
}

func TestServiceScanConfigPanelPortEvenWhenDisabled(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: false})
	svc := newService(fake)

	cfg := DefaultScanConfig()
	cfg.Ports = []float64{22, float64(PanelPort)}
	_, err := svc.SetScanConfig(cfg)
	if !isInvalidStatus(err, 400) || !strings.Contains(err.Error(), "面板端口不允许加入防扫描监控") {
		t.Fatalf("校验先于开关状态：%v", err)
	}
	if parseScanSection(fake.getBeforeRules()).Enabled {
		t.Error("拒绝不落盘")
	}
}

func TestServiceScanInactiveNoIptablesQuery(t *testing.T) {
	enabledRules, err := setScanSection(createFakeDeps(fakeUfwDepsSeed{}).getBeforeRules(), true, DefaultScanConfig(), "v4")
	if err != nil {
		t.Fatal(err)
	}
	fake := createFakeDeps(fakeUfwDepsSeed{Active: false, BeforeRules: enabledRules})
	svc := newService(fake)

	scan, err := svc.ScanProtection()
	if err != nil {
		t.Fatal(err)
	}
	if !scan.Enabled || scan.Stats != (FirewallScanStats{}) || len(scan.Blocked) != 0 {
		t.Errorf("停用态只回报配置与空统计：%+v", scan)
	}
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, "iptables:") || strings.HasPrefix(call, "ip6tables:") {
			t.Errorf("停用态不应查 iptables：%v", call)
		}
	}
}

func TestServiceScanEnableFileOnlyWhenInactive(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: false})
	svc := newService(fake)

	scan, err := svc.SetScanProtection(true)
	if err != nil {
		t.Fatal(err)
	}
	if !parseScanSection(fake.getBeforeRules()).Enabled {
		t.Error("停用态开启仍写文件")
	}
	for _, call := range fake.calls() {
		if call == "--force enable" {
			t.Errorf("停用态不 reload：%v", call)
		}
	}
	if !scan.Enabled || scan.Stats.CurrentBlockedIps != 0 || scan.Stats.CurrentFailedConnections != 0 {
		t.Errorf("读取回报空统计（防火墙启用后生效）：%+v", scan)
	}
}

func TestServiceScanBacksUpBeforeWrite(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: false})
	svc := newService(fake)
	originalV4 := fake.getBeforeRules()
	v6, _ := fake.ReadText("/etc/ufw/before6.rules")

	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}
	if got, ok := fake.getFile(backupPathOf("/etc/ufw/before.rules")); !ok || got != originalV4 {
		t.Errorf("写前应备份 v4 原文：%v", got)
	}
	if got, ok := fake.getFile(backupPathOf("/etc/ufw/before6.rules")); !ok || got != v6 {
		t.Errorf("写前应备份 v6 原文：%v", got)
	}
}

func TestServiceScanEnableFailureRollsBack(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		// 模拟坏规则文件：enable 没有把防火墙拉起来；恢复到备份（无扫描段）后可正常拉起。
		if args[0] == "--force" && args[1] == "enable" && strings.Contains(fake.getBeforeRules(), scanTables["v4"].Track) {
			return "", nil
		}
		return next()
	}
	svc := newService(fake)

	_, err := svc.SetScanProtection(true)
	// 恢复成功不等于本次变更成功：防火墙此刻跑的是恢复后的旧规则，必须按失败报出。
	if err == nil {
		t.Fatal("恢复成功也按操作失败报出")
	}
	for _, want := range []string{"规则重载未生效", "已被回滚", "备份"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("错误消息缺少 %q：%v", want, err)
		}
	}
	if !fake.isActive() {
		t.Error("防火墙当前按恢复后的规则运行")
	}
	if parseScanSection(fake.getBeforeRules()).Enabled {
		t.Error("坏写入已回滚到备份内容")
	}
	if scan, _ := svc.ScanProtection(); scan.Enabled {
		t.Error("读取应如实回报停用")
	}
}

func TestServicePingRollbackReported(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		// 只在「已写入禁 ping 的新规则文件」上失败：恢复到备份（未禁 ping）后可拉起。
		if args[0] == "--force" && args[1] == "enable" && parsePingBlocked(fake.getBeforeRules()) {
			return "", nil
		}
		return next()
	}
	svc := newService(fake)
	before := fake.getBeforeRules()

	_, err := svc.SetToggles(FirewallToggles{FirewallEnabled: true, PingBlocked: true})
	if err == nil || !strings.Contains(err.Error(), "已被回滚") {
		t.Fatalf("禁 ping 变更遇回滚应按失败抛出：%v", err)
	}
	if got := fake.getBeforeRules(); got != before {
		t.Errorf("文件应回到备份内容")
	}
	if toggles, _ := svc.Toggles(); toggles.PingBlocked {
		t.Error("禁 ping 的改动没有留在生效规则里")
	}
}

func TestServiceScanStatsAggregation(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)
	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}
	fake.setDropCount(40, "v4")
	fake.setDropCount(2, "v6")
	fake.setRecent("src=203.0.113.9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n", "v4")
	fake.setRecent("src=2001:db8::9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n", "v6")

	scan, err := svc.ScanProtection()
	if err != nil {
		t.Fatal(err)
	}
	if !scan.Enabled {
		t.Fatal("应启用")
	}
	// 双 DROP 规则 × 双栈：v4(40×2) + v6(2×2)。
	if scan.Stats.TotalFailedConnections != 84 {
		t.Errorf("累计拦截计数 = %d，want 84", scan.Stats.TotalFailedConnections)
	}
	if scan.Stats.CurrentBlockedIps != 2 {
		t.Errorf("当前封锁 = %d，want 2", scan.Stats.CurrentBlockedIps)
	}
	if len(scan.Blocked) != 2 || scan.Blocked[0].IP != "203.0.113.9" || scan.Blocked[1].IP != "2001:db8::9" {
		t.Errorf("封锁名单错误：%+v", scan.Blocked)
	}
	if scan.Blocked[0].BlockedAt != "2026-09-19T08:00:00.000Z" {
		t.Errorf("blockedAt 取首次观察时间：%+v", scan.Blocked[0])
	}

	// 再次观察同一批 IP 不重复累计历史总数。
	fake.setRecent("src=203.0.113.9 ttl: 64 last_seen: 3 oldest_pkt: 1 newest_pkt: 3\n", "v4")
	fake.setRecent("", "v6")
	next, err := svc.ScanProtection()
	if err != nil {
		t.Fatal(err)
	}
	if next.Stats.TotalBlockedIps != 2 {
		t.Errorf("历史 IP 不重复累计：%d", next.Stats.TotalBlockedIps)
	}
	if len(next.Blocked) != 1 {
		t.Errorf("当前名单应只剩一条：%+v", next.Blocked)
	}
}

func TestServiceUnblockByFamily(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)
	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}
	fake.setRecent("src=203.0.113.9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n", "v4")
	fake.setRecent("src=2001:db8::9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n", "v6")

	scan, err := svc.UnblockIp("2001:db8::9")
	if err != nil {
		t.Fatal(err)
	}
	var v6Write *string
	for _, w := range fake.fileWritesOf() {
		if w.Path == ScanBanned6RecentPath {
			c := w.Content
			v6Write = &c
		}
	}
	if v6Write == nil || *v6Write != "-2001:db8::9\n" {
		t.Errorf("解封应按地址族写对应名单（写 -IP\\n）：%v", v6Write)
	}
	if len(scan.Blocked) != 1 || scan.Blocked[0].IP != "203.0.113.9" {
		t.Errorf("解封后名单错误：%+v", scan.Blocked)
	}
}

func TestServiceUnblockErrors(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	svc := newService(fake)

	if _, err := svc.UnblockIp("203.0.113.0/24"); err == nil || !strings.Contains(err.Error(), "防扫描未启用") {
		t.Fatalf("未启用应报错：%v", err)
	}

	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UnblockIp("example"); err == nil || !strings.Contains(err.Error(), "IP 无效") {
		t.Fatalf("非法 IP 应报错：%v", err)
	}
	fake.setRecent("src=203.0.113.9 ttl: 64 last_seen: 1 oldest_pkt: 1 newest_pkt: 1\n", "v4")
	if _, err := svc.UnblockIp("198.51.100.7"); err == nil || !strings.Contains(err.Error(), "不在封锁名单中") {
		t.Fatalf("名单里没有的 IP 应报错：%v", err)
	}
}

func TestServiceScanDisableRemovesSections(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true})
	svc := newService(fake)
	if _, err := svc.SetScanProtection(true); err != nil {
		t.Fatal(err)
	}
	scan, err := svc.SetScanProtection(false)
	if err != nil {
		t.Fatal(err)
	}
	if scan.Enabled || parseScanSection(fake.getBeforeRules()).Enabled {
		t.Error("停用应移除双栈规则段")
	}
}

func TestServiceRulesWriteSerialization(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Active: false})
	svc := newService(fake)

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		_, _ = svc.SetScanProtection(true)
	}()
	go func() {
		defer wg.Done()
		_, _ = svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80})
	}()
	wg.Wait()

	text := fake.getBeforeRules()
	if !parseScanSection(text).Enabled {
		t.Error("并发写不应丢扫描段")
	}
	if got := parseForwardSection(text); len(got) != 1 {
		t.Errorf("并发写不应丢转发段：%d", len(got))
	}
}

func TestServiceSyncFromSystemTotal(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 22/tcp", "deny from 203.0.113.9"}})
	svc := newService(fake)
	if _, err := svc.CreateForward(ForwardInput{Protocol: "tcp", Port: 8080, TargetHost: "10.0.0.5", TargetPort: 80}); err != nil {
		t.Fatal(err)
	}
	// 端口 2 行(22 v4/r6) + IP 1 行 + 转发 1 行。
	total, err := svc.SyncFromSystem()
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 {
		t.Errorf("三类行总数 = %d，want 4", total)
	}
}

// ---------- ensurePanelRule / ensurePortRule / restoreIfNeeded ----------

func TestEnsurePanelRuleSelfHealsV4Half(t *testing.T) {
	empty := []string{}
	fake := createFakeDeps(fakeUfwDepsSeed{
		Active:  true,
		Rules:   []string{fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)},
		V4Rules: &empty,
	})

	if err := ensurePanelRule(fake); err != nil {
		t.Fatal(err)
	}
	if !containsStr(fake.getV4Rules(), fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)) {
		t.Errorf("应幂等补写 IPv4 账本：%v", fake.getV4Rules())
	}
}

func TestEnsurePanelRuleNoCommandWhenRowPresent(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{
		Active: true,
		Rules:  []string{fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)},
	})

	if err := ensurePanelRule(fake); err != nil {
		t.Fatal(err)
	}
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, "allow") {
			t.Errorf("激活且行在时不执行任何写命令：%v", call)
		}
	}
}

func TestEnsurePanelRuleInactiveWritesOnce(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)}})

	if err := ensurePanelRule(fake); err != nil {
		t.Fatal(err)
	}
	allowCount := 0
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, "allow") {
			allowCount++
		}
	}
	if allowCount != 1 {
		t.Errorf("未激活幂等补写恰好一次且不抛错：%d", allowCount)
	}
}

func TestEnsurePanelRuleV4Stuck(t *testing.T) {
	empty := []string{}
	fake := createFakeDeps(fakeUfwDepsSeed{Active: true, V4Rules: &empty, V4Stuck: true})

	err := ensurePanelRule(fake)
	if err == nil || !strings.Contains(err.Error(), "面板端口保底规则未生效") {
		t.Fatalf("补写后仍无 IPv4 行应抛中文错误：%v", err)
	}
}

func TestEnsurePortRuleSkipped(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"allow 8080/tcp", "allow out 9090/udp"}})

	result := ensurePortRule(fake, 8080, "Elysian 网站 demo")
	if result.State != "skipped" || result.Detail == nil || *result.Detail != "防火墙已有该端口的放行规则" {
		t.Errorf("已有等价规则应 skipped：%+v", result)
	}
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, "allow") {
			t.Errorf("skipped 不执行写命令：%v", call)
		}
	}
}

func TestEnsurePortRuleOpened(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: []string{"deny 8080/tcp", "allow out 8080/tcp", "allow 8080/udp"}})

	result := ensurePortRule(fake, 8080, "Elysian 网站 demo")
	if result.State != "opened" || result.Detail != nil {
		t.Errorf("deny/出站/udp 不算已开放，补写后复核 opened：%+v", result)
	}
	found := false
	for _, call := range fake.calls() {
		if call == "allow 8080/tcp comment Elysian 网站 demo" {
			found = true
		}
	}
	if !found {
		t.Errorf("应执行 allow 带固定备注：%v", fake.calls())
	}
}

func TestEnsurePortRuleBothBooks(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})

	result := ensurePortRule(fake, 18080, "Elysian 数据库 orders")
	if result.State != "opened" || result.Detail != nil {
		t.Fatalf("无既有规则应 opened：%+v", result)
	}
	if !containsStr(fake.getV4Rules(), "allow 18080/tcp comment 'Elysian 数据库 orders'") {
		t.Errorf("IPv4 账本应落规则：%v", fake.getV4Rules())
	}
}

func TestEnsurePortRuleRecheckFailed(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		if args[0] == "show" {
			// show added 恒报空账本：allow 命令本身成功执行，但复核判定无规则。
			return "Added user rules:\n(None)", nil
		}
		return next()
	}

	result := ensurePortRule(fake, 8080, "Elysian 网站 demo")
	if result.State != "failed" || result.Detail == nil || !strings.Contains(*result.Detail, "仍无 8080/tcp") {
		t.Errorf("复核读不到应 failed 带复核文案：%+v", result)
	}
}

func TestEnsurePortRuleLimitFailed(t *testing.T) {
	rules := make([]string, firewallLimitUserRules)
	for i := range rules {
		rules[i] = fmt.Sprintf("allow %d/tcp", 20000+i)
	}
	fake := createFakeDeps(fakeUfwDepsSeed{Rules: rules})

	result := ensurePortRule(fake, 8080, "Elysian 网站 demo")
	if result.State != "failed" || result.Detail == nil || !strings.Contains(*result.Detail, "已达上限") {
		t.Errorf("超限应 failed：%+v", result)
	}
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, "allow") {
			t.Errorf("超限不执行 allow：%v", call)
		}
	}
}

func TestEnsurePortRuleUfwErrorFailed(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{})
	fake.ufwWrapper = func(args []string, _ func() (string, error)) (string, error) {
		return "", fmt.Errorf("ufw 不可用")
	}

	result := ensurePortRule(fake, 8080, "Elysian 网站 demo")
	if result.State != "failed" || result.Detail == nil || *result.Detail != "ufw 不可用" {
		t.Errorf("ufw 抛错应 failed 带原始消息（不包装）：%+v", result)
	}
}

func TestRestoreIfNeededEnabledYes(t *testing.T) {
	fake := createFakeDeps(fakeUfwDepsSeed{UfwConf: "ENABLED=yes\nLOGLEVEL=low\n"})

	if err := restoreIfNeeded(fake); err != nil {
		t.Fatal(err)
	}
	enableIndex, allowIndex := -1, -1
	for i, call := range fake.calls() {
		if call == "--force enable" && enableIndex == -1 {
			enableIndex = i
		}
		if strings.HasPrefix(call, "allow") && allowIndex == -1 {
			allowIndex = i
		}
	}
	if enableIndex == -1 || allowIndex == -1 || enableIndex < allowIndex {
		t.Errorf("ENABLED=yes 应先补保底再装载：%v", fake.calls())
	}
}

func TestRestoreIfNeededV4Half(t *testing.T) {
	empty := []string{}
	fake := createFakeDeps(fakeUfwDepsSeed{
		UfwConf: "ENABLED=yes\n",
		Rules:   []string{fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)},
		V4Rules: &empty,
	})

	if err := restoreIfNeeded(fake); err != nil {
		t.Fatal(err)
	}
	if !containsStr(fake.getV4Rules(), fmt.Sprintf("allow %d/tcp comment 'Elysian 面板'", PanelPort)) {
		t.Errorf("装载前应补全 IPv4：%v", fake.getV4Rules())
	}
	if !fake.isActive() {
		t.Error("装载后应激活")
	}
}

func TestRestoreIfNeededNoAction(t *testing.T) {
	noConf := createFakeDeps(fakeUfwDepsSeed{UfwConf: "ENABLED=no\n"})
	if err := restoreIfNeeded(noConf); err != nil {
		t.Fatal(err)
	}
	if calls := noConf.calls(); len(calls) != 0 {
		t.Errorf("ENABLED=no 零动作：%v", calls)
	}

	missingConf := createFakeDeps(fakeUfwDepsSeed{})
	missingConf.readWrapper = func(path string, next func() (string, error)) (string, error) {
		if path == "/etc/ufw/ufw.conf" {
			return "", fmt.Errorf("ENOENT")
		}
		return next()
	}
	if err := restoreIfNeeded(missingConf); err == nil {
		t.Fatal("UFW 配置缺失必须明确报错")
	}
	if calls := missingConf.calls(); len(calls) != 0 {
		t.Errorf("配置缺失零动作：%v", calls)
	}
}

func TestRestoreIfNeededRetriesWithBackup(t *testing.T) {
	corrupted := strings.Join([]string{"# 损坏的规则文件", "*filter", "-A 坏行"}, "\n")
	clean := createFakeDeps(fakeUfwDepsSeed{}).getBeforeRules()
	fake := createFakeDeps(fakeUfwDepsSeed{Active: false, UfwConf: "ENABLED=yes\n", BeforeRules: corrupted})
	fake.setFile(backupPathOf("/etc/ufw/before.rules"), clean)
	enableCalls := 0
	fake.ufwWrapper = func(args []string, next func() (string, error)) (string, error) {
		if args[0] == "--force" && args[1] == "enable" {
			enableCalls++
			// 第一次 enable 因坏规则文件失败；恢复后第二次成功。
			if enableCalls == 1 {
				return "", fmt.Errorf("ERROR: problem running ufw init")
			}
		}
		return next()
	}

	if err := restoreIfNeeded(fake); err != nil {
		t.Fatal(err)
	}
	if enableCalls != 2 {
		t.Errorf("装载失败应备份恢复后重试第二次：%d", enableCalls)
	}
	if got := fake.getBeforeRules(); got != clean {
		t.Errorf("文件应恢复为备份内容")
	}
	if !fake.isActive() {
		t.Error("第二次装载后应激活")
	}
}
