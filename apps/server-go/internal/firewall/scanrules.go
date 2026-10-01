package firewall

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"elysian/server/internal/shared"
)

// 端口防扫描的规则段与内核数据解析（scanRules.ts 等价物）。机制是内核 xt_recent 的
// 双名单 jail：监控端口的 TCP 新连接按源 IP 记入跟踪名单（--set）；判定窗口内达到
// 阈值 → 记入封锁名单并丢弃；已在封锁名单且未过封禁期 → 直接丢弃。封锁名单读
// /proc/net/xt_recent/ELYSIAN_SCAN_BANNED{,6}，解封即向该文件写「-IP」；拦截计数读
// iptables/ip6tables 规则包计数。开关状态与配置都以规则段文本为准——配置就持久化
// 在规则里。

const scanMarker = "### ELYSIAN 端口防扫描（自动管理，勿手工编辑）###"

// scanTables v4/v6 的链名、跟踪与封锁名单名（内核 recent 名单按名字隔离）。
type scanTablesOfFamily struct {
	Chain  string
	Track  string
	Banned string
}

var scanTables = map[string]scanTablesOfFamily{
	"v4": {Chain: "ufw-before-input", Track: "ELYSIAN_SCAN", Banned: "ELYSIAN_SCAN_BANNED"},
	"v6": {Chain: "ufw6-before-input", Track: "ELYSIAN_SCAN6", Banned: "ELYSIAN_SCAN_BANNED6"},
}

const (
	// ScanBannedRecentPath v4 封锁名单的内核 recent 文件。
	ScanBannedRecentPath = "/proc/net/xt_recent/ELYSIAN_SCAN_BANNED"
	// ScanBanned6RecentPath v6 封锁名单的内核 recent 文件。
	ScanBanned6RecentPath = "/proc/net/xt_recent/ELYSIAN_SCAN_BANNED6"
)

var (
	reScanConfig = regexp.MustCompile(`--dports ([\d,]+).*?--rcheck --seconds (\d+) --hitcount (\d+)`)
	reScanBan    = regexp.MustCompile(`--name ELYSIAN_SCAN_BANNED6? --rcheck --seconds (\d+)`)
	reRecentSrc  = regexp.MustCompile(`^src=(\S+)`)
)

// validateScanConfig 校验防扫描配置；不合法返回中文 400。判据是纯函数、不依赖开关
// 状态，因此调用方可以先校验请求再判前置状态：面板端口这条保底判据在「防扫描
// 未启用」时同样拦得住。校验通过时返回端口升序排序后的副本（落规则用）。
func validateScanConfig(config ScanConfig) (ScanConfig, error) {
	invalid := len(config.Ports) == 0
	for _, port := range config.Ports {
		if !jsIsInteger(port) || port < 1 || port > 65535 {
			invalid = true
			break
		}
	}
	if invalid {
		return ScanConfig{}, shared.InvalidRequest("监控端口无效：应为 1–65535 的端口列表")
	}
	// DROP 规则挂在 ufw-before-input 链里，先于保底放行匹配：监控面板端口会把面板
	// 客户端 IP 封进黑名单，且封禁后连解封端点本身都不可达。
	for _, port := range config.Ports {
		if port == float64(PanelPort) {
			return ScanConfig{}, shared.InvalidRequest(fmt.Sprintf("面板端口不允许加入防扫描监控：%d 是工作台自身的访问通道", PanelPort))
		}
	}
	if len(config.Ports) > 15 {
		return ScanConfig{}, shared.InvalidRequest(fmt.Sprintf("监控端口过多：%d 个（最多 15 个端口，内核 multiport 匹配上限）", len(config.Ports)))
	}
	if !jsIsInteger(config.WindowSeconds) || config.WindowSeconds < 10 || config.WindowSeconds > 3600 {
		return ScanConfig{}, shared.InvalidRequest(fmt.Sprintf("判定窗口无效：%s（应为 10–3600 秒）", jsNumberToString(config.WindowSeconds)))
	}
	if !jsIsInteger(config.HitCount) || config.HitCount < 3 || config.HitCount > 1000 {
		return ScanConfig{}, shared.InvalidRequest(fmt.Sprintf("阈值无效：%s（应为 3–1000 次）", jsNumberToString(config.HitCount)))
	}
	if !jsIsInteger(config.BanSeconds) || config.BanSeconds < 60 || config.BanSeconds > 86400 {
		return ScanConfig{}, shared.InvalidRequest(fmt.Sprintf("封禁时长无效：%s（应为 60–86400 秒）", jsNumberToString(config.BanSeconds)))
	}
	ports := make([]float64, len(config.Ports))
	copy(ports, config.Ports)
	sort.SliceStable(ports, func(i, j int) bool { return ports[i] < ports[j] })
	return ScanConfig{Ports: ports, WindowSeconds: config.WindowSeconds, HitCount: config.HitCount, BanSeconds: config.BanSeconds}, nil
}

