package firewall

import (
	"fmt"

	"elysian/server/internal/shared"
)

// 累计上限：规则文件不能被无限写大（ufw 装载变慢、面板列表失焦）。
const (
	firewallLimitUserRules = 200 // 端口规则（ufw 用户规则）
	firewallLimitIpRules   = 200 // IP 规则
	firewallLimitForwards  = 32  // 端口转发
)

func portLinesOf(state *hostState) []parsedUfwLine {
	out := []parsedUfwLine{}
	for _, line := range state.lines {
		if line.Kind == "port" {
			out = append(out, line)
		}
	}
	return out
}

func ipLinesOf(state *hostState) []parsedUfwLine {
	out := []parsedUfwLine{}
	for _, line := range state.lines {
		if line.Kind == "ip" {
			out = append(out, line)
		}
	}
	return out
}

func (s *service) timeOf(canonical string) *string {
	s.memMu.Lock()
	at, ok := s.updatedAtMap[canonical]
	s.memMu.Unlock()
	if ok {
		return &at
	}
	if times := s.deps.RuleTimes(); times != nil {
		if persisted, ok := times.Get(canonical); ok {
			return &persisted
		}
	}
	return nil
}

func (s *service) touch(canonical string) string {
	at := s.deps.NowIso()
	s.memMu.Lock()
	s.updatedAtMap[canonical] = at
	s.memMu.Unlock()
	if times := s.deps.RuleTimes(); times != nil {
		times.Set(canonical, at)
	}
	return at
}

func (s *service) removeTouch(canonical string) {
	s.memMu.Lock()
	delete(s.updatedAtMap, canonical)
	s.memMu.Unlock()
	if times := s.deps.RuleTimes(); times != nil {
		times.Remove(canonical)
	}
}

func (s *service) rowContext(state *hostState) ruleRowContext {
	return ruleRowContext{
		Ipv6Enabled: state.ipv6Enabled,
		Listeners:   state.listeners,
		TimeOf:      s.timeOf,
	}
}

func (s *service) rulesOf(state *hostState) []FirewallRule {
	rows := []FirewallRule{}
	for _, line := range portLinesOf(state) {
		rows = append(rows, ruleRowsFromSpec(line.Spec, line.Comment, s.rowContext(state))...)
	}
	return rows
}

func (s *service) ipRulesOf(state *hostState) []FirewallIpRule {
	rows := []FirewallIpRule{}
	for _, line := range ipLinesOf(state) {
		rows = append(rows, ipRuleRowFromSpec(line.IpSpec, line.Comment, s.rowContext(state)))
	}
	return rows
}

func (s *service) forwardsOf(state *hostState) []FirewallForwardRule {
	rows := []FirewallForwardRule{}
	for _, spec := range parseForwardSection(state.beforeRules) {
		rows = append(rows, forwardRowFromSpec(spec, s.timeOf(forwardIdOf(spec))))
	}
	return rows
}

// findDuplicate 端口规则唯一性：同协议同方向同起始端口视为重复（与真实防火墙呈现
// 一致；IPv4 与 IPv6 由同一条规则覆盖）。
func (s *service) findDuplicate(state *hostState, input RuleInput, exceptCanonical string) *parsedUfwLine {
	direction := directionOfInput(input.Direction)
	lines := portLinesOf(state)
	for i := range lines {
		line := &lines[i]
		if canonicalId(line.Spec) != exceptCanonical &&
			line.Spec.Proto == input.Protocol &&
			line.Spec.Direction == direction &&
			displayPortOf(line.Spec) == input.Port {
			return line
		}
	}
	return nil
}

func commentArgs(comment *string) []string {
	if comment != nil && *comment != "" {
		return []string{"comment", *comment}
	}
	return nil
}

func firstRow(rows []FirewallRule) (FirewallRule, error) {
	if len(rows) == 0 {
		return FirewallRule{}, fmt.Errorf("规则行生成失败：没有可用地址族")
	}
	return rows[0], nil
}

