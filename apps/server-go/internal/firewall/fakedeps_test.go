package firewall

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// firewallService.test.ts 自带 fake 的对等移植：命令只记录进调用账本并按规则变化
// 内部状态，编排逻辑（保底规则、先建后删、禁 ping、防扫描、转发段、时间账本）
// 据此断言。

// fakeFileWrite 一次落盘记录。
type fakeFileWrite struct {
	Path    string
	Content string
}

// fakeNatRule 内核 nat 表里属于本面板的规则（含重复条目）。
type fakeNatRule struct {
	Chain      string // PREROUTING | POSTROUTING
	Protocol   string
	Port       string
	TargetHost string
	TargetPort int
	Note       *string
}

// fakeUfwDepsSeed fake 初始状态。
type fakeUfwDepsSeed struct {
	Active            bool
	Ipv6              string
	UfwConf           string
	Listeners         []string
	Rules             []string
	V4Rules           *[]string // 默认与 Rules 相同；空切片模拟「v4 账本丢失」
	V4Stuck           bool      // allow 执行后 IPv4 账本仍不落规则
	BeforeRules       string
	DisableReapplyNat bool // 关闭「enable 重放 nat 段」的模拟；缺省开启重放
}

type fakeUfwDeps struct {
	mu sync.Mutex

	ufwCalls   []string
	fileWrites []fakeFileWrite
	extraFiles map[string]string

	active        bool
	bookV4        []string
	bookV6        []string
	beforeV4      string
	beforeV6      string
	recentV4      string
	recentV6      string
	dropV4        int
	dropV6        int
	recentExistV4 bool
	recentExistV6 bool
	ipForward     string
	natRules      []fakeNatRule

	defaultUfw string
	ufwConf    string
	ssOut      string

	v4Stuck    bool
	reapplyNat bool
	// ufwWrapper 包住默认 fake 逻辑：测试注入命令失败（对齐 TS 测试里对
	// fake.deps.runUfw 的整体替换）。
	ufwWrapper func(args []string, next func() (string, error)) (string, error)
	// readWrapper 包住默认读取逻辑：测试注入特定路径的读取失败。
	readWrapper func(path string, next func() (string, error)) (string, error)
}

// createFakeDeps 构造 fake 接线；返回值带访问器供断言。
func createFakeDeps(seed fakeUfwDepsSeed) *fakeUfwDeps {
	seededRules := seed.Rules
	bookV4 := append([]string{}, seededRules...)
	if seed.V4Rules != nil {
		bookV4 = append([]string{}, *seed.V4Rules...)
	}
	bookV6 := append([]string{}, seededRules...)
	beforeV4 := seed.BeforeRules
	if beforeV4 == "" {
		beforeV4 = strings.Join([]string{
			"# before.rules",
			"*filter",
			":ufw-before-input - [0:0]",
			"-A ufw-before-input -i lo -j ACCEPT",
			"-A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT",
			"COMMIT",
		}, "\n")
	}
	beforeV6 := strings.Join([]string{
		"# before6.rules",
		"*filter",
		":ufw6-before-input - [0:0]",
		"-A ufw6-before-input -p ipv6-icmp --icmpv6-type echo-request -j ACCEPT",
		"COMMIT",
	}, "\n")
	defaultUfw := seed.Ipv6
	if defaultUfw == "" {
		defaultUfw = "IPV6=yes"
	}
	ufwConf := seed.UfwConf
	if ufwConf == "" {
		// 缺省 ENABLED=no（TS fake 的 `seed.ufwConf ?? 'ENABLED=no\n'`）。
		ufwConf = "ENABLED=no\n"
	}
	listeners := seed.Listeners
	if listeners == nil {
		listeners = []string{fmt.Sprintf("tcp:%d", PanelPort)}
	}
	var ss strings.Builder
	for _, key := range listeners {
		parts := strings.SplitN(key, ":", 2)
		proto, port := parts[0], parts[1]
		state := "LISTEN"
		if proto == "udp" {
			state = "UNCONN"
		}
		fmt.Fprintf(&ss, "%s %s 0 0 *:%s *:*\n", proto, state, port)
	}
	return &fakeUfwDeps{
		extraFiles: map[string]string{},
		active:     seed.Active,
		bookV4:     bookV4,
		bookV6:     bookV6,
		beforeV4:   beforeV4,
		beforeV6:   beforeV6,
		ipForward:  "0\n",
		defaultUfw: defaultUfw,
		ufwConf:    ufwConf,
		ssOut:      ss.String(),
		v4Stuck:    seed.V4Stuck,
		reapplyNat: !seed.DisableReapplyNat,
	}
}

