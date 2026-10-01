package auth

import (
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 会话校验中间件（authMiddleware.ts 等价物）：装配层把它挂在审计之后、全部域路由
// 之前——因此 SSE 与三个 WS 升级端点在升级/开流之前先过鉴权，401 以普通 HTTP 响应
// 短路返回。豁免判定：先剥**单个**尾部斜杠再对四条路径精确匹配（StripTailSlash 已在
// 更外层剥过一次，这里再剥一次与 TS isAuthExemptPath 自剥同口径）。
//
// 请求经手次序：401（鉴权）→ 503（各片可用性）→ 403（同源）→ 端点 → 404。鉴权先于
// 可用性是显式决定：不向未登录方暴露各片可用性事实。

// 缺省文件版会话存储的进程级单例：RequireSession 与 NewRouter 两个入口共享同一份
// 内存镜像（文件版 store 首载后不重读文件，两个实例会各自持镜像、滑动互相丢失）。
// 装配层注入 Deps.Sessions 时不经过这里；生产装配恰好一次初始化。
var (
	defaultSessionsOnce sync.Once
	defaultSessions     SessionStore
)

func sharedDefaultSessions(now func() time.Time) SessionStore {
	defaultSessionsOnce.Do(func() {
		defaultSessions = NewFileSessionStore(paths.Default.PanelSessions, now)
	})
	return defaultSessions
}

// resolvedDeps 一次解析完毕的依赖集合（nil 项落缺省实现）。
type resolvedDeps struct {
	enabled       bool
	devAccount    bool
	cookieSecure  bool
	sessionConns  seam.SessionConnections
	now           func() time.Time
	diag          writerFunc
	credentials   CredentialsStore
	sessions      SessionStore
	hasher        PasswordHasher
	returnOrigins ReturnOriginRegistry
}

// writerFunc 诊断出口（stderr 等价物）。
type writerFunc func(format string, args ...any)

// resolveDeps 解析 Deps：nil/零值项落到生产缺省（文件版 store、scrypt hasher、
// stderr 诊断）。
func resolveDeps(deps Deps) resolvedDeps {
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	credentials := deps.Credentials
	if credentials == nil {
		credentials = NewFileCredentialsStore("")
	}
	sessions := deps.Sessions
	if sessions == nil {
		sessions = sharedDefaultSessions(now)
	}
	hasher := deps.Hasher
	if hasher == nil {
		hasher = NewScryptHasher()
	}
	returnOrigins := deps.ReturnOrigins
	if returnOrigins == nil {
		returnOrigins = NewFileReturnOriginRegistry("", os.Stderr)
	}
	diag := deps.Diag
	if diag == nil {
		diag = os.Stderr
	}
	return resolvedDeps{
		enabled:       deps.Enabled,
		devAccount:    deps.DevAccount,
		cookieSecure:  deps.CookieSecure,
		sessionConns:  deps.SessionConns,
		now:           now,
		diag:          func(format string, args ...any) { fmt.Fprintf(diag, format, args...) },
		credentials:   credentials,
		sessions:      sessions,
		hasher:        hasher,
		returnOrigins: returnOrigins,
	}
}

// currentPwdEpoch 当前凭据的会话失效 epoch：凭据不可用（文件缺失/损坏）时取哨兵 'none'。
func (r resolvedDeps) currentPwdEpoch() (string, error) {
	credentials, err := r.credentials.Current()
	if err != nil {
		return "", err
	}
	if credentials == nil {
		return "none", nil
	}
	return credentials.PasswordChangedAt, nil
}

// RequireSession app 级会话校验中间件（go-plan §3.8 冻结签名）：
//   - Enabled=false（测试/无鉴权演示注入）直接放行；
//   - 豁免路径（剥单尾斜杠后精确匹配四条）放行；
//   - Cookie 解析（seam.ParseSessionCookie，取最后一个 elysian_session 段）失败 → 401；
//   - 每次直读凭据取 epoch，sessions.validate 失败 → 401；统一 {"error":"未登录或会话已过期"}。
//
// 会话身份不注入路由上下文：单用户，没有任何端点需要区分身份。
// 凭据/会话文件读取的 IO 故障（fail-closed 集合之外）按 500 原文上抛。
func RequireSession(deps Deps) func(http.Handler) http.Handler {
	resolved := resolveDeps(deps)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !resolved.enabled || IsAuthExemptPath(r.URL.Path) {
				next.ServeHTTP(w, r)
				return
			}
			sessionID, ok := seam.ParseSessionCookie(r.Header.Get("Cookie"))
			if !ok {
				shared.SendError(w, http.StatusUnauthorized, UnauthorizedMessage)
				return
			}
			epoch, err := resolved.currentPwdEpoch()
			if err != nil {
				shared.SendError(w, http.StatusInternalServerError, err.Error())
				return
			}
			session, err := resolved.sessions.Validate(sessionID, epoch)
			if err != nil {
				shared.SendError(w, http.StatusInternalServerError, err.Error())
				return
			}
			if session == nil {
				shared.SendError(w, http.StatusUnauthorized, UnauthorizedMessage)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
