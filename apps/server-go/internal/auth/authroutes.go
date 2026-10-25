package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 登录鉴权片（authRoutes.ts 等价物，go-plan §3.8 冻结签名）：POST /login、
// POST /logout、GET /session，以及设置页的 POST /password、GET /sessions、
// POST /sessions/logout-others。自带 SameOriginGuard（写端点同源校验；GET 按既有
// GET 豁免语义放行）与统一错误映射，与各片同构。
//
// 时序纪律：用户名不匹配（或凭据不可用）时先对固定哑哈希 DummyHash 跑一次 verify
// 再回 401——否则用户名错短路 scrypt，回包虽同文但时序可区分用户名命中。用户名错与
// 密码错的回包逐字相同：401 {"error":"用户名或密码错误"}。dev 账号命中后同样补跑一次
// 哑哈希校验，让每条失败/成功路径都恰好付出一次派生成本。
//
// 登录限流 5 次/60 秒固定窗口：状态挂在 NewRouter 返回的路由器闭包内（每实例独立、
// 窗口起点取装配时刻），每次登录尝试都计数——成功也计、体不合法也计，计数发生在
// 体解析之前。
//
// 片内次序与 TS 版一致：同源守卫挂全片（写请求 403 先于端点内的 503 演示短路与读体）。
// auth 片没有装配级整片 503——Enabled=false 时 login 恒 200、session 恒已登录、
// 三个设置端点在各自 handler 内 503。

// Deps 登录鉴权片的依赖注入。前三个字段是 go-plan §3.8 冻结的跨域形状；其余为域内
// 可注入项（总纲允许实现者扩字段），全部可安全缺省（nil/零值落生产实现）。
type Deps struct {
	// Enabled false 时整片退化为「无鉴权」演示语义：/session 恒答 authenticated:true、
	// /login 恒成功。生产恒 true；测试注 false。
	Enabled bool
	// SessionConns 会话连接撤销表：新登录替换/登出/改密/退出其他会话在销毁服务端
	// 会话的同时关闭该会话名下已建立的终端和聊天流。装配层与 terminals 片共享同一实例；
	// nil 即无撤销（独立驱动本片的行为不受影响）。
	SessionConns seam.SessionConnections
	// Now 可控时钟；nil 用 time.Now。
	Now func() time.Time

	// DevAccount 开发固定账号开关（config.AuthDev 注入，严格 '1' 才开）。
	DevAccount bool
	// CookieSecure 会话 Cookie 追加 "; Secure"（config.CookieSecure 注入）。
	CookieSecure bool
	// Credentials 凭据 store；nil 用文件版（~/.Elysian/config/panel-credentials.json）。
	Credentials CredentialsStore
	// Sessions 会话 store；nil 用共享文件版单例（~/.Elysian/state/panel-sessions.json）。
	Sessions SessionStore
	// Hasher 密码哈希器；nil 用 scrypt。
	Hasher PasswordHasher
	// ReturnOrigins 回跳白名单：只服务 GET /session 的 returnTo 裁决，不参与任何鉴权
	// 判定；nil 用文件版（~/.Elysian/config/sso-return-origins.json）。
	ReturnOrigins ReturnOriginRegistry
	// Diag 退化诊断出口（白名单按空表回跳等）；nil 用 os.Stderr。
	Diag io.Writer
	// LoginRateLimit 登录限流（次/窗口）；0 用缺省 5。测试注入小值。
	LoginRateLimit int
	// LoginRateWindow 限流窗口；0 用缺省 60 秒。
	LoginRateWindow time.Duration
	// PasswordAudit 改密安全审计出口；nil 用文件版（paths.Default.PanelPasswordAudit，
	// 保留 30 天/1 MiB）。设置页改密端点经它落「执行主体（admin）、来源、结果」的持久
	// 记录；写盘失败只诊断、不影响改密响应。测试注入内存版避免碰真实 ~/.Elysian。
	PasswordAudit PasswordAuditSink
}

// loginLimiter 进程内固定窗口限流器（每 NewRouter 实例独立）。
type loginLimiter struct {
	mu          sync.Mutex
	windowStart time.Time
	served      int
	limit       int
	window      time.Duration
	now         func() time.Time
}

