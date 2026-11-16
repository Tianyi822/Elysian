package firewall

import (
	"fmt"
	"sort"

	"elysian/server/internal/shared"
)

// SetRuleScanProtection 在同一个文件写锁内合并端口，避免客户端全量配置覆盖
// 其它端口。关闭状态从空集合启用，不会连带启用缺省的高风险端口。
func (s *service) SetRuleScanProtection(ruleID string, enabled bool) (FirewallScanProtection, error) {
	var result FirewallScanProtection
	err := s.serialize(func() error {
		rules, err := s.List()
		if err != nil {
			return err
		}
		var target *FirewallRule
		for i := range rules {
			if rules[i].ID == ruleID {
				target = &rules[i]
				break
			}
		}
		if target == nil {
			return shared.InvalidRequest("端口规则不存在，请先刷新规则")
		}
		if target.Protocol != "tcp" || target.Direction != "inbound" {
			return shared.InvalidRequest("防扫描仅适用于 TCP 入站端口")
		}
		end := target.Port
		if target.PortTo != nil {
			end = *target.PortTo
		}
		if enabled && end-target.Port+1 > 15 {
			return shared.InvalidRequest("防扫描最多监控 15 个端口")
		}
		before, err := s.deps.ReadText(s.paths.BeforeRules)
		if err != nil {
			return err
		}
		current := parseScanSection(before)
		config := current.Config
		ports := map[int]bool{}
		if current.Enabled {
			for _, p := range config.Ports {
				ports[int(p)] = true
			}
		}
		if enabled {
			for p := target.Port; p <= end; p++ {
				ports[p] = true
			}
		} else {
			for p := range ports {
				if p >= target.Port && p <= end {
					delete(ports, p)
				}
			}
		}
		config.Ports = []float64{}
		for p := range ports {
			config.Ports = append(config.Ports, float64(p))
		}
		sort.Float64s(config.Ports)
		active := len(config.Ports) > 0
		unchanged := active == current.Enabled && len(config.Ports) == len(current.Config.Ports)
		if unchanged {
			for _, p := range current.Config.Ports {
				unchanged = unchanged && ports[int(p)]
			}
		}
		if unchanged || (!active && !current.Enabled) {
			result, err = s.readScanProtection()
			return err
		}
		if active {
			if _, err := validateScanConfig(config, s.panelPort, s.backendPort, s.entryPort); err != nil {
				return err
			}
		}
		if err := s.writeScanSection(active, config); err != nil {
			return fmt.Errorf("防扫描设置失败：%w", err)
		}
		if active && !current.Enabled {
			s.memMu.Lock()
			s.scanDropSnapshot = 0
			s.memMu.Unlock()
		}
		result, err = s.readScanProtection()
		return err
	})
	return result, err
}
