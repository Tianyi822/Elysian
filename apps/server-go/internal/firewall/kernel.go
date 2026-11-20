package firewall

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"elysian/server/internal/contract"
)

// hostState 一次读状态快照。
type hostState struct {
	active          bool
	defaultIncoming *string
	defaultOutgoing *string
	ipv6Enabled     bool
	pingBlocked     bool
	lines           []parsedUfwLine
	listeners       map[string]bool
	beforeRules     string
}

// runUfw 包一层执行失败的中文错误：detail 优先取 stderr。
func (s *service) runUfw(args []string) (string, error) {
	out, err := s.deps.RunUfw(args)
	if err != nil {
		return "", fmt.Errorf("ufw 执行失败（%s）：%v", strings.Join(args, " "), err)
	}
	return out, nil
}

func (s *service) readState() (*hostState, error) {
	verbose, err := s.runUfw([]string{"status", "verbose"})
	if err != nil {
		return nil, err
	}
	added, err := s.runUfw([]string{"show", "added"})
	if err != nil {
		return nil, err
	}
	defaultUfw, err := s.deps.ReadText(s.paths.DefaultUfw)
	if err != nil {
		return nil, err
	}
	ssOut, err := s.deps.RunSs()
	if err != nil {
		return nil, err
	}
	beforeRules, err := s.deps.ReadText(s.paths.BeforeRules)
	if err != nil {
		return nil, err
	}
	status, err := parseStatusVerbose(verbose)
	if err != nil {
		return nil, err
	}
	return &hostState{
		active:          status.Active,
		defaultIncoming: status.DefaultIncoming,
		defaultOutgoing: status.DefaultOutgoing,
		ipv6Enabled:     parseIpv6Enabled(defaultUfw),
		pingBlocked:     parsePingBlocked(beforeRules),
		lines:           parseShowAdded(added),
		listeners:       parseSsListening(ssOut),
		beforeRules:     beforeRules,
	}, nil
}

func (s *service) togglesOf(state *hostState) FirewallToggles {
	return FirewallToggles{
		FirewallEnabled: state.active,
		PingBlocked:     state.pingBlocked,
		DefaultIncoming: state.defaultIncoming,
		DefaultOutgoing: state.defaultOutgoing,
	}
}

// hasPanelAllowRow status 规则表里存在面板端口的 IPv4 入站放行行（来源不限）。
func hasPanelAllowRow(rows []ufwStatusRow, ports ...int) bool {
	panelPort := defaultPort(ports)
	for _, row := range rows {
		if !row.V6 && row.Action == "allow" && row.Direction == "in" &&
			row.To == fmt.Sprintf("%d/tcp", panelPort) && row.From == "Anywhere" {
			return true
		}
	}
	return false
}

// hasPortAllowLine 规则账本里存在该端口的入站 TCP 放行规则（精确单端口；端口段不算）。
func hasPortAllowLine(lines []parsedUfwLine, port int) bool {
	for _, line := range lines {
		if line.Kind == "port" &&
			line.Spec.Action == "allow" &&
			line.Spec.Direction == "in" &&
			line.Spec.Proto == "tcp" &&
			line.Spec.Port == strconv.Itoa(port) {
			return true
		}
	}
	return false
}

// ensurePanelRule 核验 IPv4 与已启用的 IPv6；不改变 UFW 的启停状态。
func ensurePanelRule(deps hostDeps, ports ...int) error {
	port := defaultPort(ports)
	defaults, err := deps.ReadText(deps.Paths().DefaultUfw)
	if err != nil {
		return fmt.Errorf("读取 UFW 地址族配置失败：%w", err)
	}
	ipv6 := parseIpv6Enabled(defaults)
	protected := func(text string) bool {
		rows := parseStatusRows(text)
		if !hasPanelAllowRow(rows, port) {
			return false
		}
		if !ipv6 {
			return true
		}
		for _, row := range rows {
			if row.V6 && row.Action == "allow" && row.Direction == "in" && row.To == fmt.Sprintf("%d/tcp", port) && row.From == "Anywhere" {
				return true
			}
		}
		return false
	}
	before, err := deps.RunUfw([]string{"status", "verbose"})
	if err != nil {
		return err
	}
	status, err := parseStatusVerbose(before)
	if err != nil {
		return err
	}
	if status.Active && protected(before) {
		return nil
	}
	if _, err := deps.RunUfw([]string{"allow", fmt.Sprintf("%d/tcp", port), "comment", "Elysian 面板"}); err != nil {
		return err
	}
	after, err := deps.RunUfw([]string{"status", "verbose"})
	if err != nil {
		return err
	}
	status, err = parseStatusVerbose(after)
	if err != nil {
		return err
	}
	if status.Active && !protected(after) {
		return fmt.Errorf("面板端口保底规则未生效：%d/tcp 缺少 IPv4 或已启用的 IPv6 放行规则，请检查 UFW 规则", port)
	}
	return nil
}

