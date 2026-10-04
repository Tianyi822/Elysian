// Package config 是运行模式与环境变量的唯一出口（go-plan §3.1）：一次性读 env 产出
// 不可变 *Config，域包不读 env、不读 /.dockerenv，一切模式事实经装配层以 Deps 字段注入。
//
// 环境变量全表（全集，不新增未登记变量）：
//
//	ELYSIAN_DOCKER            严格等于 "1" 才开；缺省关。声明容器模式。
//	ELYSIAN_BARE_METAL        严格等于 "1" 才开；缺省关。声明裸机直执模式；与
//	                          ELYSIAN_DOCKER=1 同设由 main 启动即失败退出。
//	ELYSIAN_AUTH_DEV          严格等于 "1" 才开；缺省关。dev 固定账号 dev / dev-elysian。
//	ELYSIAN_COOKIE_SECURE     严格等于 "1" 才开；缺省关。Cookie 追加 "; Secure"。
//	ELYSIAN_DOCKER_SOCKET     非空生效；缺省 /var/run/docker.sock。Engine socket 路径。
//	ELYSIAN_CADDY_SOCKET      非空生效；缺省 /run/caddy/admin.sock。Caddy admin socket。
//	ELYSIAN_DOCKER_MOUNT_ROOT 非空生效；缺省 /srv。绑定挂载根（docker 域读取）。
//	ELYSIAN_LISTEN_HOST       非空生效；缺省 127.0.0.1。HTTP 监听地址。
//	ELYSIAN_APP_BUILD_TIMEOUT_SECONDS          正整数生效；缺省 1200。容器应用镜像
//	                                          构建的单镜像时限（秒，ADR-0021）。
//	ELYSIAN_APP_BUILD_TASK_TIMEOUT_SECONDS     正整数生效；缺省 3600。构建整任务时限。
//	ELYSIAN_APP_BUILD_CONCURRENCY              正整数生效；缺省 1。全局同时构建任务数。
//	ELYSIAN_APP_BUILD_LOG_BYTES                正整数生效；缺省 2097152。单任务构建
//	                                          日志保留上限（字节）。
//
// ELYSIAN_APP_BUILD_* 四个变量不走本包：读 env 只发生在仅由装配层调用的各域导出
// production* 构造器（containerapps.NewProductionBuildManager 与 websites 域
// productionDeploymentManager 同一口径），config.Config 不携带这批变量。
//
// Docker 开发端口固定 48101；正式安装端口由 panel-network.json 提供，后端固定回环。
package config

import "os"

// ListenPort 是开发运行时的后端默认端口。
const ListenPort = 48101

// 环境变量缺省值。
const (
	defaultDockerSocket = "/var/run/docker.sock"
	defaultCaddySocket  = "/run/caddy/admin.sock"
	defaultMountRoot    = "/srv"
	defaultListenHost   = "127.0.0.1"

	dockerEnvMarker = "/.dockerenv"
)

// RuntimeMode 运行模式判定结果（go-plan §3.1）。
type RuntimeMode int

const (
	// ModeLocalDemo 本地非 Docker 演示（缺省）。
	ModeLocalDemo RuntimeMode = iota
	// ModeDocker ELYSIAN_DOCKER=1 且 /.dockerenv 存在（双闸门，现状语义）。
	ModeDocker
	// ModeBareMetal ELYSIAN_BARE_METAL=1 裸机直执。
	ModeBareMetal
)

// Config 一次性读取的环境变量快照；构造后不再变化。
type Config struct {
	Network PanelNetwork

	// Docker 是 ELYSIAN_DOCKER 严格等于 "1" 的判定结果。
	Docker bool
	// BareMetal 是 ELYSIAN_BARE_METAL 严格等于 "1" 的判定结果。
	BareMetal bool
	// AuthDev 是 ELYSIAN_AUTH_DEV 严格等于 "1" 的判定结果（dev 固定账号开关）。
	AuthDev bool
	// CookieSecure 是 ELYSIAN_COOKIE_SECURE 严格等于 "1" 的判定结果。
	CookieSecure bool
	// DockerSocket 是 Engine socket 路径（docker/websites/database/platform 共用出口）。
	DockerSocket string
	// CaddySocket 是 Caddy admin socket 路径（websites/platform 共用）。
	CaddySocket string
	// MountRoot 是绑定挂载根（docker 与 containerapps 域读取；files 域不读此变量）。
	// containerapps 的工作区实体落在 <MountRoot>/elysian/apps 下，因为只有这一侧的
	// 路径在宿主、面板与 Docker daemon 三方是同一字符串。
	MountRoot string
	// ListenHost 是 HTTP 监听地址（仅 go-dev 容器设 0.0.0.0，安全由「端口只发布
	// 宿主回环」保证）。
	ListenHost string

	// dockerEnvFile 是 Load 时刻 /.dockerenv 是否存在的事实快照；Mode 与
	// InContainer 都以它为据，避免判定中途文件系统变化。
	dockerEnvFile bool
}

// Load 读取全部环境变量与 /.dockerenv 存在性，产出不可变 *Config。
func Load() *Config {
	_, err := os.Stat(dockerEnvMarker)
	return load(os.Getenv, err == nil)
}

// load 以注入的 getenv 与 /.dockerenv 存在性构造 Config；测试用。
func load(getenv func(string) string, dockerEnvFile bool) *Config {
	return &Config{
		Docker:        strictlyOne(getenv("ELYSIAN_DOCKER")),
		BareMetal:     strictlyOne(getenv("ELYSIAN_BARE_METAL")),
		AuthDev:       strictlyOne(getenv("ELYSIAN_AUTH_DEV")),
		CookieSecure:  strictlyOne(getenv("ELYSIAN_COOKIE_SECURE")),
		DockerSocket:  nonEmptyOrDefault(getenv("ELYSIAN_DOCKER_SOCKET"), defaultDockerSocket),
		CaddySocket:   nonEmptyOrDefault(getenv("ELYSIAN_CADDY_SOCKET"), defaultCaddySocket),
		MountRoot:     nonEmptyOrDefault(getenv("ELYSIAN_DOCKER_MOUNT_ROOT"), defaultMountRoot),
		ListenHost:    nonEmptyOrDefault(getenv("ELYSIAN_LISTEN_HOST"), defaultListenHost),
		dockerEnvFile: dockerEnvFile,
	}
}

// strictlyOne 判定「严格等于 '1' 才开」：'0'、'true'、缺省及其余取值一律恒关。
func strictlyOne(v string) bool { return v == "1" }

// nonEmptyOrDefault 非空生效，空串回落缺省。
func nonEmptyOrDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

// Mode 返回运行模式：ModeBareMetal 显式优先；ModeDocker 保持双闸门
// （ELYSIAN_DOCKER=1 但无 /.dockerenv 且未设 BARE_METAL → ModeLocalDemo，现状）。
func (c *Config) Mode() RuntimeMode {
	switch {
	case c.BareMetal:
		return ModeBareMetal
	case c.Docker && c.dockerEnvFile:
		return ModeDocker
	default:
		return ModeLocalDemo
	}
}

// HostOpsAvailable 报告宿主操作可用性：容器门禁域（firewall/security/files/terminals）
// 与 SQLite 托管的可用性统一取此值。
func (c *Config) HostOpsAvailable() bool {
	m := c.Mode()
	return m == ModeDocker || m == ModeBareMetal
}

// InContainer 报告 /.dockerenv 是否实存（只看文件，不看 env）；platform 域
// hostShell 分支判据，由装配层算好以 Deps 字段注入，platform 包内不自测文件。
func (c *Config) InContainer() bool { return c.dockerEnvFile }
