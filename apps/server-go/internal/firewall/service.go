package firewall

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"

	"elysian/server/internal/contract"
	"elysian/server/internal/paths"
	"elysian/server/internal/shared"
)

// 防火墙面板的服务编排（firewallService.ts 等价物）：把界面动作翻译成容器内 ufw 的
// 真实命令。全部系统访问经 hostDeps 注入，编排逻辑在测试里用 fake 依赖驱动。
//
// 防锁死保底：面板端口在启用防火墙前确保放行（判定以 ufw status 的 IPv4 放行为准，
// 见 ensurePanelRule），且不允许经面板删除；容器没有 systemd，ufw.conf 记 ENABLED=yes
// 时由 restoreIfNeeded 在启动时重新装载，等价真实服务器的 ufw.service 开机自启。
//
// 规则变更时间：会话账本优先，其次 SQLite 持久化账本（Docker 下挂命名卷），
// 两处都没有的存量规则显示「—」。

// FirewallPaths 系统侧规则文件路径（ufw 自己的文件，面板原位读写）。
type FirewallPaths struct {
	DefaultUfw    string
	BeforeRules   string
	BeforeRulesV6 string
	UfwConf       string
}

// defaultFirewallPaths DEFAULT_FIREWALL_PATHS。
var defaultFirewallPaths = FirewallPaths{
	DefaultUfw:    "/etc/default/ufw",
	BeforeRules:   "/etc/ufw/before.rules",
	BeforeRulesV6: "/etc/ufw/before6.rules",
	UfwConf:       "/etc/ufw/ufw.conf",
}

// 累计上限：规则文件不能被无限写大（ufw 装载变慢、面板列表失焦）。
const (
	firewallLimitUserRules = 200 // 端口规则（ufw 用户规则）
	firewallLimitIpRules   = 200 // IP 规则
	firewallLimitForwards  = 32  // 端口转发
)

// rulesBackupSuffix 规则文件的备份后缀：文件名保留原名，便于与目标对应。
const rulesBackupSuffix = ".elysian"

// backupPathOf 规则文件的备份路径：应用侧备份统一收进 ~/.Elysian/backups/（按原文件
// 名加后缀）；坏写入仍按这份备份回滚。
func backupPathOf(path string) string {
	name := path[strings.LastIndex(path, "/")+1:]
	return paths.BackupsDir + "/" + name + rulesBackupSuffix
}

// hostDeps 服务编排的全部系统访问接缝（FirewallHostDeps 等价物）；测试注入 fake。
type hostDeps interface {
	// RunUfw 执行 ufw 子命令，返回 stdout；失败返回错误（消息为 stderr 或原因）。
	RunUfw(args []string) (string, error)
	// RunSs 返回 `ss -Hultn` 输出。
	RunSs() (string, error)
	// RunIptables 读 v4 iptables 规则与计数（`iptables -L <chain> -nvx`）。
	RunIptables(args []string) (string, error)
	// RunIp6tables 读 v6 iptables 规则与计数。
	RunIp6tables(args []string) (string, error)
	ReadText(path string) (string, error)
	WriteText(path, content string) error
	// Exists 永不失败的存在性探测。
	Exists(path string) bool
	NowIso() string
	Paths() FirewallPaths
	// RuleTimes 规则时间持久化账本；nil 表示只用会话账本（刷新后回到「—」）。
	RuleTimes() ruleTimes
}

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

// panelSpec 面板保底规则规范；panelCanonical 是它的指纹。
var panelSpec = ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: strconv.Itoa(PanelPort), From: "any"}

var panelCanonical = canonicalId(panelSpec)