// ---------- FirewallAdapter 方法 ----------

// List 端口规则全量。
func (s *service) List() ([]FirewallRule, error) {
	state, err := s.readState()
	if err != nil {
		return nil, err
	}
	return s.rulesOf(state), nil
}

// ListIpRules IP 规则全量。
func (s *service) ListIpRules() ([]FirewallIpRule, error) {
	state, err := s.readState()
	if err != nil {
		return nil, err
	}
	return s.ipRulesOf(state), nil
}

// ListForwards 转发全量。
func (s *service) ListForwards() ([]FirewallForwardRule, error) {
	state, err := s.readState()
	if err != nil {
		return nil, err
	}
	return s.forwardsOf(state), nil
}

// Create 新建端口规则。
func (s *service) Create(input RuleInput) (FirewallRule, error) {
	if err := s.protectPorts(input); err != nil {
		return FirewallRule{}, err
	}
	spec, err := specFromInput(input)
	if err != nil {
		return FirewallRule{}, err
	}
	state, err := s.readState()
	if err != nil {
		return FirewallRule{}, err
	}
	if s.findDuplicate(state, input, "") != nil {
		// ufw 的端口规则一条就覆盖 IPv4/IPv6 两端：判重不看输入的地址族，
		// 报错讲清这条语义，避免让用户以为存在一条列表里看不见的 ipv6 规则。
		return FirewallRule{}, shared.Conflict(fmt.Sprintf("端口规则已存在：%s %s（IPv4 与 IPv6 由同一条规则覆盖，不能按地址族重复添加）", input.Protocol, jsNumberToString(input.Port)))
	}
	if len(portLinesOf(state)) >= firewallLimitUserRules {
		return FirewallRule{}, fmt.Errorf("端口规则已达上限（最多 %d 条）：请先删除不再需要的规则", firewallLimitUserRules)
	}
	args := append(specToArgs(spec), commentArgs(input.Note)...)
	if _, err := s.runUfw(args); err != nil {
		return FirewallRule{}, err
	}
	s.touch(canonicalId(spec))
	fresh, err := s.readState()
	if err != nil {
		return FirewallRule{}, err
	}
	return firstRow(ruleRowsFromSpec(spec, input.Note, s.rowContext(fresh)))
}

// Update 修改端口规则。
func (s *service) Update(ruleId string, input RuleInput) (FirewallRule, error) {
	if err := s.protectPorts(input); err != nil {
		return FirewallRule{}, err
	}
	parsed := parseRuleId(ruleId)
	if parsed == nil {
		return FirewallRule{}, fmt.Errorf("无效的规则标识：%s", ruleId)
	}
	state, err := s.readState()
	if err != nil {
		return FirewallRule{}, err
	}
	oldCanonical := canonicalId(parsed.Spec)
	exists := false
	for _, line := range portLinesOf(state) {
		if canonicalId(line.Spec) == oldCanonical {
			exists = true
			break
		}
	}
	if !exists {
		return FirewallRule{}, fmt.Errorf("未找到端口规则 %s（可能已在系统侧变更，请先同步）", ruleId)
	}

	spec, err := specFromInput(input)
	if err != nil {
		return FirewallRule{}, err
	}
	nextCanonical := canonicalId(spec)
	// 系统入口规则禁止通过面板修改，避免删除再创建期间丢失入口。
	if oldCanonical == s.panelCanonical {
		return FirewallRule{}, fmt.Errorf("面板端口规则不允许变更：它是保证工作台可访问的保底规则")
	}
	if s.findDuplicate(state, input, oldCanonical) != nil {
		return FirewallRule{}, shared.Conflict(fmt.Sprintf("端口规则已存在：%s %s（IPv4 与 IPv6 由同一条规则覆盖，不能按地址族重复添加）", input.Protocol, jsNumberToString(input.Port)))
	}

	if nextCanonical == oldCanonical {
		// 只改备注：先删后建（同规范规则 ufw 不允许并存）。
		if _, err := s.runUfw(append([]string{"delete"}, specToArgs(parsed.Spec)...)); err != nil {
			return FirewallRule{}, err
		}
		if _, err := s.runUfw(append(specToArgs(spec), commentArgs(input.Note)...)); err != nil {
			return FirewallRule{}, err
		}
	} else {
		// 先建后删：新建失败时旧规则保持原样。
		if _, err := s.runUfw(append(specToArgs(spec), commentArgs(input.Note)...)); err != nil {
			return FirewallRule{}, err
		}
		if _, err := s.runUfw(append([]string{"delete"}, specToArgs(parsed.Spec)...)); err != nil {
			return FirewallRule{}, err
		}
	}
	s.removeTouch(oldCanonical)
	s.touch(nextCanonical)

	fresh, err := s.readState()
	if err != nil {
		return FirewallRule{}, err
	}
	return firstRow(ruleRowsFromSpec(spec, input.Note, s.rowContext(fresh)))
}

