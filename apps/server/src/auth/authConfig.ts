/*
 * 鉴权域的常量与环境开关：会话 Cookie 名与 TTL、登录限流缺省、鉴权豁免清单、
 * 开发固定账号、单用户名与哑哈希。全部是零依赖纯常量与纯函数（与 apiMounts 同模式），
 * 供 auth 域各模块与测试共用——文案与取值只有这一份。
 *
 * 环境开关两个：
 * - ELYSIAN_AUTH_DEV=1：开发固定账号 dev / dev-elysian 可登录（缺省恒关；被跟踪的
 *   docker-compose.yml 以 "${ELYSIAN_AUTH_DEV:-0}" 插值缺省关作第二道闸）。
 * - ELYSIAN_COOKIE_SECURE=1：会话 Cookie 追加 Secure（面板经纯 HTTP 回环访问时缺省
 *   不设，设了 Cookie 永不发送；未来加 HTTPS 终止时打开）。
 */

/** 会话 Cookie 名：承载不透明会话 id，HttpOnly，前端无感。 */
export const SESSION_COOKIE_NAME = 'elysian_session'

/** 空闲过期：距上次使用超过 12 小时的会话在服务端删除（滑动窗口，服务端权威）。 */
export const SESSION_IDLE_TTL_MS = 12 * 60 * 60 * 1000

/** 绝对上限：会话自创建起 7 天必失效，无论活跃。 */
export const SESSION_ABSOLUTE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Cookie 的 Max-Age（秒）：与绝对上限同值（7 天），浏览器侧只是容器。 */
export const SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60

/** 登录限流缺省：5 次 / 60 秒固定窗口（照 platformDependencies 先例，测试注入小值）。 */
export const DEFAULT_LOGIN_RATE_LIMIT = 5
export const DEFAULT_LOGIN_RATE_WINDOW_MS = 60_000

/** 单用户面板的固定用户名：凭据文件与登录判定都用它。 */
export const PANEL_USERNAME = 'admin'

/** 开发固定账号（ELYSIAN_AUTH_DEV=1 时可用；公开常量，供登录页提示）。 */
export const DEV_ACCOUNT_USERNAME = 'dev'
export const DEV_ACCOUNT_PASSWORD = 'dev-elysian'

/** 服务端启动时对 dev 开关打的警告行。 */
export const AUTH_DEV_WARNING = '[警告] 开发固定账号已启用（ELYSIAN_AUTH_DEV=1），禁止用于生产部署'

/**
 * 鉴权豁免清单（精确匹配，尾斜杠先剥）：health 供容器存活检查；login/session 是登录
 * 流程自身；logout 豁免让「会话已过期后点登出」幂等收尾而不是 401 死循环。清单之外
 * 不再有任何豁免——读写全挡。
 */
export const AUTH_EXEMPT_PATHS = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/session',
  '/api/auth/logout',
] as const

/**
 * 固定哑哈希：用户名不匹配时先对它跑一次 verify 再回 401，消除「用户名命中与否」的
 * 时序差异（与 dev 分支同纪律）。它是格式合法的 scrypt 串（同 N/r/p 参数），verify
 * 因此付出与真凭据完全相同的派生成本。
 */
export const DUMMY_HASH = 'scrypt:16384:8:1:gHVny9OjiCIiWu2eOy7x2w==:xyuNcMcJqD1p6oVNyGvkB4wS8bA6OR/5ydmSZUo30o4='

/** 开发固定账号开关：环境变量 ELYSIAN_AUTH_DEV 严格等于 '1' 才开，缺省恒关。 */
export function isDevAccountEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ELYSIAN_AUTH_DEV === '1'
}

/** 会话 Cookie 是否追加 Secure：ELYSIAN_COOKIE_SECURE=1 时开，缺省关（纯 HTTP 回环下设了 Cookie 永不发送）。 */
export function isCookieSecureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ELYSIAN_COOKIE_SECURE === '1'
}

/** 首启初始密码：16 字符，字符集剔除 0O1lI 歧义字符（人工誊抄不出错）。 */
export const INITIAL_PASSWORD_LENGTH = 16
export const INITIAL_PASSWORD_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

/** 登录请求体字段上限：用户名与密码各 ≤ 256 字符（远超真实口令长度，只挡滥用）。 */
export const LOGIN_FIELD_MAX_LENGTH = 256

/** 回跳地址长度上限：远超人类可读 URL，只挡滥用（与 LOGIN_FIELD_MAX_LENGTH 同纪律）。 */
export const RETURN_TO_MAX_LENGTH = 2048

/** 回跳白名单整表不可用时的中文诊断前缀（经 console.error 落 stderr）。 */
export const SSO_ORIGINS_UNAVAILABLE = 'Elysian 回跳白名单不可用'

/** 回跳白名单里单项无效被丢弃时的中文诊断前缀。 */
export const SSO_ORIGIN_IGNORED = 'Elysian 回跳白名单忽略无效项'

/** 回跳白名单文件体积上限：几行 origin 远小于此，超限视为不可用（与凭据文件同纪律）。 */
export const RETURN_ORIGINS_MAX_BYTES = 16 * 1024