// service FirewallAdapter 的实现（一个进程一个实例，内存态即进程级）。
type service struct {
	panelPort      int
	backendPort    int
	panelCanonical string
	deps           hostDeps
	paths          FirewallPaths
	// rulesWriteMu 规则文件读-改-写的互斥队列：before.rules/before6.rules 的并发变更
	// 排队执行，每次都基于最新落盘内容计算，杜绝「两个请求读同一份原文、后写覆盖
	// 前写」。覆盖面与 TS 版 serializeRulesWrite 一致：setToggles、转发三写、
	// setScanProtection、setScanConfig 进队列；端口/IP 规则增删改与 unblockIp 不进。
	rulesWriteMu sync.Mutex
	// memMu 保护下面三个进程内存态（TS 靠事件循环天然安全，Go 需加锁）。
	memMu sync.Mutex
	// updatedAtMap 本会话内经面板变更过的规则（规范指纹 → ISO 时间）。
	updatedAtMap map[string]string
	// scanSeenIPs/scanFirstSeenAt 防扫描会话统计：历史封锁过的 IP 与首次观察时间。
	scanSeenIPs     map[string]bool
	scanFirstSeenAt map[string]string
	// scanDropSnapshot 防扫描开启时刻的 DROP 计数快照；「当前连接失败次数」= 累计 − 快照。
	scanDropSnapshot float64
}

// newService 构造服务实例。
func newService(deps hostDeps) Service { return newServiceWithPorts(deps, PanelPort, 48101) }

func newServiceWithPorts(deps hostDeps, panelPort, backendPort int) Service {
	return &service{
		panelPort:       panelPort,
		backendPort:     backendPort,
		panelCanonical:  canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: strconv.Itoa(panelPort), From: "any"}),
		deps:            deps,
		paths:           deps.Paths(),
		updatedAtMap:    map[string]string{},
		scanSeenIPs:     map[string]bool{},
		scanFirstSeenAt: map[string]string{},
	}
}

