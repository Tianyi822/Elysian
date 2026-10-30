package firewall

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"elysian/server/internal/config"
	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// SSH 换端口先放行后切换；保留用户拒绝规则及旧端口规则。
type sshPortOpener struct {
	host    hostDeps
	backend int
	mu      sync.Mutex
}

func NewSshPortOpener(deps Deps) seam.PortOpener {
	if !deps.Available {
		return seam.NoopPortOpener()
	}
	ports := deps.Ports
	if ports == (config.PanelNetwork{}) {
		ports = config.DefaultPanelNetwork()
	}
	return &sshPortOpener{host: newExecHostDeps("", deps.Now), backend: ports.BackendPort}
}

func (p *sshPortOpener) EnsurePortRule(ctx context.Context, port int, note string) contract.FirewallPortSync {
	p.mu.Lock()
	defer p.mu.Unlock()
	result := contract.FirewallPortSync{Port: port, State: contract.FirewallPortSyncFailed}
	fail := func(detail string) contract.FirewallPortSync { result.Detail = &detail; return result }
	if err := ctx.Err(); err != nil {
		return fail("SSH 防火墙检查已中止")
	}
	if port == p.backend {
		return fail("面板后端端口不能对外开放")
	}
	status, err := p.host.RunUfw([]string{"status", "verbose"})
	if err != nil {
		return fail("无法读取防火墙状态：" + err.Error())
	}
	if !strings.Contains(status, "Status: active") && !strings.Contains(status, "Status: inactive") {
		return fail("无法确认防火墙启用状态")
	}
	parsedStatus, parseErr := parseStatusVerbose(status)
	if parseErr != nil {
		return fail(parseErr.Error())
	}
	if !parsedStatus.Active {
		result.State = contract.FirewallPortSyncSkipped
		detail := "防火墙未启用，启用前请确认 SSH 端口已放行"
		result.Detail = &detail
		return result
	}
	added, err := p.host.RunUfw([]string{"show", "added"})
	if err != nil {
		return fail(err.Error())
	}
	lines := parseShowAdded(added)
	for _, line := range lines {
		if line.Kind == "port" && line.Spec.Direction == "in" && line.Spec.Proto != "udp" && (line.Spec.Action == "deny" || line.Spec.Action == "reject") && sshPortCovered(line.Spec.Port, port) {
			return fail(fmt.Sprintf("端口 %d 存在入站拒绝规则，请先到防火墙页处理", port))
		}
	}
	existing := false
	for _, line := range lines {
		if line.Kind == "port" && line.Spec.Direction == "in" && line.Spec.Proto == "tcp" && line.Spec.Port == strconv.Itoa(port) && line.Spec.From == "any" && (line.Spec.Action == "allow" || line.Spec.Action == "limit") {
			existing = true
		}
	}
	if !existing {
		count := 0
		for _, line := range lines {
			if line.Kind == "port" {
				count++
			}
		}
		if count >= firewallLimitUserRules {
			return fail("防火墙端口规则已达上限")
		}
		if _, err = p.host.RunUfw([]string{"allow", strconv.Itoa(port) + "/tcp", "comment", note}); err != nil {
			return fail(err.Error())
		}
	}
	after, err := p.host.RunUfw([]string{"status", "verbose"})
	if err != nil {
		return fail(err.Error())
	}
	defaults, err := p.host.ReadText(p.host.Paths().DefaultUfw)
	if err != nil {
		return fail("无法读取 UFW 地址族配置：" + err.Error())
	}
	rows := parseStatusRows(after)
	allows := func(v6 bool) bool {
		for _, row := range rows {
			if row.V6 == v6 && (row.Action == "allow" || row.Action == "limit") && row.Direction == "in" && row.To == fmt.Sprintf("%d/tcp", port) && row.From == "Anywhere" {
				return true
			}
		}
		return false
	}
	if !allows(false) || (parseIpv6Enabled(defaults) && !allows(true)) {
		return fail("SSH 端口放行复核失败：缺少 IPv4 或已启用的 IPv6 入站规则")
	}
	result.State = contract.FirewallPortSyncOpened
	if existing {
		result.State = contract.FirewallPortSyncSkipped
		detail := "防火墙已有该端口的入站放行规则"
		result.Detail = &detail
	}
	return result
}

func sshPortCovered(raw string, port int) bool {
	parts := strings.Split(raw, ":")
	low, err := strconv.Atoi(parts[0])
	if err != nil {
		return false
	}
	high := low
	if len(parts) == 2 {
		high, _ = strconv.Atoi(parts[1])
	}
	return port >= low && port <= high
}
