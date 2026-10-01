package firewall

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"elysian/server/internal/shared"
)

// 端口转发（forwardRules.ts 等价物）：在 /etc/ufw/before.rules 顶部维护一段独立的
// *nat 标记块（自有 COMMIT，置于文件最前），filter 表原内容不动；内核态由服务层
// 精确维护（先按 ELYSIAN-FWD comment 标记删净、再按段重建），不走 ufw reload——
// ufw 以 --noflush 应用 before.rules 的 nat 段，reload 只会让内核条目越积越多。

const (
	forwardMarker       = "### ELYSIAN 端口转发（自动管理，勿手工编辑）###"
	forwardFilterMarker = "### ELYSIAN 端口转发放行（自动管理，勿手工编辑）###"

	// ForwardCommentPrefix 内核里属于本面板的 nat 规则标记（comment 前缀）。
	ForwardCommentPrefix = "ELYSIAN-FWD"

	// iptables comment 上限 256 字符，留出前缀与余量。
	forwardCommentMax = 200

	// IPForwardPath 内核转发开关。
	IPForwardPath = "/proc/sys/net/ipv4/ip_forward"
)

var (
	reForwardID   = regexp.MustCompile(`^fwd-(tcp|udp)-(\d{1,5}(?::\d{1,5})?)-(.+)-(\d{1,5})$`)
	reNatRuleLine = regexp.MustCompile(`^-A PREROUTING -p (tcp|udp) --dport (\d{1,5}(?::\d{1,5})?) -m comment --comment "([^"]*)" -j DNAT --to-destination ([\d.]+):(\d{1,5})$`)
	reNatNumber   = regexp.MustCompile(`^\s*(\d+)\s`)
)

// ForwardSpec 一条端口转发规范。
type ForwardSpec struct {
	Protocol   string // tcp | udp
	Port       string // 外部端口或端口段（'1000:2000'）
	TargetHost string
	TargetPort int
	Note       *string
}

// forwardIdOf 转发规范指纹（备注不参与身份）。
func forwardIdOf(spec ForwardSpec) string {
	return fmt.Sprintf("fwd-%s-%s-%s-%d", spec.Protocol, spec.Port, jsEncodeURIComponent(spec.TargetHost), spec.TargetPort)
}

// parseForwardId 从界面行 id 取回转发规范；不认识的 id 返回 nil。
func parseForwardId(ruleId string) *ForwardSpec {
	m := reForwardID.FindStringSubmatch(ruleId)
	if m == nil {
		return nil
	}
	host, err := jsDecodeURIComponent(m[3])
	if err != nil {
		return nil
	}
	tport, err := strconv.Atoi(m[4])
	if err != nil {
		return nil
	}
	return &ForwardSpec{
		Protocol:   m[1],
		Port:       m[2],
		TargetHost: host,
		TargetPort: tport,
		Note:       nil,
	}
}

// forwardCommentOf 规则 comment：固定标记 + 用户备注（按 JS slice 语义截断到 200
// 个码位，iptables 上限 256 字符）。
func forwardCommentOf(note *string) string {
	text := ForwardCommentPrefix
	if note != nil && *note != "" {
		text = fmt.Sprintf("%s %s", ForwardCommentPrefix, *note)
	}
	runes := []rune(text)
	if len(runes) > forwardCommentMax {
		return string(runes[:forwardCommentMax])
	}
	return text
}

// noteFromForwardComment 从 comment 还原用户备注；非本面板标记的返回 nil。
func noteFromForwardComment(comment string) *string {
	if !strings.HasPrefix(comment, ForwardCommentPrefix) {
		return nil
	}
	rest := strings.TrimSpace(comment[len(ForwardCommentPrefix):])
	if rest == "" {
		return nil
	}
	return &rest
}

