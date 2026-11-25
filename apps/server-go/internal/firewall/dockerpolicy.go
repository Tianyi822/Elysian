package firewall

import (
	"fmt"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

const dockerInputChain = "ELYSIAN-DOCKER-IN"

var (
	xtablesWord   = regexp.MustCompile(`"(?:[^"\\]|\\.)*"|[^\s"]+`)
	xtablesIface  = regexp.MustCompile(`^[\w.:@-]+\+?$`)
	xtablesPorts  = regexp.MustCompile(`^\d{1,5}(?::\d{1,5})?(?:,\d{1,5}(?::\d{1,5})?)*$`)
	xtablesRecent = regexp.MustCompile(`^\w+$`)
)

// projectDockerInput uses UFW's ordered iptables-restore rules, including rules
// which ufw show added (or the panel's parser of that output) cannot represent.
// The destination address and port must refer to the original conntrack tuple.
func projectDockerInput(userRules, beforeRules string, ipv6 bool) ([]string, error) {
	prefix, scanFamily := "ufw", "v4"
	if ipv6 {
		prefix, scanFamily = "ufw6", "v6"
	}
	rules := dockerEstablished()
	if !ipv6 {
		for _, forward := range parseForwardSection(beforeRules) {
			rules = append(rules, fmt.Sprintf("-p %s -d %s --dport %d -m conntrack --ctorigdstport %s -j RETURN",
				forward.Protocol, forward.TargetHost, forward.TargetPort, forward.Port))
		}
	}
	scan := parseScanSection(beforeRules)
	if scan.Enabled {
		for _, line := range scanSectionLinesOf(scan.Config, scanFamily) {
			args := xtablesWord.FindAllString(line, -1)
			projected, err := projectDockerRule(args[2:], prefix)
			if err != nil {
				return nil, err
			}
			rules = append(rules, projected...)
		}
	}
	declared, committed := false, false
	for i, line := range strings.Split(userRules, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, ":"+prefix+"-user-input ") {
			declared = true
		}
		if line == "COMMIT" && declared {
			committed = true
		}
		if line == "" || line[0] == '#' || line[0] == ':' {
			continue
		}
		args := xtablesWord.FindAllString(line, -1)
		if len(args) < 2 || args[1] != prefix+"-user-input" {
			continue
		}
		if args[0] != "-A" {
			return nil, fmt.Errorf("%s 入站规则第 %d 行包含无法同步的链操作 %s", prefix, i+1, args[0])
		}
		projected, err := projectDockerRule(args[2:], prefix)
		if err != nil {
			return nil, fmt.Errorf("%s 入站规则第 %d 行无法同步到 Docker：%w", prefix, i+1, err)
		}
		rules = append(rules, projected...)
	}
	if !declared || !committed {
		return nil, fmt.Errorf("UFW 规则文件缺少完整的 %s-user-input 规则段", prefix)
	}
	return append(rules, "-j DROP"), nil
}

func dockerEstablished() []string {
	return []string{"-m conntrack --ctstate ESTABLISHED,RELATED -j RETURN"}
}