// renderStatusRows 规则账本行 → status 规则表行（读不懂的行不渲染）。
func renderStatusRows(lines []string, v6 bool) []string {
	rows := []string{}
	for _, line := range lines {
		parsed := parseShowAddedLine("ufw " + line)
		if parsed == nil {
			continue
		}
		comment := ""
		if parsed.Comment != nil {
			comment = "   # " + *parsed.Comment
		}
		v6Suffix := ""
		if v6 {
			v6Suffix = " (v6)"
		}
		action := strings.ToUpper(parsed.Spec.Action)
		if parsed.Kind == "ip" {
			rows = append(rows, fmt.Sprintf("%s%s  %s IN  Anywhere%s%s", parsed.IpSpec.From, v6Suffix, action, v6Suffix, comment))
			continue
		}
		protoPort := parsed.Spec.Port + "/" + parsed.Spec.Proto
		if parsed.Spec.Direction == "out" {
			rows = append(rows, fmt.Sprintf("Anywhere%s  %s OUT  %s%s", v6Suffix, action, protoPort, comment))
			continue
		}
		from := parsed.Spec.From
		if from == "any" {
			from = "Anywhere"
		}
		rows = append(rows, fmt.Sprintf("%s%s  %s IN  %s%s%s", protoPort, v6Suffix, action, from, v6Suffix, comment))
	}
	return rows
}

func (f *fakeUfwDeps) iptablesList(counter int, names []string) string {
	lines := []string{
		`Chain ufw-before-input (1 references)`,
		`    pkts      bytes target     prot opt in     out     source               destination`,
		`   512    30720 ACCEPT     all  --  lo     *       0.0.0.0/0            0.0.0.0/0`,
	}
	for _, name := range names {
		lines = append(lines, fmt.Sprintf(`  %4d     1020 DROP       tcp  --  *      *       0.0.0.0/0            0.0.0.0/0           multiport dports 22 recent: CHECK seconds: 60 hit_count: 8 name: %s`, counter, name))
	}
	return strings.Join(lines, "\n")
}