func scanSectionLinesOf(config ScanConfig, family string) []string {
	tables := scanTables[family]
	ports := make([]string, len(config.Ports))
	for i, p := range config.Ports {
		ports[i] = strconv.FormatInt(int64(p), 10)
	}
	portList := strings.Join(ports, ",")
	return []string{
		fmt.Sprintf(`-A %s -p tcp -m multiport --dports %s -m conntrack --ctstate NEW -m recent --name %s --rcheck --seconds %d -j DROP`,
			tables.Chain, portList, tables.Banned, int64(config.BanSeconds)),
		fmt.Sprintf(`-A %s -p tcp -m multiport --dports %s -m conntrack --ctstate NEW -m recent --name %s --rcheck --seconds %d --hitcount %d -m recent --name %s --set -j DROP`,
			tables.Chain, portList, tables.Track, int64(config.WindowSeconds), int64(config.HitCount), tables.Banned),
		fmt.Sprintf(`-A %s -p tcp -m multiport --dports %s -m conntrack --ctstate NEW -m recent --name %s --set`,
			tables.Chain, portList, tables.Track),
	}
}

// scanSectionLines 完整的 v4 规则段文本（含首尾标记注释）；配置非法时返回错误。
func scanSectionLines(config ...ScanConfig) ([]string, error) {
	cfg := DefaultScanConfig()
	if len(config) > 0 {
		cfg = config[0]
	}
	valid, err := validateScanConfig(cfg)
	if err != nil {
		return nil, err
	}
	return append([]string{scanMarker}, append(scanSectionLinesOf(valid, "v4"), scanMarker)...), nil
}

// scanSectionState 规则段解析结果：开关状态与配置。
type scanSectionState struct {
	Enabled bool
	Config  ScanConfig
}

// parseScanSection 防扫描是否启用：规则文件里存在规则段；配置从规则文本解析回，
// 缺省回落默认配置。
func parseScanSection(beforeRules string) scanSectionState {
	if countMarkers(beforeRules, scanMarker) < 2 {
		return scanSectionState{Enabled: false, Config: DefaultScanConfig()}
	}

	configMatch := reScanConfig.FindStringSubmatch(beforeRules)
	banMatch := reScanBan.FindStringSubmatch(beforeRules)
	var ports []float64
	if configMatch != nil {
		for _, text := range strings.Split(configMatch[1], ",") {
			port, err := strconv.ParseFloat(text, 64)
			if err == nil {
				ports = append(ports, port)
			}
		}
	}
	if len(ports) == 0 {
		ports = append([]float64{}, DefaultScanConfig().Ports...)
	}
	window := float64(DefaultScanConfig().WindowSeconds)
	hit := float64(DefaultScanConfig().HitCount)
	ban := float64(DefaultScanConfig().BanSeconds)
	if configMatch != nil {
		if v, err := strconv.ParseFloat(configMatch[2], 64); err == nil && v != 0 {
			window = v
		}
		if v, err := strconv.ParseFloat(configMatch[3], 64); err == nil && v != 0 {
			hit = v
		}
	}
	if banMatch != nil {
		if v, err := strconv.ParseFloat(banMatch[1], 64); err == nil && v != 0 {
			ban = v
		}
	}
	return scanSectionState{Enabled: true, Config: ScanConfig{Ports: ports, WindowSeconds: window, HitCount: hit, BanSeconds: ban}}
}

