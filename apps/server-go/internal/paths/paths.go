// Package paths 是 ~/.Elysian 路径表的唯一出口（go-plan §3.2），与
// apps/server/src/shared/elysianPaths.ts 逐条同名等价。
//
// 以 os.UserHomeDir() 解析 home（TS os.homedir() 等价物）；容器内 /root/.Elysian →
// /var/lib/elysian 的符号链接由 compose 启动命令建立，代码不感知链接，一律经
// UserHomeDir 走真实路径。
//
// 面板自管数据统一放部署机器的 ~/.Elysian 下、按类别分目录：data/（metrics.sqlite、
// firewall.sqlite、harness.sqlite）、logs/（sshd.log）、state/（启停与密码重置时间戳）、backups/
// （写系统文件前的应用侧备份）、tmp/（密钥生成工作区）、config/（面板凭据、单点登录
// 回跳白名单、数据库与网站登记）。系统自身文件（/etc/ufw、/etc/ssh/sshd_config、
// authorized_keys）不属于面板数据，路径常量定义在各域内。MetricsSqlite 仅保留路径常量
// （服务端无 metrics 域）。
package paths

import (
	"fmt"
	"os"
	"path/filepath"
)

var (
	// ElysianHome 面板自管数据根：~/.Elysian。
	ElysianHome = filepath.Join(mustHome(), ".Elysian")
	// DataDir 数据库：metrics 指标库、防火墙规则时间账本与 Agent 任务事实库。
	DataDir = filepath.Join(ElysianHome, "data")
	// LogsDir 日志：面板托管的 sshd 定向日志。
	LogsDir = filepath.Join(ElysianHome, "logs")
	// PlatformLogsDir 平台日志根：面板自己写、自己管的运行日志与操作日志（不含 sshd.log）。
	PlatformLogsDir = filepath.Join(LogsDir, "platform")
	// StateDir 状态：面板自己记录的事实时间戳（启停、密码重置）。
	StateDir = filepath.Join(ElysianHome, "state")
	// BackupsDir 备份：写系统文件前的应用侧备份（如 before.rules）。
	BackupsDir = filepath.Join(ElysianHome, "backups")
	// TmpDir 临时：密钥生成等工作区，即生即灭。
	TmpDir = filepath.Join(ElysianHome, "tmp")
	// ConfigDir 配置：面板自管的配置文件（凭据、数据库与网站登记）。
	ConfigDir = filepath.Join(ElysianHome, "config")
	// HostKeysDir sshd 主机密钥：持久在卷上，/etc/ssh/ssh_host_* 以符号链接指向这里。
	HostKeysDir = filepath.Join(ElysianHome, "ssh", "host-keys")
)

// ElysianPaths ~/.Elysian 下的具体文件路径表（TS 侧 ELYSIAN_PATHS 的等价物）。
type ElysianPaths struct {
	// MetricsSqlite metrics 指标库路径（仅保留常量，服务端无 metrics 域）。
	MetricsSqlite string
	// FirewallSqlite 防火墙规则时间账本。
	FirewallSqlite string
	// LogsSqlite 面板日志库（运行/操作/登录三表）。
	LogsSqlite string
	// HarnessSqlite Agent 任务、运行、工具调用与事件事实库。
	HarnessSqlite string
	// AgentModels 模型配置与仅父进程读取的凭据。
	AgentModels     string
	AgentSkills     string
	AgentMCPServers string
	AgentExecution  string
	SkillPackages   string
	AgentWorkspaces string
	// SshdLog 面板托管的 sshd 定向日志。
	SshdLog string
	// PlatformLogsDir 平台日志根。
	PlatformLogsDir string
	// RuntimeLogsDir 运行日志目录。
	RuntimeLogsDir string
	// OperationLogsDir 操作日志目录。
	OperationLogsDir string
	// SshChangedAt SSH 配置最近变更时间戳。
	SshChangedAt string
	// SshRootPasswordResetAt root 密码最近重置时间戳。
	SshRootPasswordResetAt string
	// PanelCredentials 面板登录凭据（单用户 admin，scrypt 哈希，0600）。
	PanelCredentials string
	// SsoReturnOrigins 单点登录的回跳白名单（用户手写、面板只读；缺失即不开放跳转）。
	SsoReturnOrigins string
	// PanelSessions 面板会话文件（服务端权威，0600）：重启不掉线、改密即全失效的载体。
	PanelSessions string
	// WebsiteRuntimeCatalog 网站运行时目录缓存。
	WebsiteRuntimeCatalog string
	// KeygenWorkspace 密钥生成工作区。
	KeygenWorkspace string
}

// Default 按当前用户 home 计算的路径表；进程内共享同一份。
var Default = buildPaths()

func buildPaths() ElysianPaths {
	return ElysianPaths{
		MetricsSqlite:          filepath.Join(DataDir, "metrics.sqlite"),
		FirewallSqlite:         filepath.Join(DataDir, "firewall.sqlite"),
		LogsSqlite:             filepath.Join(DataDir, "logs.sqlite"),
		HarnessSqlite:          filepath.Join(DataDir, "harness.sqlite"),
		AgentModels:            filepath.Join(ConfigDir, "agent-models.json"),
		AgentSkills:            filepath.Join(ConfigDir, "agent-skills.json"),
		AgentMCPServers:        filepath.Join(ConfigDir, "agent-mcp-servers.json"),
		AgentExecution:         filepath.Join(ConfigDir, "agent-execution.json"),
		SkillPackages:          filepath.Join(DataDir, "skills"),
		AgentWorkspaces:        filepath.Join(DataDir, "agent-workspaces"),
		SshdLog:                filepath.Join(LogsDir, "sshd.log"),
		PlatformLogsDir:        PlatformLogsDir,
		RuntimeLogsDir:         filepath.Join(PlatformLogsDir, "runtime"),
		OperationLogsDir:       filepath.Join(PlatformLogsDir, "operation"),
		SshChangedAt:           filepath.Join(StateDir, "ssh-changed-at"),
		SshRootPasswordResetAt: filepath.Join(StateDir, "ssh-root-password-reset-at"),
		PanelCredentials:       filepath.Join(ConfigDir, "panel-credentials.json"),
		SsoReturnOrigins:       filepath.Join(ConfigDir, "sso-return-origins.json"),
		PanelSessions:          filepath.Join(StateDir, "panel-sessions.json"),
		WebsiteRuntimeCatalog:  filepath.Join(StateDir, "website-runtime-catalog.json"),
		KeygenWorkspace:        filepath.Join(TmpDir, "ssh-keygen"),
	}
}

// mustHome 解析当前用户主目录；面板一切自管路径都挂在它下面，解析失败即无法工作。
func mustHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		panic(fmt.Sprintf("无法解析用户主目录：%v", err))
	}
	return home
}
