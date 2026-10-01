package auth

import "time"

// 鉴权域常量（authConfig.ts 等价物）：文案与取值只有这一份。环境开关（ELYSIAN_AUTH_DEV、
// ELYSIAN_COOKIE_SECURE）不在此处读取——域包不读 env，判定由 internal/config 产出、
// 装配层以 Deps.DevAccount / Deps.CookieSecure 注入（严格等于 "1" 才开的语义见 config 包）。
const (
	// SessionIdleTTL 空闲过期：距上次使用超过 12 小时的会话在服务端删除（滑动窗口）。
	SessionIdleTTL time.Duration = 12 * time.Hour
	// SessionAbsoluteTTL 绝对上限：会话自创建起 7 天必失效，无论活跃。
	SessionAbsoluteTTL time.Duration = 7 * 24 * time.Hour
	// SessionCookieMaxAge Cookie 的 Max-Age（秒）：与绝对上限同值（7 天），浏览器侧只是容器。
	SessionCookieMaxAge = 7 * 24 * 60 * 60
	// DefaultLoginRateLimit / DefaultLoginRateWindow 登录限流缺省：5 次 / 60 秒固定窗口。
	DefaultLoginRateLimit  = 5
	DefaultLoginRateWindow = 60 * time.Second

	// PanelUsername 单用户面板的固定用户名：凭据文件与登录判定都用它。
	PanelUsername = "admin"
	// DevAccountUsername / DevAccountPassword 开发固定账号（ELYSIAN_AUTH_DEV=1 时可用）。
	DevAccountUsername = "dev"
	DevAccountPassword = "dev-elysian"

	// AuthDevWarning 服务端启动时对 dev 开关打的警告行。
	AuthDevWarning = "[警告] 开发固定账号已启用（ELYSIAN_AUTH_DEV=1），禁止用于生产部署"

	// DummyHash 固定哑哈希：用户名不匹配时先对它跑一次 verify 再回 401，消除「用户名命中
	// 与否」的时序差异（与 dev 分支同纪律）。它是格式合法的 scrypt 串（同 N/r/p 参数），
	// verify 因此付出与真凭据完全相同的派生成本。逐字复制自 TS 版，不得改动。
	DummyHash = "scrypt:16384:8:1:gHVny9OjiCIiWu2eOy7x2w==:xyuNcMcJqD1p6oVNyGvkB4wS8bA6OR/5ydmSZUo30o4="

	// InitialPasswordLength / InitialPasswordCharset 首启初始密码：16 字符，字符集剔除
	// 0O1lI 歧义字符（人工誊抄不出错）。
	InitialPasswordLength  = 16
	InitialPasswordCharset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"

	// LoginFieldMaxLength 登录请求体字段上限：用户名与密码各 ≤ 256 字符（UTF-16 计）。
	LoginFieldMaxLength = 256

	// ReturnToMaxLength 回跳地址长度上限：远超人类可读 URL，只挡滥用。
	ReturnToMaxLength = 2048

	// SSOOriginsUnavailable 回跳白名单整表不可用时的中文诊断前缀（经诊断出口落 stderr）。
	SSOOriginsUnavailable = "Elysian 回跳白名单不可用"
	// SSOOriginIgnored 回跳白名单里单项无效被丢弃时的中文诊断前缀。
	SSOOriginIgnored = "Elysian 回跳白名单忽略无效项"

	// ReturnOriginsMaxBytes 回跳白名单文件体积上限：超限视为不可用。
	ReturnOriginsMaxBytes = 16 * 1024

	// AuthDisabledMessage 鉴权未启用（Enabled=false 演示语义）时设置端点的统一 503 文案：
	// 不读写任何凭据与会话文件。
	AuthDisabledMessage = "鉴权未启用，会话管理不可用"

	// UnauthorizedMessage 401 响应的统一中文文案。
	UnauthorizedMessage = "未登录或会话已过期"
)

// AuthExemptPaths 鉴权豁免清单（精确匹配，尾斜杠先剥单个）：health 供容器存活检查；
// login/session 是登录流程自身；logout 豁免让「会话已过期后点登出」幂等收尾而不是
// 401 死循环。清单之外不再有任何豁免——读写全挡。
var AuthExemptPaths = []string{
	"/api/health",
	"/api/auth/login",
	"/api/auth/session",
	"/api/auth/logout",
}

// IsAuthExemptPath 豁免判定：剥单个尾斜杠后精确匹配四条豁免路径（authConfig.test.ts
// 锚点：/api/auth/login//、/api/auth/loginx、/api/auth 等近形路径不放行）。
func IsAuthExemptPath(path string) bool {
	normalized := path
	if len(path) > 1 && path[len(path)-1] == '/' {
		normalized = path[:len(path)-1]
	}
	for _, exempt := range AuthExemptPaths {
		if normalized == exempt {
			return true
		}
	}
	return false
}