// natRuleArgsOf 一条转发的 DNAT 规则参数（PREROUTING）。
func natRuleArgsOf(spec ForwardSpec) []string {
	return []string{
		"-p", spec.Protocol,
		"--dport", spec.Port,
		"-m", "comment",
		"--comment", forwardCommentOf(spec.Note),
		"-j", "DNAT",
		"--to-destination", fmt.Sprintf("%s:%d", spec.TargetHost, spec.TargetPort),
	}
}

// postRoutingArgsOf 一条转发的源地址伪装规则参数（POSTROUTING）。与 DNAT 成对：
// 只做 DNAT 时目标会直接把应答发回客户端而绕过本机，形成非对称路由。
func postRoutingArgsOf(spec ForwardSpec) []string {
	return []string{
		"-d", spec.TargetHost,
		"-p", spec.Protocol,
		"--dport", strconv.Itoa(spec.TargetPort),
		"-m", "comment",
		"--comment", forwardCommentOf(spec.Note),
		"-j", "MASQUERADE",
	}
}

// ruleLineOf 一行 DNAT 规则文本（写进 before.rules 的形式）。comment 用双引号：
// iptables-restore 只认双引号。
func ruleLineOf(spec ForwardSpec) string {
	return fmt.Sprintf(`-A PREROUTING -p %s --dport %s -m comment --comment "%s" -j DNAT --to-destination %s:%d`,
		spec.Protocol, spec.Port, forwardCommentOf(spec.Note), spec.TargetHost, spec.TargetPort)
}

// postRoutingLineOf 一行 MASQUERADE 规则文本（POSTROUTING）。
func postRoutingLineOf(spec ForwardSpec) string {
	return fmt.Sprintf(`-A POSTROUTING -d %s -p %s --dport %d -m comment --comment "%s" -j MASQUERADE`,
		spec.TargetHost, spec.Protocol, spec.TargetPort, forwardCommentOf(spec.Note))
}

// parseRuleLine 从 before.rules 的一行解析回规范；非本段规则返回 nil。
func parseRuleLine(line string) *ForwardSpec {
	m := reNatRuleLine.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	note := noteFromForwardComment(m[3])
	if note == nil && m[3] != ForwardCommentPrefix {
		return nil
	}
	tport, err := strconv.Atoi(m[5])
	if err != nil {
		return nil
	}
	return &ForwardSpec{
		Protocol:   m[1],
		Port:       m[2],
		TargetHost: m[4],
		TargetPort: tport,
		Note:       note,
	}
}

// parseForwardSection 解析整个 before.rules 里的转发段为规范列表；无段返回空。
func parseForwardSection(beforeRules string) []ForwardSpec {
	section := extractMarkedSection(beforeRules, forwardMarker)
	specs := []ForwardSpec{}
	for _, line := range section {
		if spec := parseRuleLine(line); spec != nil {
			specs = append(specs, *spec)
		}
	}
	return specs
}

// setForwardSection 用给定规范列表重写转发段：段放在文件最前（ufw 官方文档的 nat
// 位置）；specs 为空等价于移除段。
func setForwardSection(beforeRules string, specs []ForwardSpec) string {
	without := removeMarkedSection(beforeRules, forwardMarker)
	if len(specs) == 0 {
		return without
	}
	lines := []string{forwardMarker, "*nat", ":PREROUTING - [0:0]", ":POSTROUTING - [0:0]"}
	for _, spec := range specs {
		lines = append(lines, ruleLineOf(spec))
	}
	for _, spec := range specs {
		lines = append(lines, postRoutingLineOf(spec))
	}
	lines = append(lines, "COMMIT", forwardMarker)
	block := strings.Join(lines, "\n")
	return block + "\n" + strings.TrimLeft(without, "\n")
}

// extractMarkedSection 取首尾标记之间的内容（不含标记行）；找不到成对标记返回 nil。
func extractMarkedSection(text string, marker string) []string {
	lines := strings.Split(text, "\n")
	start := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == marker {
			start = i
			break
		}
	}
	if start == -1 {
		return nil
	}
	for i := start + 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == marker {
			return lines[start+1 : i]
		}
	}
	return nil
}