// Remove 删除端口规则。
func (s *service) Remove(ruleId string) error {
	parsed := parseRuleId(ruleId)
	if parsed == nil {
		return fmt.Errorf("无效的规则标识：%s", ruleId)
	}
	if canonicalId(parsed.Spec) == s.panelCanonical {
		return fmt.Errorf("面板端口规则不允许删除：它是保证工作台可访问的保底规则")
	}
	state, err := s.readState()
	if err != nil {
		return err
	}
	exists := false
	for _, line := range portLinesOf(state) {
		if canonicalId(line.Spec) == canonicalId(parsed.Spec) {
			exists = true
			break
		}
	}
	if !exists {
		return fmt.Errorf("未找到端口规则 %s（可能已在系统侧变更，请先同步）", ruleId)
	}
	if _, err := s.runUfw(append([]string{"delete"}, specToArgs(parsed.Spec)...)); err != nil {
		return err
	}
	s.removeTouch(canonicalId(parsed.Spec))
	return nil
}

// CreateIpRule 新建 IP 规则。
func (s *service) CreateIpRule(input IpRuleInput) (FirewallIpRule, error) {
	spec, err := ipSpecFromInput(input)
	if err != nil {
		return FirewallIpRule{}, err
	}
	state, err := s.readState()
	if err != nil {
		return FirewallIpRule{}, err
	}
	for _, line := range ipLinesOf(state) {
		if ipCanonicalId(line.IpSpec) == ipCanonicalId(spec) {
			return FirewallIpRule{}, shared.Conflict(fmt.Sprintf("IP 规则已存在：%s", input.Source))
		}
	}
	if len(ipLinesOf(state)) >= firewallLimitIpRules {
		return FirewallIpRule{}, fmt.Errorf("IP 规则已达上限（最多 %d 条）：请先删除不再需要的规则", firewallLimitIpRules)
	}
	if _, err := s.runUfw(append(ipSpecToArgs(spec), commentArgs(input.Note)...)); err != nil {
		return FirewallIpRule{}, err
	}
	s.touch(ipCanonicalId(spec))
	fresh, err := s.readState()
	if err != nil {
		return FirewallIpRule{}, err
	}
	return ipRuleRowFromSpec(spec, input.Note, s.rowContext(fresh)), nil
}

