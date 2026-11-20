package firewall

import (
	"fmt"
	"strings"

	"elysian/server/internal/shared"
)

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
	nextV4, err := setScanSection(beforeV4, enabled, config, "v4", s.panelPort, s.backendPort, s.entryPort)
	if err != nil {
		return err
	}
	if err := writeRulesFileWithBackup(s.deps, s.paths.BeforeRules, nextV4); err != nil {
		return err
	}
	if beforeV6 != nil {
		nextV6, err := setScanSection(*beforeV6, enabled, config, "v6", s.panelPort, s.backendPort, s.entryPort)
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
		if _, err := validateScanConfig(config, s.panelPort, s.backendPort, s.entryPort); err != nil {
			return err
		}
		beforeRules, err := s.deps.ReadText(s.paths.BeforeRules)
		if err != nil {
			return err
		}
		if !parseScanSection(beforeRules).Enabled {
			// 前置状态不满足：配置本身可能完全合法，只是开关没开 → 409（不是请求体错误）。
			return shared.Conflict("防扫描未启用：先开启开关再调整配置")
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