func projectDockerRule(args []string, prefix string) ([]string, error) {
	// Docker port publishing uses TCP, UDP or SCTP.
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-p" {
			switch args[i+1] {
			case "all", "tcp", "udp", "sctp", "6", "17", "132":
			default:
				if i == 0 || args[i-1] != "!" {
					return nil, nil
				}
			}
		}
	}

	var matches, recent []string
	var originalDestination, destinationPorts, state, action, rejectWith, multiSource string
	var negate bool
	for len(args) > 0 {
		flag := args[0]
		args = args[1:]
		if flag == "!" && !negate {
			negate = true
			continue
		}
		if !negate && (flag == "--set" || flag == "--update" || flag == "--rcheck" || flag == "--rsource") {
			recent = append(recent, flag)
			continue
		}
		if len(args) == 0 {
			return nil, fmt.Errorf("缺少 %q 的值", flag)
		}
		value := args[0]
		args = args[1:]
		if negate && flag != "-s" && flag != "-i" {
			return nil, fmt.Errorf("无法转换取反条件 %q", flag)
		}
		switch flag {
		case "-p":
			matches = append(matches, flag, value)
		case "-s", "-d":
			if _, err := netip.ParsePrefix(value); err != nil {
				if _, err = netip.ParseAddr(value); err != nil {
					return nil, fmt.Errorf("无效地址 %q", value)
				}
			}
			if flag == "-d" {
				originalDestination = value
				break
			}
			if negate {
				matches = append(matches, "!")
			}
			matches = append(matches, flag, value)
		case "-i":
			if !xtablesIface.MatchString(value) {
				return nil, fmt.Errorf("无效入站接口 %q", value)
			}
			if negate {
				matches = append(matches, "!")
			}
			matches = append(matches, flag, value)
		case "--dport", "--dports", "--sport", "--sports":
			if !xtablesPorts.MatchString(value) {
				return nil, fmt.Errorf("无效端口 %q", value)
			}
			switch flag {
			case "--dport", "--dports":
				destinationPorts = value
			case "--sport":
				matches = append(matches, flag, value)
			case "--sports":
				multiSource = value
			}
		case "-m":
			switch value {
			case "conntrack", "recent", "multiport", "tcp", "udp", "sctp", "comment":
			default:
				return nil, fmt.Errorf("不支持匹配模块 %q", value)
			}
		case "--ctstate":
			if value != "NEW" {
				return nil, fmt.Errorf("不支持连接状态 %q", value)
			}
			state = value
		case "--seconds", "--hitcount":
			if n, err := strconv.ParseUint(value, 10, 32); err != nil || n == 0 {
				return nil, fmt.Errorf("无效的 %s %q", flag, value)
			}
			recent = append(recent, flag, value)
		case "--name":
			if !xtablesRecent.MatchString(value) {
				return nil, fmt.Errorf("无效的 recent 名称 %q", value)
			}
			if len(recent) > 0 {
				recent = append(recent, "-m", "recent")
			}
			recent = append(recent, flag, value)
		case "--comment":
			// Comments have no effect on the decision and may contain quotes.
		case "-j":
			switch value {
			case "ACCEPT", prefix + "-user-limit-accept":
				action = "RETURN"
			case "DROP", "REJECT":
				action = value
			case prefix + "-user-limit":
				action = "REJECT"
			case prefix + "-user-logging-input":
				// The next UFW rule supplies the actual verdict.
				return nil, nil
			default:
				return nil, fmt.Errorf("不支持规则目标 %q", value)
			}
		case "--reject-with":
			rejectWith = value
		default:
			return nil, fmt.Errorf("不支持规则参数 %q", flag)
		}
		negate = false
	}
	if negate || (action == "" && len(recent) == 0) {
		return nil, fmt.Errorf("规则缺少可识别的动作")
	}
	if multiSource != "" {
		matches = append(matches, "-m", "multiport", "--sports", multiSource)
	}
	var rules []string
	for _, port := range strings.Split(destinationPorts, ",") {
		line := append([]string(nil), matches...)
		if state != "" || originalDestination != "" || port != "" {
			line = append(line, "-m", "conntrack")
		}
		if state != "" {
			line = append(line, "--ctstate", state)
		}
		if originalDestination != "" {
			line = append(line, "--ctorigdst", originalDestination)
		}
		if port != "" {
			line = append(line, "--ctorigdstport", port)
		}
		if len(recent) != 0 {
			line = append(line, "-m", "recent")
			line = append(line, recent...)
		}
		if action != "" {
			line = append(line, "-j", action)
		}
		if rejectWith != "" {
			if action != "REJECT" || !xtablesIface.MatchString(rejectWith) {
				return nil, fmt.Errorf("无效的拒绝模式 %q", rejectWith)
			}
			line = append(line, "--reject-with", rejectWith)
		}
		rules = append(rules, strings.Join(line, " "))
	}
	return rules, nil
}