// RunUfw 模拟真实 ufw：只有完整 enable 会重放 before.rules（reload 不会）；
// comment 以带引号字面量进入 show added；已存在的半边按地址族跳过。
func (f *fakeUfwDeps) RunUfw(args []string) (string, error) {
	if f.ufwWrapper != nil {
		// wrapper 在锁外执行，next 内部再取锁：wrapper 里可以安全调用访问器。
		return f.ufwWrapper(args, func() (string, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.runUfwLocked(args)
		})
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runUfwLocked(args)
}

func (f *fakeUfwDeps) runUfwLocked(args []string) (string, error) {
	f.ufwCalls = append(f.ufwCalls, strings.Join(args, " "))
	verb := args[0]
	rest := args[1:]
	switch {
	case verb == "status":
		if !f.active {
			return "Status: inactive\n", nil
		}
		lines := []string{
			"Status: active",
			"Logging: on (low)",
			"Default: deny (incoming), allow (outgoing), disabled (routed)",
			"",
			"To                         Action      From",
			"--                         ------      ----",
		}
		lines = append(lines, renderStatusRows(f.bookV4, false)...)
		lines = append(lines, renderStatusRows(f.bookV6, true)...)
		return strings.Join(lines, "\n"), nil
	case verb == "show":
		seen := map[string]bool{}
		merged := []string{}
		for _, line := range append(append([]string{}, f.bookV4...), f.bookV6...) {
			if !seen[line] {
				seen[line] = true
				merged = append(merged, line)
			}
		}
		body := "(None)"
		if len(merged) > 0 {
			body = strings.Join(mapToUfwLines(merged), "\n")
		}
		return "Added user rules:\n" + body, nil
	case verb == "--force" && rest[0] == "enable":
		f.active = true
		f.dropV4 = 0
		f.dropV6 = 0
		f.recentExistV4 = strings.Contains(f.beforeV4, scanTables["v4"].Track)
		f.recentExistV6 = strings.Contains(f.beforeV6, scanTables["v6"].Track)
		if f.reapplyNat && strings.Contains(f.beforeV4, "*nat") {
			for _, line := range strings.Split(f.beforeV4, "\n") {
				if m := regexpFindDNAT(line); m != nil {
					f.natRules = append(f.natRules, fakeNatRule{Chain: "PREROUTING", Protocol: m.protocol, Port: m.port, TargetHost: m.host, TargetPort: m.tport, Note: noteFromForwardComment(m.comment)})
					continue
				}
				if m := regexpFindMASQ(line); m != nil {
					f.natRules = append(f.natRules, fakeNatRule{Chain: "POSTROUTING", Protocol: m.protocol, Port: "", TargetHost: m.host, TargetPort: m.tport, Note: noteFromForwardComment(m.comment)})
				}
			}
		}
		return "", nil
	case (verb == "--force" && rest[0] == "disable") || verb == "disable":
		f.active = false
		return "", nil
	case verb == "reload":
		return "", nil
	case verb == "allow" || verb == "deny" || verb == "limit":
		commentIndex := -1
		for i, arg := range args {
			if arg == "comment" {
				commentIndex = i
				break
			}
		}
		specArgs := args
		if commentIndex != -1 {
			specArgs = args[:commentIndex]
		}
		specPart := strings.Join(specArgs, " ")
		comment := ""
		if commentIndex != -1 {
			comment = strings.Join(args[commentIndex+1:], " ")
		}
		line := specPart
		if comment != "" {
			line = fmt.Sprintf("%s comment '%s'", specPart, comment)
		}
		if !f.v4Stuck && !containsStr(f.bookV4, line) {
			f.bookV4 = append(f.bookV4, line)
		}
		if !containsStr(f.bookV6, line) {
			f.bookV6 = append(f.bookV6, line)
		}
		return "Rules updated", nil
	case verb == "delete":
		spec := strings.Join(args[1:], " ")
		keep := func(line string) bool { return line != spec && !strings.HasPrefix(line, spec+" comment ") }
		before := len(f.bookV4) + len(f.bookV6)
		f.bookV4 = filterStr(f.bookV4, keep)
		f.bookV6 = filterStr(f.bookV6, keep)
		if len(f.bookV4)+len(f.bookV6) == before {
			return "", fmt.Errorf("ERROR: 找不到规则 (%s)", spec)
		}
		return "Rules updated", nil
	}
	return "", fmt.Errorf("fake ufw 未实现的命令：%s", strings.Join(args, " "))
}

type fakeNatMatch struct {
	protocol, port, host, comment string
	tport                         int
}

var (
	fakeDNATRe = regexp.MustCompile(`^-A PREROUTING -p (tcp|udp) --dport (\S+) -m comment --comment "([^"]*)" -j DNAT --to-destination ([\d.]+):(\d+)`)
	fakeMASQRe = regexp.MustCompile(`^-A POSTROUTING -d ([\d.]+) -p (tcp|udp) --dport (\d+) -m comment --comment "([^"]*)" -j MASQUERADE`)
)

func regexpFindDNAT(line string) *fakeNatMatch {
	m := fakeDNATRe.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	tport, _ := strconv.Atoi(m[5])
	return &fakeNatMatch{protocol: m[1], port: m[2], host: m[4], comment: m[3], tport: tport}
}

func regexpFindMASQ(line string) *fakeNatMatch {
	m := fakeMASQRe.FindStringSubmatch(line)
	if m == nil {
		return nil
	}
	tport, _ := strconv.Atoi(m[3])
	return &fakeNatMatch{protocol: m[2], host: m[1], comment: m[4], tport: tport}
}

// RunIptables nat 表的 DNAT/MASQUERADE 走单独状态；filter 链查询在停用态报错。
func (f *fakeUfwDeps) RunIptables(args []string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ufwCalls = append(f.ufwCalls, "iptables:"+strings.Join(args, " "))
	if len(args) >= 4 && args[0] == "-t" && args[1] == "nat" {
		chain := args[3]
		var list []fakeNatRule
		for _, rule := range f.natRules {
			if rule.Chain == chain {
				list = append(list, rule)
			}
		}
		switch args[2] {
		case "-L":
			lines := []string{
				fmt.Sprintf("Chain %s (policy ACCEPT)", chain),
				"num  target     prot opt source               destination",
			}
			for i, rule := range list {
				target := "DNAT"
				dpt := rule.Port
				if rule.Chain == "POSTROUTING" {
					target = "MASQUERADE"
					dpt = strconv.Itoa(rule.TargetPort)
				}
				lines = append(lines, fmt.Sprintf("%d    %s  %s  --  0.0.0.0/0            0.0.0.0/0            %s dpt:%s /* %s */ to:%s:%d",
					i+1, target, rule.Protocol, rule.Protocol, dpt, forwardCommentOf(rule.Note), rule.TargetHost, rule.TargetPort))
			}
			return strings.Join(lines, "\n"), nil
		case "-D":
			index, _ := strconv.Atoi(args[4])
			if index < 1 || index > len(list) {
				return "", fmt.Errorf("DELETE 失败：%s 行号 %s 不存在", chain, args[4])
			}
			target := list[index-1]
			for i, rule := range f.natRules {
				if rule == target {
					f.natRules = append(f.natRules[:i], f.natRules[i+1:]...)
					break
				}
			}
			return "", nil
		case "-A":
			rest := args[4:]
			get := func(flag string) string {
				for i, arg := range rest {
					if arg == flag && i+1 < len(rest) {
						return rest[i+1]
					}
				}
				return ""
			}
			rule := fakeNatRule{Chain: chain, Protocol: "tcp"}
			if p := get("-p"); p != "" {
				rule.Protocol = p
			}
			if chain == "PREROUTING" {
				rule.Port = get("--dport")
				to := get("--to-destination")
				host, tport, _ := strings.Cut(to, ":")
				rule.TargetHost = host
				rule.TargetPort, _ = strconv.Atoi(tport)
			} else {
				rule.TargetHost = get("-d")
				rule.TargetPort, _ = strconv.Atoi(get("--dport"))
			}
			rule.Note = noteFromForwardComment(get("--comment"))
			f.natRules = append(f.natRules, rule)
			return "", nil
		}
	}
	// 与真实内核一致：ufw 停用时 ufw-* 链不存在。
	if !f.active {
		return "", fmt.Errorf("iptables: No chain/target/match by that name.")
	}
	return f.iptablesList(f.dropV4, []string{scanTables["v4"].Banned, scanTables["v4"].Track}), nil
}

func (f *fakeUfwDeps) RunIp6tables(args []string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ufwCalls = append(f.ufwCalls, "ip6tables:"+strings.Join(args, " "))
	if !f.active {
		return "", fmt.Errorf("ip6tables: No chain/target/match by that name.")
	}
	return f.iptablesList(f.dropV6, []string{scanTables["v6"].Banned, scanTables["v6"].Track}), nil
}

func (f *fakeUfwDeps) RunSs() (string, error) {
	return f.ssOut, nil
}

func (f *fakeUfwDeps) ReadText(path string) (string, error) {
	if f.readWrapper != nil {
		return f.readWrapper(path, func() (string, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			return f.readTextLocked(path)
		})
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.readTextLocked(path)
}

func (f *fakeUfwDeps) readTextLocked(path string) (string, error) {
	switch path {
	case "/etc/default/ufw":
		return f.defaultUfw, nil
	case "/etc/ufw/before.rules":
		return f.beforeV4, nil
	case "/etc/ufw/before6.rules":
		return f.beforeV6, nil
	case "/etc/ufw/ufw.conf":
		return f.ufwConf, nil
	case ScanBannedRecentPath:
		if !f.recentExistV4 {
			return "", fmt.Errorf("ENOENT")
		}
		return f.recentV4, nil
	case ScanBanned6RecentPath:
		if !f.recentExistV6 {
			return "", fmt.Errorf("ENOENT")
		}
		return f.recentV6, nil
	case IPForwardPath:
		return f.ipForward, nil
	}
	if content, ok := f.extraFiles[path]; ok {
		return content, nil
	}
	return "", fmt.Errorf("fake 未实现的读取：%s", path)
}

func (f *fakeUfwDeps) WriteText(path, content string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fileWrites = append(f.fileWrites, fakeFileWrite{Path: path, Content: content})
	switch path {
	case "/etc/ufw/before.rules":
		f.beforeV4 = content
		f.recentExistV4 = f.recentExistV4 || strings.Contains(content, scanTables["v4"].Track)
	case "/etc/ufw/before6.rules":
		f.beforeV6 = content
		f.recentExistV6 = f.recentExistV6 || strings.Contains(content, scanTables["v6"].Track)
	case IPForwardPath:
		f.ipForward = content
	case ScanBannedRecentPath:
		// 模拟内核 recent 名单的解封协议：「-IP」移除条目。
		target := strings.TrimPrefix(strings.TrimSpace(content), "-")
		var kept []string
		for _, line := range strings.Split(f.recentV4, "\n") {
			if line != "" && !strings.HasPrefix(line, "src="+target+" ") {
				kept = append(kept, line)
			}
		}
		f.recentV4 = strings.Join(kept, "\n")
	case ScanBanned6RecentPath:
		target := strings.TrimPrefix(strings.TrimSpace(content), "-")
		var kept []string
		for _, line := range strings.Split(f.recentV6, "\n") {
			if line != "" && !strings.HasPrefix(line, "src="+target+" ") {
				kept = append(kept, line)
			}
		}
		f.recentV6 = strings.Join(kept, "\n")
	}
	f.extraFiles[path] = content
	return nil
}

func (f *fakeUfwDeps) Exists(path string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch path {
	case ScanBannedRecentPath:
		return f.recentExistV4
	case ScanBanned6RecentPath:
		return f.recentExistV6
	}
	return true
}

func (f *fakeUfwDeps) NowIso() string { return "2026-09-19T08:00:00.000Z" }

func (f *fakeUfwDeps) Paths() FirewallPaths { return defaultFirewallPaths }

func (f *fakeUfwDeps) RuleTimes() ruleTimes { return nil }

// ---------- 访问器（断言用） ----------

func (f *fakeUfwDeps) calls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.ufwCalls...)
}