// take 判定本次尝试是否放行；放行即计数（成功、失败、体不合法都计）。
func (l *loginLimiter) take() (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if now.Sub(l.windowStart) >= l.window {
		l.windowStart = now
		l.served = 0
	}
	if l.served >= l.limit {
		remaining := l.windowStart.Add(l.window).Sub(now)
		seconds := (remaining + time.Second - 1) / time.Second
		if seconds < 1 {
			seconds = 1
		}
		return false, int(seconds)
	}
	l.served++
	return true, 0
}

// loginBody 登录请求体。Client 是可选的会话客户端类别（NormalizeSessionClient 归一后
// 的空串 web 或 "cli"；缺省 web），供 ely CLI/TUI 与浏览器分道登录。
type loginBody struct {
	Username string
	Password string
	Client   string
}

// passwordChangeBody 改密请求体。
type passwordChangeBody struct {
	CurrentPassword    string
	NewPassword        string
	ConfirmNewPassword string
}

// constantTimeEquals 恒定时间字符串比较：比对 sha256 摘要（等长），内容差异不产生时间信号。
func constantTimeEquals(a, b string) bool {
	first := sha256.Sum256([]byte(a))
	second := sha256.Sum256([]byte(b))
	return subtle.ConstantTimeCompare(first[:], second[:]) == 1
}

// sessionCookie 会话 Cookie 串（手工拼装，属性与顺序逐字对齐 TS，前端与测试按整串
// 断言；Go 标准库 http.Cookie 的序列化顺序与大小写不同，不可用）：
// 登录下发与登出清共用同一形状（Max-Age 0 即清除）。
func sessionCookie(value string, maxAgeSeconds int, secure bool) string {
	cookie := seam.SessionCookieName + "=" + value + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + strconv.Itoa(maxAgeSeconds)
	if secure {
		cookie += "; Secure"
	}
	return cookie
}

// handle 把「返回 error 的 handler」接入统一错误映射（等价 TS app.onError +
// endpointErrorHandler）：EndpointGuardError/InvalidRequestError 按自带 Status 回 4xx，
// 其余一切错误一律 500 原文回显。
func handle(h func(w http.ResponseWriter, r *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			middleware.WriteError(w, err)
		}
	}
}

// okBody {"ok":true}。
type okBody struct {
	OK bool `json:"ok"`
}

// sessionPlainBody 不带 returnTo 的 /session 响应（键序即输出序，不扩张）。
type sessionPlainBody struct {
	Authenticated bool `json:"authenticated"`
	DevAccount    bool `json:"devAccount"`
}

// sessionReturnBody 带 returnTo 的 /session 响应；裁决不过时 ReturnTo 为 nil（JSON null）。
type sessionReturnBody struct {
	Authenticated bool    `json:"authenticated"`
	DevAccount    bool    `json:"devAccount"`
	ReturnTo      *string `json:"returnTo"`
}

// sessionRow GET /sessions 的三字段投影：id 是 bearer 凭据不下发，epoch 是内部失效
// 基准无呈现价值。
type sessionRow struct {
	CreatedAt  string `json:"createdAt"`
	LastUsedAt string `json:"lastUsedAt"`
	Current    bool   `json:"current"`
}

// sessionsBody GET /sessions 响应。
type sessionsBody struct {
	Sessions []sessionRow `json:"sessions"`
}

// readLoginBody 读并校验登录请求体：{ username, password } 两者非空字符串且 ≤256 字符
// （UTF-16 计）；可选 client 字段只接受 ""/"web"/"cli"（归一后回填），其余取值或非字符串
// 均判体不合法；Content-Type 与体积双拦由 ReadJSONBody 完成（415/413 原样映射），
// 这里只管形状，不合法回 false。
func readLoginBody(w http.ResponseWriter, r *http.Request) (loginBody, bool, error) {
	parsed, err := middleware.ReadJSONBody(w, r, 0)
	if err != nil {
		return loginBody{}, false, err
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return loginBody{}, false, nil
	}
	username, usernameOK := record["username"].(string)
	password, passwordOK := record["password"].(string)
	if !usernameOK || !passwordOK {
		return loginBody{}, false, nil
	}
	if utf16Length(username) == 0 || utf16Length(password) == 0 {
		return loginBody{}, false, nil
	}
	if utf16Length(username) > LoginFieldMaxLength || utf16Length(password) > LoginFieldMaxLength {
		return loginBody{}, false, nil
	}
	body := loginBody{Username: username, Password: password}
	if raw, hasClient := record["client"]; hasClient {
		text, isString := raw.(string)
		if !isString {
			return loginBody{}, false, nil
		}
		client, valid := NormalizeSessionClient(text)
		if !valid {
			return loginBody{}, false, nil
		}
		body.Client = client
	}
	return body, true, nil
}