// removeMarkedSection 按标记行成对剔除两标记之间的内容（含标记行）。
func removeMarkedSection(text string, marker string) string {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	inside := false
	for _, line := range lines {
		if strings.TrimSpace(line) == marker {
			inside = !inside
			continue
		}
		if !inside {
			out = append(out, line)
		}
	}
	return strings.Join(out, "\n")
}

// forwardFilterLinesOf 转发对应的 ufw-before-forward 放行行（filter 表内）。
func forwardFilterLinesOf(specs []ForwardSpec) []string {
	lines := make([]string, 0, len(specs))
	for _, spec := range specs {
		lines = append(lines, fmt.Sprintf(`-A ufw-before-forward -p %s -d %s --dport %d -m comment --comment "%s" -j ACCEPT`,
			spec.Protocol, spec.TargetHost, spec.TargetPort, forwardCommentOf(spec.Note)))
	}
	return lines
}

// setForwardFilterSection 重写转发放行段（插在 filter 表的 COMMIT 之前）；
// specs 为空则移除段。
func setForwardFilterSection(beforeRules string, specs []ForwardSpec) (string, error) {
	without := removeMarkedSection(beforeRules, forwardFilterMarker)
	if len(specs) == 0 {
		return without, nil
	}

	lines := strings.Split(without, "\n")
	filterStart := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "*filter" {
			filterStart = i
			break
		}
	}
	if filterStart == -1 {
		return "", fmt.Errorf("before.rules 格式无效：找不到 filter 表")
	}
	commitIndex := -1
	for i := filterStart + 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "COMMIT" {
			commitIndex = i
			break
		}
	}
	if commitIndex == -1 {
		return "", fmt.Errorf("before.rules 格式无效：找不到 filter 表的 COMMIT 行")
	}
	inserted := append([]string{forwardFilterMarker}, forwardFilterLinesOf(specs)...)
	inserted = append(inserted, forwardFilterMarker)
	lines = append(lines[:commitIndex], append(inserted, lines[commitIndex:]...)...)
	return strings.Join(lines, "\n"), nil
}

// parseOurNatRuleNumbers 从 `iptables -t nat -L <chain> -n --line-numbers` 输出取本面板
// 规则的行号（升序）。comment 在列表输出里以块注释 `/* ELYSIAN-FWD … */` 呈现，
// 据它认出本面板的规则；别人的规则不带标记，不动。
func parseOurNatRuleNumbers(listing string) []int {
	numbers := []int{}
	for _, line := range strings.Split(listing, "\n") {
		if !strings.Contains(line, fmt.Sprintf("/* %s", ForwardCommentPrefix)) {
			continue
		}
		m := reNatNumber.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		num, err := strconv.Atoi(m[1])
		if err != nil {
			continue
		}
		numbers = append(numbers, num)
	}
	sort.Ints(numbers)
	return numbers
}

