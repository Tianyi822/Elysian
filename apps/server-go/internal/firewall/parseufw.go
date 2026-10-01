package firewall

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"elysian/server/internal/shared"
)

// ufw 命令输出与规则规范形态的纯解析（parseUfw.ts 等价物）。形状全部取自容器内
// ufw 0.36.2 的真实输出：端口规则（协议+端口）与 IP 规则（纯来源、无端口）两类；
// 规则的唯一身份是规范指纹（动作/方向/协议/端口/来源），界面行 id 再叠加地址族后缀。
// 读不懂的行（目的封禁、出站来源、FWD 等）一律跳过不报错——它们没有界面对应物。

var (
	rePortRange   = regexp.MustCompile(`^\d{1,5}(?::\d{1,5})?$`)
	reRuleID      = regexp.MustCompile(`^(ufw-[a-z]+-(?:in|out)-(?:tcp|udp)-.+)\.(ipv4|ipv6)$`)
	reIpRuleID    = regexp.MustCompile(`^(ufwip-[a-z]+-from-.+)\.(ipv4|ipv6)$`)
	reShowComment = regexp.MustCompile(`^ufw\s+(.*)\s+comment\s+'(.*)'$`)
	reShortForm   = regexp.MustCompile(`^(\d{1,5}(?::\d{1,5})?)/(tcp|udp)$`)
	reStatusLine  = regexp.MustCompile(`(?m)^Status:\s*(\S+)`)
	reDefaultLine = regexp.MustCompile(`(?m)^Default:\s*(\S+)\s+\(incoming\),\s*(\S+)\s+\(outgoing\)`)
	reIpv6Line    = regexp.MustCompile(`(?m)^IPV6=(yes|no)`)
	reStatusRow   = regexp.MustCompile(`^(\S+)(?:\s+\(v6\))?\s+([A-Z]+)(?:\s+(IN|OUT))?\s+(\S+)`)
	reAllCaps     = regexp.MustCompile(`^[A-Z]+$`)
)

// ufwAction 取值：allow | deny | limit | reject。
func isUfwAction(v string) bool {
	return v == "allow" || v == "deny" || v == "limit" || v == "reject"
}

func isFirewallProtocol(v string) bool {
	for _, p := range firewallProtocols {
		if p == v {
			return true
		}
	}
	return false
}

// ufwRuleSpec 端口规则规范：动作/方向/端口（或端口段 '1000:2000'）/协议/来源。
type ufwRuleSpec struct {
	Action    string
	Direction string // in | out
	Port      string
	Proto     string // tcp | udp
	From      string // 'any' 或地址/网段
}

// ufwIpSpec IP 规则规范：只有来源、没有端口（`ufw deny from 203.0.113.9`）。
type ufwIpSpec struct {
	Action    string
	Direction string // 恒 in（出站按来源过滤无意义）
	From      string
}

// parsedUfwLine `ufw show added` 的一行：Kind 为 "port" 或 "ip"。
type parsedUfwLine struct {
	Kind    string
	Spec    ufwRuleSpec
	IpSpec  ufwIpSpec
	Comment *string
}

// ufwStatusRow `ufw status` 规则表的一行；无 (v6) 后缀的行只可能来自 IPv4 账本。
type ufwStatusRow struct {
	To        string
	Action    string
	Direction string // in | out
	From      string
	V6        bool
}

// ufwStatus `ufw status verbose` 的激活态与默认策略。
type ufwStatus struct {
	Active          bool
	DefaultIncoming *string
	DefaultOutgoing *string
}

// ruleIdOf 界面行 id：规范指纹 + 地址族后缀。
func ruleIdOf(spec ufwRuleSpec, family string) string {
	return canonicalId(spec) + "." + family
}

// canonicalId 端口规则规范指纹（from 经 JS encodeURIComponent 转义）。
func canonicalId(spec ufwRuleSpec) string {
	return fmt.Sprintf("ufw-%s-%s-%s-%s-%s", spec.Action, spec.Direction, spec.Proto, spec.Port, jsEncodeURIComponent(spec.From))
}

// ipCanonicalId IP 规则规范指纹。
func ipCanonicalId(spec ufwIpSpec) string {
	return fmt.Sprintf("ufwip-%s-from-%s", spec.Action, jsEncodeURIComponent(spec.From))
}

// ipRuleIdOf IP 规则界面行 id。
func ipRuleIdOf(spec ufwIpSpec) string {
	return ipCanonicalId(spec) + "." + familyOfAddress(spec.From)
}