// UpdateIpRule 修改 IP 规则。
func (s *service) UpdateIpRule(ruleId string, input IpRuleInput) (FirewallIpRule, error) {
	parsed := parseIpRuleId(ruleId)
	if parsed == nil {
		return FirewallIpRule{}, fmt.Errorf("无效的 IP 规则标识：%s", ruleId)
	}
	state, err := s.readState()
	if err != nil {
		return FirewallIpRule{}, err
	}
	oldCanonical := ipCanonicalId(parsed.Spec)
	exists := false
	for _, line := range ipLinesOf(state) {
		if ipCanonicalId(line.IpSpec) == oldCanonical {
			exists = true
			break
		}
	}
	if !exists {
		return FirewallIpRule{}, fmt.Errorf("未找到 IP 规则 %s（可能已在系统侧变更，请先同步）", ruleId)
	}

	spec, err := ipSpecFromInput(input)
	if err != nil {
		return FirewallIpRule{}, err
	}
	for _, line := range ipLinesOf(state) {
		if ipCanonicalId(line.IpSpec) == ipCanonicalId(spec) && ipCanonicalId(line.IpSpec) != oldCanonical {
			return FirewallIpRule{}, shared.Conflict(fmt.Sprintf("IP 规则已存在：%s", input.Source))
		}
	}
	// ufw 无原地修改：先建新、再删旧；新旧行相同（只改备注）时退化为先删后建。
	if ipCanonicalId(spec) == oldCanonical {
		if _, err := s.runUfw(append([]string{"delete"}, ipSpecToArgs(parsed.Spec)...)); err != nil {
			return FirewallIpRule{}, err
		}
		if _, err := s.runUfw(append(ipSpecToArgs(spec), commentArgs(input.Note)...)); err != nil {
			return FirewallIpRule{}, err
		}
	} else {
		if _, err := s.runUfw(append(ipSpecToArgs(spec), commentArgs(input.Note)...)); err != nil {
			return FirewallIpRule{}, err
		}
		if _, err := s.runUfw(append([]string{"delete"}, ipSpecToArgs(parsed.Spec)...)); err != nil {
			return FirewallIpRule{}, err
		}
	}
	s.removeTouch(oldCanonical)
	s.touch(ipCanonicalId(spec))
	fresh, err := s.readState()
	if err != nil {
		return FirewallIpRule{}, err
	}
	return ipRuleRowFromSpec(spec, input.Note, s.rowContext(fresh)), nil
}

// RemoveIpRule 删除 IP 规则。
func (s *service) RemoveIpRule(ruleId string) error {
	parsed := parseIpRuleId(ruleId)
	if parsed == nil {
		return fmt.Errorf("无效的 IP 规则标识：%s", ruleId)
	}
	state, err := s.readState()
	if err != nil {
		return err
	}
	exists := false
	for _, line := range ipLinesOf(state) {
		if ipCanonicalId(line.IpSpec) == ipCanonicalId(parsed.Spec) {
			exists = true
			break
		}
	}
	if !exists {
		return fmt.Errorf("未找到 IP 规则 %s（可能已在系统侧变更，请先同步）", ruleId)
	}
	if _, err := s.runUfw(append([]string{"delete"}, ipSpecToArgs(parsed.Spec)...)); err != nil {
		return err
	}
	s.removeTouch(ipCanonicalId(parsed.Spec))
	return nil
}

// CreateForward 新建端口转发。
func (s *service) CreateForward(input ForwardInput) (FirewallForwardRule, error) {
	var row FirewallForwardRule
	err := s.serialize(func() error {
		spec, err := specFromForwardInput(input, s.panelPort, s.backendPort, s.entryPort)
		if err != nil {
			return err
		}
		state, err := s.readState()
		if err != nil {
			return err
		}
		existing := parseForwardSection(state.beforeRules)
		if len(existing) >= firewallLimitForwards {
			return fmt.Errorf("端口转发已达上限（最多 %d 条）：请先删除不再需要的转发", firewallLimitForwards)
		}
		for _, candidate := range existing {
			if forwardPortsOverlap(candidate, spec) {
				return shared.Conflict(fmt.Sprintf("端口转发已存在：%s %s 与既有转发 %s %s 的端口区间重叠", spec.Protocol, spec.Port, candidate.Protocol, candidate.Port))
			}
		}
		if err := s.writeForwards(append(existing, spec)); err != nil {
			return err
		}
		s.touch(forwardIdOf(spec))
		row = forwardRowFromSpec(spec, s.timeOf(forwardIdOf(spec)))
		return nil
	})
	if err != nil {
		return FirewallForwardRule{}, err
	}
	return row, nil
}