// specFromForwardInput 校验转发输入并映射为规范；不合法抛中文 400。这些失败都源于
// 请求体本身（端口、协议、目标地址、面板禁区），端点按 400 返回。
func specFromForwardInput(input ForwardInput) (ForwardSpec, error) {
	if !jsIsInteger(input.Port) || input.Port < 1 || input.Port > 65535 {
		return ForwardSpec{}, shared.InvalidRequest(fmt.Sprintf("外部端口无效：%s（应为 1–65535 的整数）", jsNumberToString(input.Port)))
	}
	if input.PortTo != nil {
		if !jsIsInteger(*input.PortTo) || *input.PortTo < 1 || *input.PortTo > 65535 {
			return ForwardSpec{}, shared.InvalidRequest(fmt.Sprintf("外部端口段结束无效：%s（应为 1–65535 的整数）", jsNumberToString(*input.PortTo)))
		}
		if *input.PortTo < input.Port {
			return ForwardSpec{}, shared.InvalidRequest(fmt.Sprintf("端口段无效：结束端口 %s 小于起始端口 %s", jsNumberToString(*input.PortTo), jsNumberToString(input.Port)))
		}
	}
	if input.Protocol != "tcp" && input.Protocol != "udp" {
		return ForwardSpec{}, shared.InvalidRequest(fmt.Sprintf("协议无效：%s", input.Protocol))
	}
	// DNAT 劫走面板端口的入站流量会绕过保底放行，把工作台自己锁在外面。
	if coversPanelPort(input.Port, input.PortTo) {
		return ForwardSpec{}, shared.InvalidRequest(fmt.Sprintf("面板端口不允许配置转发：外部端口段覆盖 %d（工作台自身的访问通道）", PanelPort))
	}
	// --to-destination 只接受单个 IPv4 地址：带 / 的网段会写出 iptables-restore
	// 装载失败的坏规则。
	if !isValidFirewallAddress(input.TargetHost) || strings.Contains(input.TargetHost, ":") || strings.Contains(input.TargetHost, "/") {
		return ForwardSpec{}, shared.InvalidRequest(fmt.Sprintf("目标地址无效：%s（应为单个 IPv4 地址，不含网段）", input.TargetHost))
	}
	if !jsIsInteger(input.TargetPort) || input.TargetPort < 1 || input.TargetPort > 65535 {
		return ForwardSpec{}, shared.InvalidRequest(fmt.Sprintf("目标端口无效：%s（应为 1–65535 的整数）", jsNumberToString(input.TargetPort)))
	}
	// 备注以双引号包进规则文本：换行/控制字符与双引号都会写坏 before.rules。
	if err := assertNoteSafe(input.Note, noteSceneForward); err != nil {
		return ForwardSpec{}, err
	}
	port := strconv.FormatInt(int64(input.Port), 10)
	if input.PortTo != nil {
		port = fmt.Sprintf("%s:%s", port, strconv.FormatInt(int64(*input.PortTo), 10))
	}
	var note *string
	if input.Note != nil {
		trimmed := strings.TrimSpace(*input.Note)
		if trimmed != "" {
			note = &trimmed
		}
	}
	return ForwardSpec{
		Protocol:   input.Protocol,
		Port:       port,
		TargetHost: input.TargetHost,
		TargetPort: int(input.TargetPort),
		Note:       note,
	}, nil
}

// forwardPortRangeOf 转发的外部端口区间（含端点）；单端口即起点到自身。
func forwardPortRangeOf(spec ForwardSpec) (start, end int) {
	parts := strings.SplitN(spec.Port, ":", 2)
	s, err := strconv.Atoi(parts[0])
	if err != nil {
		s = 0
	}
	if len(parts) < 2 {
		return s, s
	}
	e, err := strconv.Atoi(parts[1])
	if err != nil {
		e = 0
	}
	return s, e
}

// forwardPortsOverlap 同协议下两条转发的外部端口区间是否重叠（含端点重叠）。
func forwardPortsOverlap(a, b ForwardSpec) bool {
	if a.Protocol != b.Protocol {
		return false
	}
	axStart, axEnd := forwardPortRangeOf(a)
	byStart, byEnd := forwardPortRangeOf(b)
	return axStart <= byEnd && byStart <= axEnd
}

// forwardRowFromSpec 转发规范展开为界面行。
func forwardRowFromSpec(spec ForwardSpec, updatedAt *string) FirewallForwardRule {
	parts := strings.SplitN(spec.Port, ":", 2)
	port, err := strconv.Atoi(parts[0])
	if err != nil {
		port = 0
	}
	var portTo *int
	if len(parts) > 1 {
		end, err := strconv.Atoi(parts[1])
		if err == nil {
			portTo = &end
		}
	}
	return FirewallForwardRule{
		ID:         forwardIdOf(spec),
		Protocol:   spec.Protocol,
		Port:       port,
		PortTo:     portTo,
		TargetHost: spec.TargetHost,
		TargetPort: spec.TargetPort,
		Note:       spec.Note,
		UpdatedAt:  updatedAt,
	}
}
