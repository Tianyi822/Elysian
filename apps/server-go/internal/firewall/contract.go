package firewall

import "elysian/server/internal/contract"

// 防火墙域视图模型与常量（packages/foundation/contracts/src/security/firewall.ts 的
// Go 版等价物）。总纲 §4.4 把 PANEL_PORT、DEFAULT_SCAN_CONFIG、协议/策略表列在
// internal/contract 的骨架清单里，骨架尚未预置（已登记 gaps）；这些常量当前只被
// 本域消费，先落在本包内定义一次、不硬编码两处，待集成阶段收口到 contract。
//
// 结构体字段声明序即 JSON 键序（对齐 TS JSON.stringify 的插入序，go-plan §3.3）。

// PanelPort 面板对外端口：工作台自身的访问通道（唯一权威在契约；迁移期待收口）。
const PanelPort = contract.PanelPort

// SourceAllIPs 端口规则来源的「所有IP」文案（映射 ufw 的 any）。
const SourceAllIPs = "所有IP"

// firewallProtocols 防火墙协议表（FIREWALL_PROTOCOLS）。
var firewallProtocols = []string{"tcp", "udp"}

// DefaultScanConfig 防扫描默认配置：扫描高发端口、60 秒窗口 8 次阈值、1 小时封禁。
func DefaultScanConfig() ScanConfig {
	return ScanConfig{
		Ports:         []float64{22, 23, 3306, 3389, 5900, 6379},
		WindowSeconds: 60,
		HitCount:      8,
		BanSeconds:    3600,
	}
}

// FirewallRule 端口规则界面行。
type FirewallRule struct {
	ID        string  `json:"id"`
	Protocol  string  `json:"protocol"`
	Port      int     `json:"port"`
	PortTo    *int    `json:"portTo"`
	Family    string  `json:"family"`
	Status    string  `json:"status"`
	Policy    string  `json:"policy"`
	Direction string  `json:"direction"`
	Source    string  `json:"source"`
	Note      *string `json:"note"`
	UpdatedAt *string `json:"updatedAt"`
}

// FirewallIpRule IP 规则界面行（纯来源封禁，无端口）。
type FirewallIpRule struct {
	ID        string  `json:"id"`
	Source    string  `json:"source"`
	Family    string  `json:"family"`
	Policy    string  `json:"policy"`
	Note      *string `json:"note"`
	UpdatedAt *string `json:"updatedAt"`
}

// FirewallForwardRule 端口转发界面行。
type FirewallForwardRule struct {
	ID         string  `json:"id"`
	Protocol   string  `json:"protocol"`
	Port       int     `json:"port"`
	PortTo     *int    `json:"portTo"`
	TargetHost string  `json:"targetHost"`
	TargetPort int     `json:"targetPort"`
	Note       *string `json:"note"`
	UpdatedAt  *string `json:"updatedAt"`
}

// FirewallToggles 防火墙级开关与默认策略（未激活时默认策略为 null）。
type FirewallToggles struct {
	FirewallEnabled bool    `json:"firewallEnabled"`
	PingBlocked     bool    `json:"pingBlocked"`
	DefaultIncoming *string `json:"defaultIncoming"`
	DefaultOutgoing *string `json:"defaultOutgoing"`
}

// ScanConfig 防扫描配置。字段用 float64 承载路由层 Number() 宽进的结果
// （字符串数字可过、垃圾变 NaN，由 ValidateScanConfig 拒）。
type ScanConfig struct {
	Ports         []float64 `json:"ports"`
	WindowSeconds float64   `json:"windowSeconds"`
	HitCount      float64   `json:"hitCount"`
	BanSeconds    float64   `json:"banSeconds"`
}

// FirewallScanStats 防扫描统计。
type FirewallScanStats struct {
	TotalBlockedIps          int `json:"totalBlockedIps"`
	TotalFailedConnections   int `json:"totalFailedConnections"`
	CurrentBlockedIps        int `json:"currentBlockedIps"`
	CurrentFailedConnections int `json:"currentFailedConnections"`
}

// FirewallBlockedIp 封锁名单条目。
type FirewallBlockedIp struct {
	IP        string `json:"ip"`
	BlockedAt string `json:"blockedAt"`
}

// FirewallScanProtection 防扫描全景（GET/POST/PUT scan 端点的响应体直接就是它）。
type FirewallScanProtection struct {
	Enabled bool                `json:"enabled"`
	Config  ScanConfig          `json:"config"`
	Stats   FirewallScanStats   `json:"stats"`
	Blocked []FirewallBlockedIp `json:"blocked"`
}

// ImportResult 批量导入结果：新增的规则与因重复被跳过的数量。
type ImportResult struct {
	Added   []FirewallRule `json:"added"`
	Skipped int            `json:"skipped"`
}

// RuleInput 新建或修改端口规则的输入（路由层宽进后的形状；Port 为 NaN 时由
// 服务层校验拒绝，错误消息按 JS String(number) 格式化）。
type RuleInput struct {
	Protocol  string
	Port      float64
	PortTo    *float64
	Family    string
	Policy    string
	Direction string
	Source    string
	Note      *string
}

// IpRuleInput 新建或修改 IP 规则的输入。
type IpRuleInput struct {
	Policy string
	Source string
	Note   *string
}

// ForwardInput 新建或修改端口转发的输入。
type ForwardInput struct {
	Protocol   string
	Port       float64
	PortTo     *float64
	TargetHost string
	TargetPort float64
	Note       *string
}