// setScanSection 启用/停用并落配置：插进 filter 表的 COMMIT 之前（转发段的 *nat 块
// 另有 COMMIT，不能锚错表）；family 取 "v4" 或 "v6"（链名与名单名不同）。
func setScanSection(beforeRules string, enabled bool, config ScanConfig, family string) (string, error) {
	withoutSection := removeMarkedSection(beforeRules, scanMarker)
	if !enabled {
		return withoutSection, nil
	}

	valid, err := validateScanConfig(config)
	if err != nil {
		return "", err
	}
	lines := strings.Split(withoutSection, "\n")
	commitIndex := findFilterCommitIndex(lines)
	if commitIndex == -1 {
		return "", fmt.Errorf("before.rules 格式无效：找不到 filter 表的 COMMIT 行")
	}
	inserted := append([]string{scanMarker}, scanSectionLinesOf(valid, family)...)
	inserted = append(inserted, scanMarker)
	lines = append(lines[:commitIndex], append(inserted, lines[commitIndex:]...)...)
	return strings.Join(lines, "\n"), nil
}

// findFilterCommitIndex filter 表块的结束 COMMIT：从 `*filter` 行往后找第一个 COMMIT。
func findFilterCommitIndex(lines []string) int {
	filterStart := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "*filter" {
			filterStart = i
			break
		}
	}
	if filterStart == -1 {
		return -1
	}
	for i := filterStart + 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "COMMIT" {
			return i
		}
	}
	return -1
}

func countMarkers(text string, marker string) int {
	count := 0
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == marker {
			count++
		}
	}
	return count
}

// parseRecentList 解析 /proc/net/xt_recent/<banned> 的封锁名单，行形如：
// `src=203.0.113.9 ttl: 64 last_seen: 5123456 oldest_pkt: 1 newest_pkt: 5123456`。
func parseRecentList(recentText string) []string {
	ips := []string{}
	for _, line := range strings.Split(recentText, "\n") {
		m := reRecentSrc.FindStringSubmatch(strings.TrimSpace(line))
		if m != nil {
			ips = append(ips, m[1])
		}
	}
	return ips
}

// validateUnblockIp 解封参数校验：必须是合法 IP（内核 recent 名单不接受网段）。
// 非法时返回中文 500 错误（写内核接口的系统侧失败，不是请求体形态问题）。
func validateUnblockIp(ip string) (string, error) {
	trimmed := strings.TrimSpace(ip)
	if !isValidFirewallAddress(trimmed) || strings.Contains(trimmed, "/") {
		return "", fmt.Errorf("IP 无效：%s（应为合法 IP，不含网段）", ip)
	}
	return trimmed, nil
}

// parseDropCounter 从 `iptables -L <chain> -nvx` 输出解析防扫描 DROP 规则的累计拦截
// 包数（双 DROP 规则求和：封禁期丢弃 + 触发阈值那一次丢弃）。
func parseDropCounter(listOutput string) int {
	total := 0
	for _, line := range strings.Split(listOutput, "\n") {
		if !strings.Contains(line, "ELYSIAN_SCAN") || !strings.Contains(line, "DROP") {
			continue
		}
		columns := strings.Fields(strings.TrimSpace(line))
		if len(columns) == 0 {
			continue
		}
		pkts, err := strconv.Atoi(columns[0])
		if err != nil {
			continue
		}
		total += pkts
	}
	return total
}