// writeCommandCalls 只统计真正改写防火墙的 ufw 命令（allow/deny/limit/delete 开头）。
func (f *fakeUfwDeps) writeCommandCalls() []string {
	var out []string
	for _, call := range f.calls() {
		for _, verb := range []string{"allow", "deny", "limit", "delete"} {
			if call == verb || strings.HasPrefix(call, verb+" ") {
				out = append(out, call)
				break
			}
		}
	}
	return out
}

func (f *fakeUfwDeps) fileWritesOf() []fakeFileWrite {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeFileWrite{}, f.fileWrites...)
}

func (f *fakeUfwDeps) getAdded() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := map[string]bool{}
	merged := []string{}
	for _, line := range append(append([]string{}, f.bookV4...), f.bookV6...) {
		if !seen[line] {
			seen[line] = true
			merged = append(merged, line)
		}
	}
	return merged
}

func (f *fakeUfwDeps) getV4Rules() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string{}, f.bookV4...)
}

func (f *fakeUfwDeps) isActive() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.active
}

func (f *fakeUfwDeps) getBeforeRules() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.beforeV4
}

func (f *fakeUfwDeps) getNatRules() []fakeNatRule {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]fakeNatRule{}, f.natRules...)
}

func (f *fakeUfwDeps) getFile(path string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	content, ok := f.extraFiles[path]
	return content, ok
}

func (f *fakeUfwDeps) setFile(path, content string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.extraFiles[path] = content
}

func (f *fakeUfwDeps) setRecent(value string, family string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if family == "v6" {
		f.recentV6 = value
		f.recentExistV6 = true
	} else {
		f.recentV4 = value
		f.recentExistV4 = true
	}
}

func (f *fakeUfwDeps) setDropCount(value int, family string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if family == "v6" {
		f.dropV6 = value
	} else {
		f.dropV4 = value
	}
}

func mapToUfwLines(lines []string) []string {
	out := make([]string, len(lines))
	for i, line := range lines {
		out[i] = "ufw " + line
	}
	return out
}

func containsStr(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}

func filterStr(list []string, keep func(string) bool) []string {
	out := []string{}
	for _, item := range list {
		if keep(item) {
			out = append(out, item)
		}
	}
	return out
}