// parsedRuleId 从界面行 id 取回的端口规则规范与地址族。
type parsedRuleId struct {
	Spec   ufwRuleSpec
	Family string
}

// parsedIpRuleId 从界面行 id 取回的 IP 规则规范与地址族。
type parsedIpRuleId struct {
	Spec   ufwIpSpec
	Family string
}

// parseRuleId 从界面行 id 取回端口规则规范指纹与地址族；不认识的 id 返回 nil。
func parseRuleId(ruleId string) *parsedRuleId {
	m := reRuleID.FindStringSubmatch(ruleId)
	if m == nil {
		return nil
	}
	spec := specFromCanonical(m[1])
	if spec == nil {
		return nil
	}
	return &parsedRuleId{Spec: *spec, Family: m[2]}
}

// parseIpRuleId 从界面行 id 取回 IP 规则规范与地址族；不认识的 id 返回 nil。
func parseIpRuleId(ruleId string) *parsedIpRuleId {
	m := reIpRuleID.FindStringSubmatch(ruleId)
	if m == nil {
		return nil
	}
	parts := strings.Split(m[1], "-")
	action := ""
	if len(parts) > 1 {
		action = parts[1]
	}
	// 前缀是 ufwip-<action>-from- 三段，其余整段是来源（IPv4 含点号，IPv6 含冒号）。
	from, err := jsDecodeURIComponent(strings.Join(parts[min(3, len(parts)):], "-"))
	if err != nil {
		return nil
	}
	if !isUfwAction(action) || from == "" {
		return nil
	}
	return &parsedIpRuleId{Spec: ufwIpSpec{Action: action, Direction: "in", From: from}, Family: m[2]}
}

func specFromCanonical(canonical string) *ufwRuleSpec {
	parts := strings.Split(canonical, "-")
	if len(parts) < 6 {
		return nil
	}
	action := parts[1]
	direction := parts[2]
	proto := parts[3]
	port := parts[4]
	from, err := jsDecodeURIComponent(strings.Join(parts[5:], "-"))
	if err != nil {
		return nil
	}
	if !isUfwAction(action) || (direction != "in" && direction != "out") ||
		!isFirewallProtocol(proto) || !rePortRange.MatchString(port) {
		return nil
	}
	return &ufwRuleSpec{Action: action, Direction: direction, Port: port, Proto: proto, From: from}
}

// familyOfAddress 地址族按地址形态判定：含冒号视为 v6。
func familyOfAddress(address string) string {
	if strings.Contains(address, ":") {
		return "ipv6"
	}
	return "ipv4"
}

// parseShowAdded 解析 `ufw show added` 输出；读不懂的行不返回。
func parseShowAdded(stdout string) []parsedUfwLine {
	parsed := []parsedUfwLine{}
	for _, rawLine := range strings.Split(stdout, "\n") {
		line := strings.TrimSpace(rawLine)
		if !strings.HasPrefix(line, "ufw ") || line == "(None)" {
			continue
		}
		if rule := parseShowAddedLine(line); rule != nil {
			parsed = append(parsed, *rule)
		}
	}
	return parsed
}

func parseShowAddedLine(line string) *parsedUfwLine {
	var body string
	var comment *string
	if m := reShowComment.FindStringSubmatch(line); m != nil {
		body = m[1]
		c := m[2]
		comment = &c
	} else {
		body = line[4:]
	}

	tokens := strings.Fields(body)
	if len(tokens) == 0 {
		return nil
	}

	index := 0
	action := tokens[0]
	if !isUfwAction(action) {
		return nil
	}
	index++

	direction := "in"
	if index < len(tokens) && (tokens[index] == "in" || tokens[index] == "out") {
		direction = tokens[index]
		index++
	}

	rest := tokens[index:]
	if len(rest) == 0 {
		return nil
	}

	// 短形式：22/tcp 或 1000:2000/udp。
	if m := reShortForm.FindStringSubmatch(rest[0]); m != nil && len(rest) == 1 {
		return &parsedUfwLine{
			Kind:    "port",
			Spec:    ufwRuleSpec{Action: action, Direction: direction, Port: m[1], Proto: m[2], From: "any"},
			Comment: comment,
		}
	}

	// 完整形式：from <src> [to any] [port <p>] [proto <proto>]。
	if rest[0] != "from" {
		return nil
	}
	if len(rest) < 2 {
		return nil
	}
	from := rest[1]

	// 出站方向的来源规则（out from）界面对应物是出站端口规则，跳过。
	if direction == "out" {
		return nil
	}

	var port, proto string
	for i := 2; i < len(rest); i += 2 {
		key := rest[i]
		value := ""
		if i+1 < len(rest) {
			value = rest[i+1]
		}
		switch {
		case key == "to":
			// 目的地址非 any 的规则无法用界面呈现与删除。
			if value != "any" {
				return nil
			}
		case key == "port" && value != "":
			port = value
		case key == "proto" && value != "":
			proto = value
		default:
			return nil
		}
	}

	// 无端口即 IP 规则；to any 显式出现与否不影响语义。
	if port == "" {
		return &parsedUfwLine{
			Kind:    "ip",
			IpSpec:  ufwIpSpec{Action: action, Direction: "in", From: from},
			Comment: comment,
		}
	}
	if proto == "" || !rePortRange.MatchString(port) || !isFirewallProtocol(proto) {
		return nil
	}
	return &parsedUfwLine{
		Kind:    "port",
		Spec:    ufwRuleSpec{Action: action, Direction: direction, Port: port, Proto: proto, From: from},
		Comment: comment,
	}
}

