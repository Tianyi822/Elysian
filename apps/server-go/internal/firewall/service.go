package firewall

import (
	"strconv"
	"sync"

	"elysian/server/internal/config"
)

// 防火墙面板的服务编排（firewallService.ts 等价物）：把界面动作翻译成容器内 ufw 的
// 真实命令。全部系统访问经 hostDeps 注入，编排逻辑在测试里用 fake 依赖驱动。
//
// 防锁死保底：实际入口在启用防火墙前确保放行（核验 IPv4 与已启用的 IPv6，
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

// panelSpec 面板保底规则规范；panelCanonical 是它的指纹。
var panelSpec = ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: strconv.Itoa(PanelPort), From: "any"}

var panelCanonical = canonicalId(panelSpec)

// service FirewallAdapter 的实现（一个进程一个实例，内存态即进程级）。
type service struct {
	panelPort      int
	entryPort      int
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
		entryPort:       panelPort,
		backendPort:     backendPort,
		panelCanonical:  canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: strconv.Itoa(panelPort), From: "any"}),
		deps:            deps,
		paths:           deps.Paths(),
		updatedAtMap:    map[string]string{},
		scanSeenIPs:     map[string]bool{},
		scanFirstSeenAt: map[string]string{},
	}
}

// 配置端口用于禁区，实际入口用于保底：开发容器接受前端容器的 API 请求。
func newServiceForMode(deps hostDeps, network config.PanelNetwork, mode config.RuntimeMode) Service {
	s := newServiceWithPorts(deps, network.FrontendPort, network.BackendPort).(*service)
	if mode == config.ModeDocker {
		s.entryPort = config.ListenPort
		s.panelCanonical = canonicalId(ufwRuleSpec{Action: "allow", Direction: "in", Proto: "tcp", Port: strconv.Itoa(s.entryPort), From: "any"})
	}
	return s
}

// serialize 串行队列：与 TS serializeRulesWrite 同覆盖面（规则文件的读-改-写互斥）。
func (s *service) serialize(critical func() error) error {
	s.rulesWriteMu.Lock()
	defer s.rulesWriteMu.Unlock()
	return critical()
}
