package security

// SSH 真实端点：/api/security/ssh/*（sshRoutes.ts 的 Go 等价物，chi 子路由器，
// 由 internal/app 挂载到 shared.SshMount）。路由层薄：守卫调用、请求体读取与
// 内联形状校验、service 透传；业务校验在服务层，测试用 fake service 驱动，
// 不执行任何真实命令。
//
// 经手次序（次序即行为）：不可用整片 503（任意方法、任意子路径，含未知路径，
// 同源守卫不参与）→ 同源 403（先于读体，坏 JSON 也回 403）→ 读体（415/413/400）
// → 端点 → 未知端点 404（文案剥挂载前缀，方法不匹配同样走 404 兜底）。

import (
	"context"
	"elysian/server/internal/config"
	"elysian/server/internal/seam"
	"fmt"
	"math"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
)

// Deps security 域的装配入参（go-plan §3.8 冻结的跨域字段 + 域内测试注入位）。
type Deps struct {
	AgentFacade    *AgentFacade
	AgentAuthorize func(context.Context) error
	// Available 容器门禁事实（cfg.HostOpsAvailable()）：false 时两片整片 503。
	Available bool
	Mode      config.RuntimeMode
	SshPorts  seam.PortOpener
	// Now 时间源；nil 用 time.Now（服务层经 nowIso 落时间戳）。
	Now func() time.Time

	// ssh 与 users 是路由测试的 fake 注入位（nil 时用真实接线构建）；仅本包测试
	// 可设置，装配层不感知。
	ssh   sshAPI
	users usersAPI
}

// NewSshRouter SSH 片子路由器：挂载到 /api/security/ssh。
func NewSshRouter(deps Deps) chi.Router {
	r := chi.NewRouter()

	// 不可用整片换 503 分支：不注册任何具体路由，任意方法、任意子路径（含未知
	// 路径）都命中 NotFound 兜底；同源守卫不参与（跨源请求同样 503）。
	if !deps.Available {
		r.NotFound(func(w http.ResponseWriter, req *http.Request) {
			shared.SendError(w, http.StatusServiceUnavailable, "真实 SSH 管理仅在 Docker 容器内或正式安装中可用")
		})
		return r
	}

	svc := deps.ssh
	if deps.AgentFacade != nil {
		svc = deps.AgentFacade.ssh
	}
	if svc == nil {
		svc = newSshService(newConfiguredSshDeps(deps))
	}

	// 同源守卫先于路由与读体：跨源写请求在解析任何请求体之前就被拒绝（GET/HEAD 放行）。
	r.Use(middleware.SameOriginGuard())

	r.Get("/overview", func(w http.ResponseWriter, req *http.Request) {
		overview, err := svc.Overview()
		sendResult(w, overview, err)
	})
	r.Get("/settings", func(w http.ResponseWriter, req *http.Request) {
		settings, err := svc.Settings()
		sendResult(w, settings, err)
	})
	r.Get("/root-auth", func(w http.ResponseWriter, req *http.Request) {
		auth, err := svc.RootAuth()
		sendResult(w, auth, err)
	})

	r.Put("/service-enabled", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readBody(w, req)
		if !ok {
			return
		}
		enabled, present, err := jsonProp(body, "enabled")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		flag, isBool := enabled.(bool)
		if !present || !isBool {
			middleware.WriteError(w, shared.InvalidRequest("开关值无效"))
			return
		}
		overview, err := svc.SetServiceEnabled(flag)
		sendResult(w, overview, err)
	})

	r.Put("/auth-methods", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readBody(w, req)
		if !ok {
			return
		}
		passwordValue, presentPassword, err := jsonProp(body, "passwordAuthEnabled")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		keyValue, presentKey, err := jsonProp(body, "keyAuthEnabled")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		passwordFlag, passwordIsBool := passwordValue.(bool)
		keyFlag, keyIsBool := keyValue.(bool)
		if !presentPassword || !passwordIsBool || !presentKey || !keyIsBool {
			middleware.WriteError(w, shared.InvalidRequest("登录方式开关需为布尔值"))
			return
		}
		settings, err := svc.SetAuthMethods(passwordFlag, keyFlag)
		sendResult(w, settings, err)
	})

	r.Put("/port", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readBody(w, req)
		if !ok {
			return
		}
		portValue, present, err := jsonProp(body, "port")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		// 照抄 JS Number() 强转语义：数字字符串被接受、null→0、true→1、缺键→NaN。
		var port float64
		if !present {
			port = math.NaN()
		} else {
			var isNaN bool
			port, isNaN = jsNumber(portValue)
			if isNaN {
				port = math.NaN()
			}
		}
		if math.IsNaN(port) || math.IsInf(port, 0) {
			middleware.WriteError(w, shared.InvalidRequest("端口请求体无效"))
			return
		}
		settings, err := svc.SetPort(port)
		sendResult(w, settings, err)
	})

	r.Put("/root-login-policy", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readBody(w, req)
		if !ok {
			return
		}
		policyValue, present, err := jsonProp(body, "policy")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		policy, isString := policyValue.(string)
		valid := isString && present
		if valid {
			valid = false
			for _, candidate := range SSHRootLoginPolicies {
				if candidate == policy {
					valid = true
					break
				}
			}
		}
		if !valid {
			middleware.WriteError(w, shared.InvalidRequest(
				fmt.Sprintf("无效的 Root 登录策略：%s", jsDisplay(policyValue, present)),
			))
			return
		}
		auth, err := svc.SaveRootLoginPolicy(policy)
		sendResult(w, auth, err)
	})

	r.Post("/root-password", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readBody(w, req)
		if !ok {
			return
		}
		passwordValue, present, err := jsonProp(body, "password")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		password, isString := passwordValue.(string)
		if !present || !isString || password == "" {
			middleware.WriteError(w, shared.InvalidRequest("密码请求体无效"))
			return
		}
		result, err := svc.ResetRootPassword(password)
		sendResult(w, result, err)
	})

	// 生成（或重新生成）Root 密钥：没有要校验的输入，读体只为走同一套守卫
	//（同源、Content-Type、体积上限；空体 → 400 请求体不能为空）。
	r.Post("/root-key", func(w http.ResponseWriter, req *http.Request) {
		if _, err := middleware.ReadJSONBody(w, req, 0); err != nil {
			middleware.WriteError(w, err)
			return
		}
		auth, err := svc.CreateRootKey()
		sendResult(w, auth, err)
	})

	r.Get("/keys", func(w http.ResponseWriter, req *http.Request) {
		report, err := svc.ListKeysWithReport()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		if report.Keys == nil {
			report.Keys = []SshLoginKey{}
		}
		sendResult(w, report, nil)
	})

	r.Get("/key-accounts", func(w http.ResponseWriter, req *http.Request) {
		accounts, err := svc.KeyAccounts()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		if accounts == nil {
			accounts = []SshKeyAccount{}
		}
		sendResult(w, keyAccountListBody{Accounts: accounts}, nil)
	})

	r.Post("/keys", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readBody(w, req)
		if !ok {
			return
		}
		nameValue, presentName, err := jsonProp(body, "name")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		userIdValue, presentUserId, err := jsonProp(body, "userId")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		name, nameIsString := nameValue.(string)
		userId, userIdIsString := userIdValue.(string)
		if !presentName || !nameIsString || !presentUserId || !userIdIsString {
			middleware.WriteError(w, shared.InvalidRequest("密钥请求体无效"))
			return
		}
		key, err := svc.CreateKey(name, userId)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		sendResult(w, sshKeyBody{Key: key}, nil)
	})

	r.Delete("/keys/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := svc.RemoveKey(chi.URLParam(req, "id")); err != nil {
			middleware.WriteError(w, err)
			return
		}
		sendResult(w, okBody{OK: true}, nil)
	})

	r.Get("/login-records", func(w http.ResponseWriter, req *http.Request) {
		records, err := svc.ListLoginRecords()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		if records == nil {
			records = []SshLoginRecord{}
		}
		sendResult(w, sshRecordsBody{Records: records}, nil)
	})

	// 未知端点兜底（含方法不匹配：chi 的 MethodNotAllowed 与 NotFound 走同一文案，
	// 对齐 Hono app.all('*') 的行为）；文案剥掉挂载前缀，剥空归一 /。
	notFound := func(w http.ResponseWriter, req *http.Request) {
		shared.SendError(w, http.StatusNotFound, fmt.Sprintf("未知 SSH 端点：%s %s", req.Method, sshRelativePath(req.URL.Path)))
	}
	r.NotFound(notFound)
	r.MethodNotAllowed(notFound)
	return r
}