// runUfw 包一层执行失败的中文错误：detail 优先取 stderr。
func (s *service) runUfw(args []string) (string, error) {
	out, err := s.deps.RunUfw(args)
	if err != nil {
		return "", fmt.Errorf("ufw 执行失败（%s）：%v", strings.Join(args, " "), err)
	}
	return out, nil
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

func (s *service) togglesOf(state *hostState) FirewallToggles {
	return FirewallToggles{
		FirewallEnabled: state.active,
		PingBlocked:     state.pingBlocked,
		DefaultIncoming: state.defaultIncoming,
		DefaultOutgoing: state.defaultOutgoing,
	}
}

func firstRow(rows []FirewallRule) (FirewallRule, error) {
	if len(rows) == 0 {
		return FirewallRule{}, fmt.Errorf("规则行生成失败：没有可用地址族")
	}
	return rows[0], nil
}

// writeRulesFileWithBackup 写规则文件前先备份当前内容，再落新内容；文件尚不存在时跳过备份。
func writeRulesFileWithBackup(deps hostDeps, path string, content string) error {
	current, err := deps.ReadText(path)
	if err == nil {
		if err := deps.WriteText(backupPathOf(path), current); err != nil {
			return err
		}
	}
	return deps.WriteText(path, content)
}

// restoreRulesFromBackups 用备份恢复规则文件（v4 与 v6 都试）。直接落盘、不再先备份：
// 避免用当前可能损坏的内容覆盖掉唯一的好备份。返回是否至少恢复了一个文件。
func restoreRulesFromBackups(deps hostDeps, fwPaths FirewallPaths) bool {
	restored := false
	for _, path := range []string{fwPaths.BeforeRules, fwPaths.BeforeRulesV6} {
		backup := backupPathOf(path)
		if !deps.Exists(backup) {
			continue
		}
		content, err := deps.ReadText(backup)
		if err != nil {
			continue
		}
		if err := deps.WriteText(path, content); err == nil {
			restored = true
		}
	}
	return restored
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

// ensurePanelRule 面板端口保底：激活态以 `ufw status` 的 IPv4 放行为准——`show added`
// 合并双栈账本，看不出「只剩 v6 半条」的残缺（v4 账本丢失时 Docker 端口映射的 IPv4
// 流量会被默认拒绝丢包）。行缺失或未激活无法核验时幂等补写（ufw 对已有半边自会
// 跳过），补写后激活态仍无 IPv4 行则报错：保底必须可验证，静默失败等于把面板锁死。
func ensurePanelRule(deps hostDeps, ports ...int) error {
	panelPort := defaultPort(ports)
	before, err := deps.RunUfw([]string{"status", "verbose"})
	if err != nil {
		return err
	}
	beforeStatus, err := parseStatusVerbose(before)
	if err != nil {
		return err
	}
	if beforeStatus.Active && hasPanelAllowRow(parseStatusRows(before), panelPort) {
		return nil
	}
	if _, err := deps.RunUfw([]string{"allow", fmt.Sprintf("%d/tcp", panelPort), "comment", "Elysian 面板"}); err != nil {
		return err
	}
	after, err := deps.RunUfw([]string{"status", "verbose"})
	if err != nil {
		return err
	}
	afterStatus, err := parseStatusVerbose(after)
	if err != nil {
		return err
	}
	if afterStatus.Active && !hasPanelAllowRow(parseStatusRows(after), panelPort) {
		return fmt.Errorf("面板端口保底规则未生效：ufw allow %d/tcp 执行后 status 仍无 IPv4 放行行，请检查 /etc/ufw/user.rules", panelPort)
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
	if err := ensurePanelRule(s.deps, s.panelPort); err != nil {
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
// （规则文件可能损坏）时先用备份恢复再试一次，仍失败返回错误由调用方记录。
func restoreIfNeeded(deps hostDeps, ports ...int) error {
	fwPaths := deps.Paths()
	conf, err := deps.ReadText(fwPaths.UfwConf)
	if err != nil {
		return nil
	}
	if !reEnabledYes.MatchString(conf) {
		return nil
	}
	if err := ensurePanelRule(deps, ports...); err != nil {
		return err
	}
	if enableAndCheckActive(deps) {
		return nil
	}
	restoreRulesFromBackups(deps, fwPaths)
	_, err = deps.RunUfw([]string{"--force", "enable"})
	return err
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

// readScanProtection 汇总防扫描实时状态：名单来自内核 recent 文件，拦截计数来自
// v4/v6 DROP 规则计数器。防火墙停用时 ufw 的链不存在，查 iptables 必失败（读路径
// 不能因此 500）：只回报文件里的配置与空统计——规则段已落盘，防火墙启用后随之生效。
func (s *service) readScanProtection() (FirewallScanProtection, error) {
	beforeRules, err := s.deps.ReadText(s.paths.BeforeRules)
	if err != nil {
		return FirewallScanProtection{}, err
	}
	section := parseScanSection(beforeRules)

	ips := []string{}
	dropCounter := 0
	statusOut, err := s.runUfw([]string{"status", "verbose"})
	if err != nil {
		return FirewallScanProtection{}, err
	}
	status, err := parseStatusVerbose(statusOut)
	if err != nil {
		return FirewallScanProtection{}, err
	}
	if section.Enabled && status.Active {
		if err := func() error {
			v4, v6 := []string{}, []string{}
			if s.deps.Exists(ScanBannedRecentPath) {
				// 规则段已写入但 ufw 尚未 reload（或未激活）时，内核名单文件还不存在：
				// 视为空名单。
				text, err := s.deps.ReadText(ScanBannedRecentPath)
				if err != nil {
					return err
				}
				v4 = parseRecentList(text)
			}
			if s.deps.Exists(ScanBanned6RecentPath) {
				text, err := s.deps.ReadText(ScanBanned6RecentPath)
				if err != nil {
					return err
				}
				v6 = parseRecentList(text)
			}
			ips = append(v4, v6...)
			v4Count, err := s.deps.RunIptables([]string{"-L", scanTables["v4"].Chain, "-nvx"})
			if err != nil {
				return err
			}
			v6Count, err := s.deps.RunIp6tables([]string{"-L", scanTables["v6"].Chain, "-nvx"})
			if err != nil {
				return err
			}
			dropCounter = parseDropCounter(v4Count) + parseDropCounter(v6Count)
			return nil
		}(); err != nil {
			return FirewallScanProtection{}, fmt.Errorf("防扫描内核数据不可读：%v", err)
		}
		now := s.deps.NowIso()
		s.memMu.Lock()
		for _, ip := range ips {
			if !s.scanSeenIPs[ip] {
				s.scanSeenIPs[ip] = true
				s.scanFirstSeenAt[ip] = now
			}
		}
		s.memMu.Unlock()
	}

	s.memMu.Lock()
	totalBlocked := len(s.scanSeenIPs)
	snapshot := s.scanDropSnapshot
	blockedAt := make(map[string]string, len(ips))
	for _, ip := range ips {
		if at, ok := s.scanFirstSeenAt[ip]; ok {
			blockedAt[ip] = at
		} else {
			blockedAt[ip] = s.deps.NowIso()
		}
	}
	s.memMu.Unlock()

	current := dropCounter - int(snapshot)
	if current < 0 {
		current = 0
	}
	blocked := make([]FirewallBlockedIp, 0, len(ips))
	for _, ip := range ips {
		blocked = append(blocked, FirewallBlockedIp{IP: ip, BlockedAt: blockedAt[ip]})
	}
	return FirewallScanProtection{
		Enabled: section.Enabled,
		Config:  section.Config,
		Stats: FirewallScanStats{
			TotalBlockedIps:          totalBlocked,
			TotalFailedConnections:   dropCounter,
			CurrentBlockedIps:        len(ips),
			CurrentFailedConnections: current,
		},
		Blocked: blocked,
	}, nil
}

// writeScanSection 双栈规则文件同步写扫描段（v4 与 v6 的链与名单名不同）。
func (s *service) writeScanSection(enabled bool, config ScanConfig) error {
	beforeV4, err := s.deps.ReadText(s.paths.BeforeRules)
	if err != nil {
		return err
	}
	var beforeV6 *string
	if s.deps.Exists(s.paths.BeforeRulesV6) {
		text, err := s.deps.ReadText(s.paths.BeforeRulesV6)
		if err != nil {
			return err
		}
		beforeV6 = &text
	}
	nextV4, err := setScanSection(beforeV4, enabled, config, "v4", s.panelPort, s.backendPort)
	if err != nil {
		return err
	}
	if err := writeRulesFileWithBackup(s.deps, s.paths.BeforeRules, nextV4); err != nil {
		return err
	}
	if beforeV6 != nil {
		nextV6, err := setScanSection(*beforeV6, enabled, config, "v6", s.panelPort, s.backendPort)
		if err != nil {
			return err
		}
		if err := writeRulesFileWithBackup(s.deps, s.paths.BeforeRulesV6, nextV6); err != nil {
			return err
		}
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

// serialize 串行队列：与 TS serializeRulesWrite 同覆盖面（规则文件的读-改-写互斥）。
func (s *service) serialize(critical func() error) error {
	s.rulesWriteMu.Lock()
	defer s.rulesWriteMu.Unlock()
	return critical()
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
				if err := ensurePanelRule(s.deps, s.panelPort); err != nil {
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
		result = s.togglesOf(finalState)
		return nil
	})
	if err != nil {
		return FirewallToggles{}, err
	}
	return result, nil
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
		return FirewallRule{}, &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("端口规则已存在：%s %s（IPv4 与 IPv6 由同一条规则覆盖，不能按地址族重复添加）", input.Protocol, jsNumberToString(input.Port))}
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
	// 面板保底规则只放行等价规范的原地更新（如只改备注）；改成 deny、换端口或换来源
	// 都会把工作台锁在防火墙外。
	if oldCanonical == s.panelCanonical && nextCanonical != s.panelCanonical {
		return FirewallRule{}, fmt.Errorf("面板端口规则不允许变更：它是保证工作台可访问的保底规则")
	}
	if s.findDuplicate(state, input, oldCanonical) != nil {
		return FirewallRule{}, &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("端口规则已存在：%s %s（IPv4 与 IPv6 由同一条规则覆盖，不能按地址族重复添加）", input.Protocol, jsNumberToString(input.Port))}
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

// ImportRules 批量导入。
func (s *service) ImportRules(inputs []RuleInput) (ImportResult, error) {
	// 先整批校验：任何一条非法就整批拒绝并报出第几条，绝不出现「前几条已写入
	// 防火墙、界面却报整体失败」的状态分叉。
	specs := make([]ufwRuleSpec, len(inputs))
	for index, input := range inputs {
		spec, err := specFromInput(input)
		if err != nil {
			return ImportResult{}, fmt.Errorf("第 %d 条规则无效：%s（整批拒绝，未导入任何规则）", index+1, err.Error())
		}
		specs[index] = spec
	}
	state, err := s.readState()
	if err != nil {
		return ImportResult{}, err
	}
	// 上限预检：按去重后的真实新增数预估导入后的总量，越界同样整批拒绝。
	existingKeys := map[string]bool{}
	for _, line := range portLinesOf(state) {
		key := fmt.Sprintf("%s:%s:%s", line.Spec.Proto, line.Spec.Direction, jsNumberToString(displayPortOf(line.Spec)))
		existingKeys[key] = true
	}
	batchKeys := map[string]bool{}
	projected := len(portLinesOf(state))
	for _, input := range inputs {
		key := fmt.Sprintf("%s:%s:%s", input.Protocol, directionOfInput(input.Direction), jsNumberToString(input.Port))
		if existingKeys[key] || batchKeys[key] {
			continue
		}
		batchKeys[key] = true
		projected++
	}
	if projected > firewallLimitUserRules {
		return ImportResult{}, fmt.Errorf("端口规则数将超出上限（最多 %d 条）：导入后为 %d 条（整批拒绝，未导入任何规则）", firewallLimitUserRules, projected)
	}

	added := []FirewallRule{}
	skipped := 0
	for i, input := range inputs {
		spec := specs[i]
		fresh, err := s.readState()
		if err != nil {
			return ImportResult{}, err
		}
		if s.findDuplicate(fresh, input, "") != nil {
			skipped++
			continue
		}
		if _, err := s.runUfw(append(specToArgs(spec), commentArgs(input.Note)...)); err != nil {
			// 校验已全部通过，失败发生在执行阶段：此前条目已经真实写入防火墙，
			// 报错里带上是第几条与已写入条数，界面据此重新同步而不是当成整批没发生。
			return ImportResult{}, fmt.Errorf("第 %d 条规则写入失败：%s（此前 %d 条已写入防火墙，请重新同步列表）", i+1, err.Error(), len(added))
		}
		s.touch(canonicalId(spec))
		afterState, err := s.readState()
		if err != nil {
			return ImportResult{}, err
		}
		row, err := firstRow(ruleRowsFromSpec(spec, input.Note, s.rowContext(afterState)))
		if err != nil {
			return ImportResult{}, err
		}
		added = append(added, row)
	}
	return ImportResult{Added: added, Skipped: skipped}, nil
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
			return FirewallIpRule{}, &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("IP 规则已存在：%s", input.Source)}
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
			return FirewallIpRule{}, &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("IP 规则已存在：%s", input.Source)}
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
		spec, err := specFromForwardInput(input, s.panelPort, s.backendPort)
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
				return &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("端口转发已存在：%s %s 与既有转发 %s %s 的端口区间重叠", spec.Protocol, spec.Port, candidate.Protocol, candidate.Port)}
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
		spec, err := specFromForwardInput(input, s.panelPort, s.backendPort)
		if err != nil {
			return err
		}
		for _, candidate := range existing {
			if forwardIdOf(candidate) != oldId && forwardPortsOverlap(candidate, spec) {
				return &shared.InvalidRequestError{Status: 409, Message: fmt.Sprintf("端口转发已存在：%s %s 与既有转发 %s %s 的端口区间重叠", spec.Protocol, spec.Port, candidate.Protocol, candidate.Port)}
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

// ScanProtection 防扫描全景。
func (s *service) ScanProtection() (FirewallScanProtection, error) {
	return s.readScanProtection()
}

// SetScanProtection 切换防扫描开关。
func (s *service) SetScanProtection(enabled bool) (FirewallScanProtection, error) {
	var result FirewallScanProtection
	err := s.serialize(func() error {
		beforeRules, err := s.deps.ReadText(s.paths.BeforeRules)
		if err != nil {
			return err
		}
		if err := s.writeScanSection(enabled, parseScanSection(beforeRules).Config); err != nil {
			return err
		}
		// 开启时刻重置快照，「当前连接失败次数」从零起算。
		if enabled {
			s.memMu.Lock()
			s.scanDropSnapshot = 0
			s.memMu.Unlock()
		}
		result, err = s.readScanProtection()
		return err
	})
	if err != nil {
		return FirewallScanProtection{}, err
	}
	return result, nil
}

// SetScanConfig 更新防扫描配置。
func (s *service) SetScanConfig(config ScanConfig) (FirewallScanProtection, error) {
	var result FirewallScanProtection
	err := s.serialize(func() error {
		// 先校验请求体（纯函数），再判开关状态：非法配置在任何状态下都按请求本身
		// 被拒，面板端口这条保底判据不会因为「防扫描未启用」而躲过。
		if _, err := validateScanConfig(config, s.panelPort, s.backendPort); err != nil {
			return err
		}
		beforeRules, err := s.deps.ReadText(s.paths.BeforeRules)
		if err != nil {
			return err
		}
		if !parseScanSection(beforeRules).Enabled {
			// 前置状态不满足：配置本身可能完全合法，只是开关没开 → 409（不是请求体错误）。
			return &shared.InvalidRequestError{Status: 409, Message: "防扫描未启用：先开启开关再调整配置"}
		}
		if err := s.writeScanSection(true, config); err != nil {
			return err
		}
		result, err = s.readScanProtection()
		return err
	})
	if err != nil {
		return FirewallScanProtection{}, err
	}
	return result, nil
}

// UnblockIp 解封封锁名单中的 IP（不进串行队列：只写内核名单文件，不动规则文件）。
func (s *service) UnblockIp(ip string) (FirewallScanProtection, error) {
	beforeRules, err := s.deps.ReadText(s.paths.BeforeRules)
	if err != nil {
		return FirewallScanProtection{}, err
	}
	if !parseScanSection(beforeRules).Enabled {
		return FirewallScanProtection{}, fmt.Errorf("防扫描未启用：没有可解封的 IP")
	}
	target, err := validateUnblockIp(ip)
	if err != nil {
		return FirewallScanProtection{}, err
	}
	// 内核 recent 名单按地址族分文件：v6 地址写 v6 名单，其余写 v4 名单。
	path := ScanBannedRecentPath
	if strings.Contains(target, ":") {
		path = ScanBanned6RecentPath
	}
	blocked := []string{}
	if s.deps.Exists(path) {
		text, err := s.deps.ReadText(path)
		if err != nil {
			return FirewallScanProtection{}, err
		}
		blocked = parseRecentList(text)
	}
	found := false
	for _, entry := range blocked {
		if entry == target {
			found = true
			break
		}
	}
	if !found {
		return FirewallScanProtection{}, fmt.Errorf("IP %s 不在封锁名单中", target)
	}
	if err := s.deps.WriteText(path, fmt.Sprintf("-%s\n", target)); err != nil {
		return FirewallScanProtection{}, err
	}
	return s.readScanProtection()
}

// SyncFromSystem 从承载本面板的操作系统同步防火墙规则：返回三类规则行总数。
func (s *service) SyncFromSystem() (int, error) {
	state, err := s.readState()
	if err != nil {
		return 0, err
	}
	return len(s.rulesOf(state)) + len(s.ipRulesOf(state)) + len(s.forwardsOf(state)), nil
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

func (s *service) protectPorts(input RuleInput) error {
	if input.Direction == "outbound" || input.Protocol == "udp" {
		return nil
	}
	if (input.Policy == "allow" || input.Policy == "limit") && coversPanelPort(input.Port, input.PortTo, s.backendPort) {
		return shared.InvalidRequest("面板后端端口只供本机访问，不能添加入站放行规则")
	}
	if input.Policy == "deny" && coversPanelPort(input.Port, input.PortTo, s.panelPort) {
		return shared.InvalidRequest("面板端口规则不允许变更：不能封禁面板前端端口")
	}
	return nil
}
