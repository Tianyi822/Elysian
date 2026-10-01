package shared

// API 挂载路径常量：app 装配、各域 404 兜底剥前缀与
// 操作日志描述符表共用同一份字面量——单一事实，多处不漂移。web 侧测试按字面量
// 抄写同值清单（apps/web/src/adapters/http/proxyTable.test.ts），两侧共同锚定。
const (
	// AuthMount 登录鉴权片挂载点。
	AuthMount = "/api/auth"
	// DockerMount 容器管理片挂载点。
	DockerMount = "/api/docker"
	// DatabaseMount 数据库片挂载点。
	DatabaseMount = "/api/databases"
	// FilesMount 文件管理片挂载点。
	FilesMount = "/api/files"
	// FirewallMount 防火墙片挂载点。
	FirewallMount = "/api/security/firewall"
	// LogsMount 平台日志片挂载点。
	LogsMount = "/api/logs"
	// PlatformMount 平台片挂载点（memory 与 dependencies 同挂此处）。
	PlatformMount = "/api/platform"
	// SshMount SSH 片挂载点。
	SshMount = "/api/security/ssh"
	// TerminalMount 终端片挂载点。
	TerminalMount = "/api/terminals"
	// UsersMount 用户管理片挂载点。
	UsersMount = "/api/security/users"
	// WebsitesMount 网站管理片挂载点。
	WebsitesMount = "/api/websites"
	// HealthPath 存活检查端点（鉴权豁免清单之首，无守卫）。
	HealthPath = "/api/health"
)