// sshRelativePath 404 文案用的相对路径：子路由器经 Mount 挂载后 req.URL.Path 仍是
// 全路径，剥掉前缀逐字对齐（剥空归一 /）。
func sshRelativePath(fullPath string) string {
	relative := fullPath
	if len(fullPath) >= len(shared.SshMount) && fullPath[:len(shared.SshMount)] == shared.SshMount {
		relative = fullPath[len(shared.SshMount):]
	}
	if relative == "" {
		return "/"
	}
	return relative
}

// ---------- 响应包装与读体辅助 ----------

// keyAccountListBody GET /key-accounts 响应形状。
type keyAccountListBody struct {
	Accounts []SshKeyAccount `json:"accounts"`
}

// sshKeyBody POST /keys 响应形状。
type sshKeyBody struct {
	Key SshLoginKey `json:"key"`
}

// sshRecordsBody GET /login-records 响应形状。
type sshRecordsBody struct {
	Records []SshLoginRecord `json:"records"`
}

// okBody DELETE 响应形状 {ok:true}。
type okBody struct {
	OK bool `json:"ok"`
}

// readBody 读体守卫的薄包装：守卫错误直接写出并返回 false。
func readBody(w http.ResponseWriter, req *http.Request) (any, bool) {
	body, err := middleware.ReadJSONBody(w, req, 0)
	if err != nil {
		middleware.WriteError(w, err)
		return nil, false
	}
	return body, true
}

// sendResult 成功写 200 JSON，失败按错误类型映射状态码。
func sendResult(w http.ResponseWriter, value any, err error) {
	if err != nil {
		middleware.WriteError(w, err)
		return
	}
	shared.SendJSON(w, http.StatusOK, value)
}