// ensurePortRule 端口自动开放（网站直连项目 / 任意主机访问的数据库创建时调用）：
// 防火墙页管理的同一份 ufw 里幂等补一条入站 TCP 放行规则。与 Create 不同，这里不
// 报错——结果以 FirewallPortSync 带回创建响应；写入后必须能在账本里复核到。
func ensurePortRule(deps hostDeps, port int, note string) contract.FirewallPortSync {
	failed := func(detail string) contract.FirewallPortSync {
		return contract.FirewallPortSync{State: contract.FirewallPortSyncFailed, Port: port, Detail: &detail}
	}
	added, err := deps.RunUfw([]string{"show", "added"})
	if err != nil {
		return failed(err.Error())
	}
	lines := parseShowAdded(added)
	if hasPortAllowLine(lines, port) {
		detail := "防火墙已有该端口的放行规则"
		return contract.FirewallPortSync{State: contract.FirewallPortSyncSkipped, Port: port, Detail: &detail}
	}
	portCount := 0
	for _, line := range lines {
		if line.Kind == "port" {
			portCount++
		}
	}
	if portCount >= firewallLimitUserRules {
		return failed(fmt.Sprintf("端口规则已达上限（最多 %d 条），请先删除不再需要的规则", firewallLimitUserRules))
	}
	if _, err := deps.RunUfw([]string{"allow", fmt.Sprintf("%d/tcp", port), "comment", note}); err != nil {
		return failed(err.Error())
	}
	recheck, err := deps.RunUfw([]string{"show", "added"})
	if err != nil {
		return failed(err.Error())
	}
	if !hasPortAllowLine(parseShowAdded(recheck), port) {
		return failed(fmt.Sprintf("ufw allow 执行后规则账本仍无 %d/tcp，请到安全页核对", port))
	}
	return contract.FirewallPortSync{State: contract.FirewallPortSyncOpened, Port: port, Detail: nil}
}

// patchPing 禁 ping 双栈改写（文件不存在的那份跳过）。
func (s *service) patchPing(blocked bool) error {
	for _, path := range []string{s.paths.BeforeRules, s.paths.BeforeRulesV6} {
		if !s.deps.Exists(path) {
			continue
		}
		text, err := s.deps.ReadText(path)
		if err != nil {
			return err
		}
		if err := writeRulesFileWithBackup(s.deps, path, setPingBlocked(text, blocked)); err != nil {
			return err
		}
	}
	return nil
}

// ensureIpForward 确保内核转发开启。容器里 /proc/sys 常以只读挂载（且 Docker 默认已
// 置 1），因此先读现状：已经是 1 就直接通过；读失败（只读挂载不可见）也直接过；
// 需改而写不进去时给出可诊断的中文错误。只在有转发规则时确保开启，移除最后一条
// 转发不强制关闭——转发开关可能被别的 NAT 场景共用，面板不越权关掉它。
func (s *service) ensureIpForward() error {
	current, err := s.deps.ReadText(IPForwardPath)
	if err != nil {
		return nil
	}
	if strings.TrimSpace(current) == "1" {
		return nil
	}
	if err := s.deps.WriteText(IPForwardPath, "1\n"); err != nil {
		return fmt.Errorf("内核转发未开启且不可写（%s 当前为 %s）：%v。请在宿主机为容器开启 net.ipv4.ip_forward=1 后重试",
			IPForwardPath, strings.TrimSpace(current), err)
	}
	return nil
}

// applyForwardsToKernel 把转发段精确落到内核 nat 表：PREROUTING 的 DNAT 与
// POSTROUTING 的 MASQUERADE 都按 comment 标记先删净、再按段重建。不依赖 ufw
// reload——ufw 以 --noflush 应用 before.rules 的 nat 段，reload 与重复 enable 只会让
// 内核里的条目越积越多。
func (s *service) applyForwardsToKernel(specs []ForwardSpec) error {
	chains := []struct {
		name   string
		argsOf func(ForwardSpec) []string
	}{
		{name: "PREROUTING", argsOf: natRuleArgsOf},
		{name: "POSTROUTING", argsOf: postRoutingArgsOf},
	}
	for _, chain := range chains {
		listing, err := s.deps.RunIptables([]string{"-t", "nat", "-L", chain.name, "-n", "--line-numbers"})
		if err != nil {
			return err
		}
		numbers := parseOurNatRuleNumbers(listing)
		// 行号从大到小删：删前面的会让后面的行号前移。
		for i := len(numbers) - 1; i >= 0; i-- {
			if _, err := s.deps.RunIptables([]string{"-t", "nat", "-D", chain.name, strconv.Itoa(numbers[i])}); err != nil {
				return err
			}
		}
		for _, spec := range specs {
			args := append([]string{"-t", "nat", "-A", chain.name}, chain.argsOf(spec)...)
			if _, err := s.deps.RunIptables(args); err != nil {
				return err
			}
		}
	}
	return nil
}