// parseStatusVerbose 解析 `ufw status verbose`：只有 Status 行是必需的——ufw 未激活时
// 整个输出只有 `Status: inactive` 一行，默认策略读作未知（null），不替系统编一个。
func parseStatusVerbose(stdout string) (*ufwStatus, error) {
	statusMatch := reStatusLine.FindStringSubmatch(stdout)
	if statusMatch == nil {
		return nil, fmt.Errorf("ufw status 输出无效：缺少 Status 行")
	}
	result := &ufwStatus{Active: statusMatch[1] == "active"}
	if defaultMatch := reDefaultLine.FindStringSubmatch(stdout); defaultMatch != nil {
		in := policyOf(defaultMatch[1])
		out := policyOf(defaultMatch[2])
		result.DefaultIncoming = &in
		result.DefaultOutgoing = &out
	}
	return result, nil
}

// parseIpv6Enabled 读 /etc/default/ufw 的 IPV6 取值（缺省视为 yes）。
func parseIpv6Enabled(defaultUfw string) bool {
	m := reIpv6Line.FindStringSubmatch(defaultUfw)
	return m == nil || m[1] != "no"
}

// parseStatusRows 解析 `ufw status [verbose]` 的规则表（`--` 分隔线之后每行一条）。
// 与 show added（两本账本合并、无地址族信息）不同，status 的行是内核实际装载的规则：
// 无 (v6) 后缀的行只在 IPv4 账本有对应规则时出现——保底判定以此为准。
func parseStatusRows(stdout string) []ufwStatusRow {
	lines := strings.Split(stdout, "\n")
	separatorIndex := -1
	for i, line := range lines {
		if strings.HasPrefix(strings.TrimLeftFunc(line, unicode.IsSpace), "--") {
			separatorIndex = i
			break
		}
	}
	if separatorIndex == -1 {
		return []ufwStatusRow{}
	}
	rows := []ufwStatusRow{}
	for _, rawLine := range lines[separatorIndex+1:] {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		match := reStatusRow.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		action := strings.ToLower(match[2])
		// FWD 等方向与读不懂的动作行没有界面对应物，跳过。
		if !isUfwAction(action) {
			continue
		}
		if match[3] == "" {
			// 无方向词的形态里，From 位置是全大写词且其后还有内容，
			// 说明是 FWD 这类不认识的方向行。
			rest := strings.TrimSpace(line[len(match[0]):])
			if reAllCaps.MatchString(match[4]) && rest != "" {
				continue
			}
		}
		rows = append(rows, ufwStatusRow{
			To:        match[1],
			Action:    action,
			Direction: directionOfStatusRow(match[3]),
			From:      match[4],
			V6:        strings.Contains(match[0], "(v6)"),
		})
	}
	return rows
}

func directionOfStatusRow(word string) string {
	if word == "OUT" {
		return "out"
	}
	return "in"
}

// specToArgs 规范指纹还原成 ufw 删除/添加参数（comment 不参与规则身份）。
func specToArgs(spec ufwRuleSpec) []string {
	args := []string{spec.Action}
	if spec.Direction == "out" {
		args = append(args, "out")
	}
	if spec.From == "any" {
		args = append(args, spec.Port+"/"+spec.Proto)
	} else {
		args = append(args, "from", spec.From, "to", "any", "port", spec.Port, "proto", spec.Proto)
	}
	return args
}