// readPasswordChangeBody 读并校验改密请求体：三个字段均非空字符串且 ≤256 字符。
func readPasswordChangeBody(w http.ResponseWriter, r *http.Request) (passwordChangeBody, bool, error) {
	parsed, err := middleware.ReadJSONBody(w, r, 0)
	if err != nil {
		return passwordChangeBody{}, false, err
	}
	record, ok := parsed.(map[string]any)
	if !ok {
		return passwordChangeBody{}, false, nil
	}
	isField := func(value any) (string, bool) {
		text, isString := value.(string)
		if !isString || utf16Length(text) == 0 || utf16Length(text) > LoginFieldMaxLength {
			return "", false
		}
		return text, true
	}
	current, currentOK := isField(record["currentPassword"])
	next, nextOK := isField(record["newPassword"])
	confirm, confirmOK := isField(record["confirmNewPassword"])
	if !currentOK || !nextOK || !confirmOK {
		return passwordChangeBody{}, false, nil
	}
	return passwordChangeBody{CurrentPassword: current, NewPassword: next, ConfirmNewPassword: confirm}, true, nil
}

// NewRouter 构造 /api/auth 登录鉴权片子路由器（go-plan §3.8 冻结签名），由装配层以
// r.Mount(shared.AuthMount, auth.NewRouter(deps)) 挂载。片内自带同源守卫与 404 兜底。
func NewRouter(deps Deps) chi.Router {
	resolved := resolveDeps(deps)
	limit := deps.LoginRateLimit
	if limit == 0 {
		limit = DefaultLoginRateLimit
	}
	window := deps.LoginRateWindow
	if window == 0 {
		window = DefaultLoginRateWindow
	}
	// 限流窗口起点取装配（NewRouter 调用）时刻，而非首个请求时刻。
	limiter := &loginLimiter{windowStart: resolved.now(), limit: limit, window: window, now: resolved.now}

	r := chi.NewRouter()
	r.Use(middleware.SameOriginGuard())

	r.Post("/login", handle(func(w http.ResponseWriter, r *http.Request) error {
		if !resolved.enabled {
			shared.SendJSON(w, http.StatusOK, okBody{OK: true})
			return nil
		}
		if allowed, retryAfter := limiter.take(); !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
			shared.SendError(w, http.StatusTooManyRequests, "登录尝试过于频繁，请稍后再试")
			return nil
		}
		body, ok, err := readLoginBody(w, r)
		if err != nil {
			return err
		}
		if !ok {
			shared.SendError(w, http.StatusBadRequest, "请求体不合法")
			return nil
		}

		credentials, err := resolved.credentials.Current()
		if err != nil {
			return err
		}
		authenticated := false
		switch {
		case resolved.devAccount &&
			constantTimeEquals(body.Username, DevAccountUsername) &&
			constantTimeEquals(body.Password, DevAccountPassword):
			// dev 账号命中：补跑一次哑哈希校验，时序形状与 admin 路径一致。
			_, _ = resolved.hasher.Verify(body.Password, DummyHash)
			authenticated = true
		case credentials != nil && constantTimeEquals(body.Username, PanelUsername):
			authenticated, err = resolved.hasher.Verify(body.Password, credentials.PasswordHash)
			if err != nil {
				return err
			}
		default:
			// 用户名不匹配或凭据不可用：仍跑一次哑哈希校验，消除「用户名命中与否」的时序差异。
			_, _ = resolved.hasher.Verify(body.Password, DummyHash)
		}
		if !authenticated {
			shared.SendError(w, http.StatusUnauthorized, "用户名或密码错误")
			return nil
		}

		pwdEpoch := "none"
		if credentials != nil {
			pwdEpoch = credentials.PasswordChangedAt
		}
		session, replaced, err := resolved.sessions.Create(pwdEpoch, body.Client)
		if err != nil {
			return err
		}
		if resolved.sessionConns != nil {
			// 只关闭本次原子替换的会话（同客户端类别），不能 RevokeOthers：并发登录的
			// 较早请求可能较晚走到这里，不得误关后一个有效会话的连接；异类会话不在
			// replaced 清单里，天然不受影响。
			for _, id := range replaced {
				resolved.sessionConns.Revoke(id)
			}
		}
		w.Header().Set("Set-Cookie", sessionCookie(session.ID, SessionCookieMaxAge, resolved.cookieSecure))
		shared.SendJSON(w, http.StatusOK, okBody{OK: true})
		return nil
	}))

	r.Post("/logout", handle(func(w http.ResponseWriter, r *http.Request) error {
		// 幂等：鉴权豁免清单内，无有效会话同样可达；无论如何清浏览器侧 Cookie。
		if resolved.enabled {
			if sessionID, ok := seam.ParseSessionCookie(r.Header.Get("Cookie")); ok {
				if err := resolved.sessions.Destroy(sessionID); err != nil {
					return err
				}
				// 会话销毁即撤销：该会话名下已建立的终端连接一并关闭，不等到自然断开。
				if resolved.sessionConns != nil {
					resolved.sessionConns.Revoke(sessionID)
				}
			}
		}
		w.Header().Set("Set-Cookie", sessionCookie("", 0, resolved.cookieSecure))
		shared.SendJSON(w, http.StatusOK, okBody{OK: true})
		return nil
	}))

	r.Get("/session", handle(func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Cache-Control", "no-store")
		// 演示语义：恒已登录，且不回答回跳——面板本身没有鉴权时充当跳转器毫无意义。
		if !resolved.enabled {
			shared.SendJSON(w, http.StatusOK, sessionPlainBody{Authenticated: true, DevAccount: resolved.devAccount})
			return nil
		}
		authenticated := false
		if sessionID, ok := seam.ParseSessionCookie(r.Header.Get("Cookie")); ok {
			epoch, err := resolved.currentPwdEpoch()
			if err != nil {
				return err
			}
			validate := resolved.sessions.Validate
			if r.URL.Query().Get("passive") == "1" {
				validate = resolved.sessions.Check
			}
			session, err := validate(sessionID, epoch)
			if err != nil {
				return err
			}
			authenticated = session != nil
		}
		// 不带 returnTo 参数时响应形状与既往逐字相同：面板前端探测与外部消费方共用本
		// 端点，形状不无谓扩张。参数存在（含空串）即进入裁决。
		values, hasReturnTo := r.URL.Query()["returnTo"]
		if !hasReturnTo {
			shared.SendJSON(w, http.StatusOK, sessionPlainBody{Authenticated: authenticated, DevAccount: resolved.devAccount})
			return nil
		}
		requested := ""
		if len(values) > 0 {
			requested = values[0]
		}
		// 白名单读取自身故障按空表处理：回跳关掉了，但登录与探测照常。退化不静默：
		// 读不到名单又永不跳转恰是最难自查的故障，先落一行与 registry 同前缀的中文
		// 诊断（带 errno code 或 message）再回空表；响应形状与状态码不受任何影响。
		allowed, err := resolved.returnOrigins.List()
		if err != nil {
			resolved.diag("%s：会话探测按空表回跳（%s）\n", SSOOriginsUnavailable, errorReason(err))
			allowed = nil
		}
		// 跳转判定与会话有效性独立：未登录时也回答裁决。
		shared.SendJSON(w, http.StatusOK, sessionReturnBody{
			Authenticated: authenticated,
			DevAccount:    resolved.devAccount,
			ReturnTo:      AdjudicateReturnTo(requested, allowed),
		})
		return nil
	}))

	// —— 设置页端点（RequireSession 覆盖之下，豁免清单不含任何一条）——

	r.Post("/password", handle(func(w http.ResponseWriter, r *http.Request) error {
		// 先于读体：演示语义下写凭据文件会凭空造出真凭据，也不读体（该分支不落改密
		// 审计——没有任何改密尝试被解析）。
		if !resolved.enabled {
			shared.SendError(w, http.StatusServiceUnavailable, AuthDisabledMessage)
			return nil
		}
		changeErr := func() error {
			body, ok, err := readPasswordChangeBody(w, r)
			if err != nil {
				return err
			}
			if !ok {
				return shared.InvalidRequest("请求体不合法")
			}

			credentials, err := resolved.credentials.Current()
			if err != nil {
				return err
			}
			// 无凭据分支：错误路径成本恒定为一次 verify（登录片的哑哈希纪律只针对用户名
			// 命中时序）。
			if credentials == nil {
				return shared.InvalidRequest("面板凭据不可用，无法修改密码")
			}
			currentOK, err := resolved.hasher.Verify(body.CurrentPassword, credentials.PasswordHash)
			if err != nil {
				return err
			}
			if !currentOK {
				return shared.InvalidRequest("当前密码不正确")
			}

			// 纯函数内部完成校验（两次一致、≥8 位）、scrypt 哈希与 credentials.write 原子
			// 落盘。校验失败回 InvalidRequestError(400) 原文；哈希与写盘的 IO 故障是普通
			// 错误原样上抛——服务端故障不得伪装成客户端 400，也避免把 fs 错误原文按校验
			// 文案回给浏览器。
			if _, err := ChangePanelPassword(resolved.credentials, resolved.hasher, body.NewPassword, body.ConfirmNewPassword); err != nil {
				return err
			}
			return nil
		}()
		// 改密安全审计：生产中本端点恒在 RequireSession 之下（执行主体=已登录管理员），
		// 成功与失败各落一条（来源 panel-http）；失败原因经 errorReason 取域内固定中文
		// 文案或 errno 归因，不含密码内容。审计写盘失败只诊断（sink 内部），响应语义不变。
		if changeErr != nil {
			resolved.recordPasswordChange(passwordAuditResultFailure, errorReason(changeErr))
			return changeErr
		}
		resolved.recordPasswordChange(passwordAuditResultSuccess, "")

		// 会话失效不靠显式删除：新 passwordChangedAt 即新 epoch，全部既有会话在下一
		// 次 validate 时被删除；这里只给当前浏览器清 Cookie 作 UX 收尾。连接层不等
		// epoch 惰性失效：改密成功立即关闭全部会话名下已建立的终端连接。
		if resolved.sessionConns != nil {
			resolved.sessionConns.RevokeAll()
		}
		w.Header().Set("Set-Cookie", sessionCookie("", 0, resolved.cookieSecure))
		shared.SendJSON(w, http.StatusOK, okBody{OK: true})
		return nil
	}))

	r.Get("/sessions", handle(func(w http.ResponseWriter, r *http.Request) error {
		if !resolved.enabled {
			shared.SendError(w, http.StatusServiceUnavailable, AuthDisabledMessage)
			return nil
		}
		w.Header().Set("Cache-Control", "no-store")
		currentID, _ := seam.ParseSessionCookie(r.Header.Get("Cookie"))
		sessions, err := resolved.sessions.List()
		if err != nil {
			return err
		}
		// 按最近活跃倒序后做三字段投影。
		sort.SliceStable(sessions, func(i, j int) bool { return sessions[i].LastUsedAt > sessions[j].LastUsedAt })
		rows := make([]sessionRow, 0, len(sessions))
		for _, session := range sessions {
			rows = append(rows, sessionRow{
				CreatedAt:  formatISOMillis(session.CreatedAt),
				LastUsedAt: formatISOMillis(session.LastUsedAt),
				Current:    session.ID == currentID,
			})
		}
		shared.SendJSON(w, http.StatusOK, sessionsBody{Sessions: rows})
		return nil
	}))

	r.Post("/sessions/logout-others", handle(func(w http.ResponseWriter, r *http.Request) error {
		if !resolved.enabled {
			shared.SendError(w, http.StatusServiceUnavailable, AuthDisabledMessage)
			return nil
		}
		currentID, ok := seam.ParseSessionCookie(r.Header.Get("Cookie"))
		// RequireSession 刚校验过当前会话，currentID 必有值；无值只出现在绕过中间件
		// 直驱本片的场景，无从判定保留谁，按不动任何会话收尾（不放大故障半径）。
		if ok {
			if err := resolved.sessions.DestroyOthers(currentID); err != nil {
				return err
			}
			// 其他会话名下已建立的终端连接一并关闭，保留当前会话的连接。
			if resolved.sessionConns != nil {
				resolved.sessionConns.RevokeOthers(currentID)
			}
		}
		shared.SendJSON(w, http.StatusOK, okBody{OK: true})
		return nil
	}))

	// 未知端点兜底：剥掉挂载前缀后的相对路径进文案，与各片格式逐字一致；方法不匹配
	//（如 GET /login）同样落这里——Hono app.all('*') 的 404 语义，chi 默认 405 需显式改道。
	unknown := func(w http.ResponseWriter, r *http.Request) {
		relative := strings.TrimPrefix(r.URL.Path, shared.AuthMount)
		if relative == "" {
			relative = "/"
		}
		shared.SendError(w, http.StatusNotFound, fmt.Sprintf("未知鉴权端点：%s %s", r.Method, relative))
	}
	r.NotFound(unknown)
	r.MethodNotAllowed(unknown)
	return r
}