// UpdateForward 修改端口转发（段整体重写，新旧替换一次完成，无中间态）。
func (s *service) UpdateForward(ruleId string, input ForwardInput) (FirewallForwardRule, error) {
	var row FirewallForwardRule
	err := s.serialize(func() error {
		oldSpec := parseForwardId(ruleId)
		if oldSpec == nil {
			return fmt.Errorf("无效的转发标识：%s", ruleId)
		}
		state, err := s.readState()
		if err != nil {
			return err
		}
		existing := parseForwardSection(state.beforeRules)
		oldId := forwardIdOf(*oldSpec)
		found := false
		for _, candidate := range existing {
			if forwardIdOf(candidate) == oldId {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("未找到端口转发 %s（可能已在系统侧变更，请先同步）", ruleId)
		}
		spec, err := specFromForwardInput(input, s.panelPort, s.backendPort, s.entryPort)
		if err != nil {
			return err
		}
		for _, candidate := range existing {
			if forwardIdOf(candidate) != oldId && forwardPortsOverlap(candidate, spec) {
				return shared.Conflict(fmt.Sprintf("端口转发已存在：%s %s 与既有转发 %s %s 的端口区间重叠", spec.Protocol, spec.Port, candidate.Protocol, candidate.Port))
			}
		}
		next := []ForwardSpec{}
		for _, candidate := range existing {
			if forwardIdOf(candidate) != oldId {
				next = append(next, candidate)
			}
		}
		if err := s.writeForwards(append(next, spec)); err != nil {
			return err
		}
		s.removeTouch(oldId)
		s.touch(forwardIdOf(spec))
		row = forwardRowFromSpec(spec, s.timeOf(forwardIdOf(spec)))
		return nil
	})
	if err != nil {
		return FirewallForwardRule{}, err
	}
	return row, nil
}

// RemoveForward 删除端口转发。
func (s *service) RemoveForward(ruleId string) error {
	return s.serialize(func() error {
		oldSpec := parseForwardId(ruleId)
		if oldSpec == nil {
			return fmt.Errorf("无效的转发标识：%s", ruleId)
		}
		state, err := s.readState()
		if err != nil {
			return err
		}
		existing := parseForwardSection(state.beforeRules)
		oldId := forwardIdOf(*oldSpec)
		found := false
		for _, candidate := range existing {
			if forwardIdOf(candidate) == oldId {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("未找到端口转发 %s（可能已在系统侧变更，请先同步）", ruleId)
		}
		next := []ForwardSpec{}
		for _, candidate := range existing {
			if forwardIdOf(candidate) != oldId {
				next = append(next, candidate)
			}
		}
		if err := s.writeForwards(next); err != nil {
			return err
		}
		s.removeTouch(oldId)
		return nil
	})
}

// SyncFromSystem 从承载本面板的操作系统同步防火墙规则：返回三类规则行总数。
func (s *service) SyncFromSystem() (int, error) {
	state, err := s.readState()
	if err != nil {
		return 0, err
	}
	return len(s.rulesOf(state)) + len(s.ipRulesOf(state)) + len(s.forwardsOf(state)), nil
}

func (s *service) protectPorts(input RuleInput) error {
	if input.Direction == "outbound" || input.Protocol == "udp" {
		return nil
	}
	if (input.Policy == "allow" || input.Policy == "limit") && coversPanelPort(input.Port, input.PortTo, s.backendPort) {
		return shared.InvalidRequest("面板后端端口只供本机访问，不能添加入站放行规则")
	}
	if input.Policy == "deny" && (coversPanelPort(input.Port, input.PortTo, s.panelPort) || coversPanelPort(input.Port, input.PortTo, s.entryPort)) {
		return shared.InvalidRequest("面板端口规则不允许变更：不能封禁面板前端端口")
	}
	return nil
}