// writeForwards 重写端口转发：nat 段（文件最前）与 forward 放行段（filter 块内）一起
// 落盘，nat 精确落到内核，激活时再走完整 disable→enable 让放行段生效。specs 为空则
// 两段移除、内核里的本面板规则删净。
func (s *service) writeForwards(specs []ForwardSpec) error {
	text, err := s.deps.ReadText(s.paths.BeforeRules)
	if err != nil {
		return err
	}
	withNat := setForwardSection(text, specs)
	next, err := setForwardFilterSection(withNat, specs)
	if err != nil {
		return err
	}
	if err := writeRulesFileWithBackup(s.deps, s.paths.BeforeRules, next); err != nil {
		return err
	}
	if len(specs) > 0 {
		if err := s.ensureIpForward(); err != nil {
			return err
		}
	}
	if err := s.applyForwardsToKernel(specs); err != nil {
		return err
	}
	state, err := s.readState()
	if err != nil {
		return err
	}
	if state.active {
		return s.applyRulesFile()
	}
	return nil
}

// applyRulesFile 让 before.rules 的改动生效。ufw 0.36 的 reload（以及已激活时的重复
// enable）都不会重放 before.rules，只有完整的 disable → enable 才会——实测结论。
// 因此这里走一轮完整重启，并在重启后：按转发段重建内核 nat（enable 以 --noflush
// 追加 nat 段，会留下重复条目）；确认防火墙确实回到激活状态。enable 拉不起防火墙时
// 先用备份恢复规则文件再试一次：走了这条路就说明本次变更已被回滚，按操作失败报出，
// 不把回滚后的旧规则说成已生效。
func (s *service) applyRulesFile() error {
	beforeRules, err := s.deps.ReadText(s.paths.BeforeRules)
	if err != nil {
		return err
	}
	specs := parseForwardSection(beforeRules)
	if err := ensurePanelRule(s.deps, s.entryPort); err != nil {
		return err
	}
	if _, err := s.runUfw([]string{"--force", "disable"}); err != nil {
		return err
	}
	outcome := s.enableWithRecovery()
	if !outcome.active {
		reason := "ufw enable 执行后防火墙仍未激活"
		if len(outcome.errors) > 0 {
			reason = strings.Join(outcome.errors, "；")
		}
		recovery := "没有可用的备份可自动恢复"
		if outcome.restored {
			recovery = "已用备份恢复规则文件并重试启用，仍未成功"
		}
		return fmt.Errorf("规则重载后防火墙未处于激活状态：%s，%s。当前防火墙处于停用（不设防）状态，请检查 %s 与备份 %s，手工修复后执行 ufw enable",
			reason, recovery, s.paths.BeforeRules, backupPathOf(s.paths.BeforeRules))
	}
	if outcome.restored {
		return fmt.Errorf("规则重载未生效：ufw 启用失败，已用备份恢复并重新启用上一个已知良好的规则集，本次变更（禁 ping、防扫描或转发段）已被回滚。防火墙当前按恢复后的规则运行，请检查 %s 与备份 %s 后重试",
			s.paths.BeforeRules, backupPathOf(s.paths.BeforeRules))
	}
	if len(specs) > 0 {
		if err := s.ensureIpForward(); err != nil {
			return err
		}
	}
	if err := ensurePanelRule(s.deps, s.entryPort); err != nil {
		return err
	}
	return s.applyForwardsToKernel(specs)
}

// enableOutcome enable 与恢复重试的结果。
type enableOutcome struct {
	active   bool
	restored bool
	errors   []string
}

// enableWithRecovery enable 并确认激活；失败时用备份恢复规则文件再试一次。
// 每次尝试的失败（含 status 解析失败）只记进 errors，不向上抛——是否回到激活态
// 由调用方按结果分支处理。
func (s *service) enableWithRecovery() enableOutcome {
	var errors []string
	attempt := func() bool {
		if _, err := s.runUfw([]string{"--force", "enable"}); err != nil {
			errors = append(errors, err.Error())
			return false
		}
		statusOut, err := s.runUfw([]string{"status", "verbose"})
		if err != nil {
			errors = append(errors, err.Error())
			return false
		}
		status, err := parseStatusVerbose(statusOut)
		if err != nil {
			errors = append(errors, err.Error())
			return false
		}
		return status.Active
	}
	if attempt() {
		return enableOutcome{active: true, errors: errors}
	}
	restored := restoreRulesFromBackups(s.deps, s.paths)
	active := attempt()
	return enableOutcome{active: active, restored: restored, errors: errors}
}