func ipSpecToArgs(spec ufwIpSpec) []string {
	return []string{spec.Action, "from", spec.From}
}

// specFromInput 校验界面输入并映射为 ufw 规范；不合法抛中文 400，不进 shell。
func specFromInput(input RuleInput) (ufwRuleSpec, error) {
	if !jsIsInteger(input.Port) || input.Port < 1 || input.Port > 65535 {
		return ufwRuleSpec{}, shared.InvalidRequest(fmt.Sprintf("端口无效：%s（应为 1–65535 的整数）", jsNumberToString(input.Port)))
	}
	if input.PortTo != nil {
		if !jsIsInteger(*input.PortTo) || *input.PortTo < 1 || *input.PortTo > 65535 {
			return ufwRuleSpec{}, shared.InvalidRequest(fmt.Sprintf("端口段结束无效：%s（应为 1–65535 的整数）", jsNumberToString(*input.PortTo)))
		}
		if *input.PortTo < input.Port {
			return ufwRuleSpec{}, shared.InvalidRequest(fmt.Sprintf("端口段无效：结束端口 %s 小于起始端口 %s", jsNumberToString(*input.PortTo), jsNumberToString(input.Port)))
		}
	}
	if !isFirewallProtocol(input.Protocol) {
		return ufwRuleSpec{}, shared.InvalidRequest(fmt.Sprintf("协议无效：%s", input.Protocol))
	}
	if input.Policy != "allow" && input.Policy != "deny" && input.Policy != "limit" {
		return ufwRuleSpec{}, shared.InvalidRequest(fmt.Sprintf("策略无效：%s", input.Policy))
	}
	source := strings.TrimSpace(input.Source)
	if source != SourceAllIPs && !isValidFirewallAddress(source) {
		return ufwRuleSpec{}, shared.InvalidRequest(fmt.Sprintf("来源无效：%s（应为「%s」或合法 IP/网段）", source, SourceAllIPs))
	}
	// 备注以单引号包进 ufw comment 参数：换行/控制字符与单引号都会写坏规则。
	if err := assertNoteSafe(input.Note, noteSceneUfw); err != nil {
		return ufwRuleSpec{}, err
	}
	port := strconv.FormatInt(int64(input.Port), 10)
	if input.PortTo != nil {
		port = fmt.Sprintf("%s:%s", port, strconv.FormatInt(int64(*input.PortTo), 10))
	}
	from := source
	if source == SourceAllIPs {
		from = "any"
	}
	return ufwRuleSpec{
		Action:    input.Policy,
		Direction: directionOfInput(input.Direction),
		Port:      port,
		Proto:     input.Protocol,
		From:      from,
	}, nil
}

func directionOfInput(direction string) string {
	if direction == "outbound" {
		return "out"
	}
	return "in"
}

// ipSpecFromInput IP 规则输入校验：来源必须是具体地址或网段，不允许「所有IP」。
func ipSpecFromInput(input IpRuleInput) (ufwIpSpec, error) {
	if input.Policy != "allow" && input.Policy != "deny" && input.Policy != "limit" {
		return ufwIpSpec{}, shared.InvalidRequest(fmt.Sprintf("策略无效：%s", input.Policy))
	}
	source := strings.TrimSpace(input.Source)
	if !isValidFirewallAddress(source) || source == "any" {
		return ufwIpSpec{}, shared.InvalidRequest(fmt.Sprintf("来源无效：%s（应为合法 IP 或网段）", source))
	}
	if err := assertNoteSafe(input.Note, noteSceneUfw); err != nil {
		return ufwIpSpec{}, err
	}
	return ufwIpSpec{Action: input.Policy, Direction: "in", From: source}, nil
}

var (
	reV6Address = regexp.MustCompile(`^[0-9a-fA-F:]+(?:/\d{1,3})?$`)
	reV4CIDR    = regexp.MustCompile(`^([\d.]+)(?:/(\d{1,2}))?$`)
	reOctet     = regexp.MustCompile(`^\d{1,3}$`)
)

// isValidFirewallAddress 接受 IPv4/IPv6 地址或 CIDR 网段。
func isValidFirewallAddress(value string) bool {
	if strings.Contains(value, ":") {
		return reV6Address.MatchString(value)
	}
	cidr := reV4CIDR.FindStringSubmatch(value)
	if cidr == nil {
		return false
	}
	octets := strings.Split(cidr[1], ".")
	if len(octets) != 4 {
		return false
	}
	for _, octet := range octets {
		if !reOctet.MatchString(octet) {
			return false
		}
		n, err := strconv.Atoi(octet)
		if err != nil || n > 255 {
			return false
		}
	}
	if cidr[2] != "" {
		n, err := strconv.Atoi(cidr[2])
		if err != nil || n > 32 {
			return false
		}
	}
	return true
}