var reEnabledYes = regexp.MustCompile(`(?m)^ENABLED=yes$`)

// restoreIfNeeded 容器没有 systemd：ufw.conf 记 ENABLED=yes 而内核规则已随上次容器
// 停止消失，启动时重新装载一次，等价真实服务器的 ufw.service 开机自启。装载失败
// （规则文件可能损坏）时先用备份恢复再试一次，仍失败交装配层拒绝启动。
func restoreIfNeeded(deps hostDeps, ports ...int) error {
	fwPaths := deps.Paths()
	conf, err := deps.ReadText(fwPaths.UfwConf)
	if err != nil {
		return fmt.Errorf("读取 UFW 启停配置失败：%w", err)
	}
	if !reEnabledYes.MatchString(conf) {
		return nil
	}
	// 容器重启后 ufw.conf 仍为 yes，但内核链可能尚不存在，status/allow 会失败。
	// 先重建原规则的内核链，再核验和补齐入口；此时 HTTP 尚未监听。
	_ = ensurePanelRule(deps, ports...)
	if enableAndCheckActive(deps) {
		return ensurePanelRule(deps, ports...)
	}
	restoreRulesFromBackups(deps, fwPaths)
	if !enableAndCheckActive(deps) {
		return fmt.Errorf("UFW 启动恢复失败：恢复备份后仍无法启用防火墙")
	}
	return ensurePanelRule(deps, ports...)
}

func enableAndCheckActive(deps hostDeps) bool {
	if _, err := deps.RunUfw([]string{"--force", "enable"}); err != nil {
		return false
	}
	out, err := deps.RunUfw([]string{"status", "verbose"})
	if err != nil {
		return false
	}
	status, err := parseStatusVerbose(out)
	if err != nil {
		return false
	}
	return status.Active
}

// Toggles 开关与默认策略。
func (s *service) Toggles() (FirewallToggles, error) {
	state, err := s.readState()
	if err != nil {
		return FirewallToggles{}, err
	}
	return s.togglesOf(state), nil
}

// SetToggles 切换防火墙总开关或禁 ping。
func (s *service) SetToggles(next FirewallToggles) (FirewallToggles, error) {
	var result FirewallToggles
	err := s.serialize(func() error {
		currentState, err := s.readState()
		if err != nil {
			return err
		}
		current := s.togglesOf(currentState)

		if next.FirewallEnabled != current.FirewallEnabled {
			if next.FirewallEnabled {
				if err := ensurePanelRule(s.deps, s.entryPort); err != nil {
					return err
				}
				if _, err := s.runUfw([]string{"--force", "enable"}); err != nil {
					return err
				}
			} else if _, err := s.runUfw([]string{"disable"}); err != nil {
				return err
			}
		}

		if next.PingBlocked != current.PingBlocked {
			if err := s.patchPing(next.PingBlocked); err != nil {
				return err
			}
			// reload 只在防火墙激活时需要；未激活时文件改动会在下次 enable 生效。
			if next.FirewallEnabled {
				if err := s.applyRulesFile(); err != nil {
					return err
				}
			}
		}

		finalState, err := s.readState()
		if err != nil {
			return err
		}
		if next.FirewallEnabled != finalState.active || next.PingBlocked != s.togglesOf(finalState).PingBlocked {
			return fmt.Errorf("防火墙开关或禁 ping 未达到请求状态，请重新读取状态后重试")
		}
		if finalState.active {
			if err := ensurePanelRule(s.deps, s.entryPort); err != nil {
				return err
			}
		}
		result = s.togglesOf(finalState)
		return nil
	})
	if err != nil {
		return FirewallToggles{}, err
	}
	return result, nil
}

// portOpenerService seam.PortOpener 实现：幂等补 ufw 放行，永不返回错误。
type portOpenerService struct {
	host        hostDeps
	backendPort int
}

// EnsurePortRule 幂等补 ufw 放行；一切结果以 contract.FirewallPortSync 带回。
func (p portOpenerService) EnsurePortRule(_ context.Context, port int, note string) contract.FirewallPortSync {
	if port == p.backendPort {
		detail := "面板后端端口不能对外开放"
		return contract.FirewallPortSync{State: contract.FirewallPortSyncFailed, Port: port, Detail: &detail}
	}
	return ensurePortRule(p.host, port, note)
}