// ruleRowContext 界面行展开上下文。
type ruleRowContext struct {
	// /etc/default/ufw 的 IPV6 取值决定 any 规则是否派生双行。
	Ipv6Enabled bool
	// ss 解析出的监听键集合（`tcp:22`）。
	Listeners map[string]bool
	// 规则最近变更时间（规范指纹 → ISO 时间；无记录回 nil）。
	TimeOf func(canonical string) *string
}

// ruleRowsFromSpec 一条 ufw 规范展开成界面行；来源为 any 且启用 IPv6 时派生 v4/v6 两行。
func ruleRowsFromSpec(spec ufwRuleSpec, comment *string, context ruleRowContext) []FirewallRule {
	families := rowFamiliesOf(spec, context.Ipv6Enabled)
	start := displayPortOf(spec)
	end := portToOf(spec)
	key := fmt.Sprintf("%s:%s", spec.Proto, strconv.FormatInt(int64(start), 10))
	status := "unused"
	if context.Listeners[key] {
		status = "normal"
	}
	updatedAt := context.TimeOf(canonicalId(spec))
	note := comment
	if end != nil {
		rangeNote := fmt.Sprintf("端口段 %s", spec.Port)
		if comment != nil && *comment != "" {
			merged := fmt.Sprintf("%s；%s", rangeNote, *comment)
			note = &merged
		} else {
			note = &rangeNote
		}
	}

	source := spec.From
	if source == "any" {
		source = SourceAllIPs
	}
	port := int(start)
	var portTo *int
	if end != nil {
		v := int(*end)
		portTo = &v
	}
	rows := make([]FirewallRule, 0, len(families))
	for _, family := range families {
		rows = append(rows, FirewallRule{
			ID:        ruleIdOf(spec, family),
			Protocol:  spec.Proto,
			Port:      port,
			PortTo:    portTo,
			Family:    family,
			Status:    status,
			Policy:    policyOf(spec.Action),
			Direction: directionOfRow(spec.Direction),
			Source:    source,
			Note:      note,
			UpdatedAt: updatedAt,
		})
	}
	return rows
}

func directionOfRow(direction string) string {
	if direction == "out" {
		return "outbound"
	}
	return "inbound"
}

// ipRuleRowFromSpec IP 规则规范展开成界面行：地址族由来源地址形态决定，单行。
func ipRuleRowFromSpec(spec ufwIpSpec, comment *string, context ruleRowContext) FirewallIpRule {
	return FirewallIpRule{
		ID:        ipRuleIdOf(spec),
		Source:    spec.From,
		Family:    familyOfAddress(spec.From),
		Policy:    policyOf(spec.Action),
		Note:      comment,
		UpdatedAt: context.TimeOf(ipCanonicalId(spec)),
	}
}

func rowFamiliesOf(spec ufwRuleSpec, ipv6Enabled bool) []string {
	if spec.From != "any" {
		if strings.Contains(spec.From, ":") {
			return []string{"ipv6"}
		}
		return []string{"ipv4"}
	}
	if ipv6Enabled {
		return []string{"ipv4", "ipv6"}
	}
	return []string{"ipv4"}
}

// displayPortOf 端口段用起始端口参与监听匹配与呈现，备注里保留完整端口段。
func displayPortOf(spec ufwRuleSpec) float64 {
	parts := strings.SplitN(spec.Port, ":", 2)
	if parts[0] == "" {
		return 0
	}
	n, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return math.NaN()
	}
	return n
}

// portToOf 端口段的结束端口；单端口返回 nil。
func portToOf(spec ufwRuleSpec) *float64 {
	parts := strings.SplitN(spec.Port, ":", 2)
	if len(parts) < 2 {
		return nil
	}
	n, err := strconv.ParseFloat(parts[1], 64)
	if err != nil {
		return nil
	}
	return &n
}

// policyOf 动作到界面策略：deny/reject → deny，limit → limit，其余 allow。
func policyOf(action string) string {
	if action == "deny" || action == "reject" {
		return "deny"
	}
	if action == "limit" {
		return "limit"
	}
	return "allow"
}
