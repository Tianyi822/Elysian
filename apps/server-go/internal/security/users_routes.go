package security

// 用户管理端点：/api/security/users/*（usersRoutes.ts 的 Go 等价物，chi 子路由器，
// 由 internal/app 挂载到 shared.UsersMount）。守卫链次序与 SSH 片一致：不可用整片
// 503「真实用户管理仅在 Docker 容器内可用」→ 同源 403「请求来源不允许」→ 读体
//（415/413/400）→ 端点 → 未知路径 404「未知用户管理端点：METHOD path」。
// 根路径双形（/api/security/users 与 /api/security/users/）都命中列表端点：
// 全局 StripTailSlash 已剥单个尾斜杠，Mount 的精确模式把根路径送进子路由器。
// DELETE /:id 与 POST /sync 不读体（无 415/413/空体 400 拦截）。

import (
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
)

// NewUsersRouter 用户片子路由器：挂载到 /api/security/users。
func NewUsersRouter(deps Deps) chi.Router {
	r := chi.NewRouter()

	// 不可用整片换 503 分支：任意方法、含未知路径（同源守卫不参与）。
	if !deps.Available {
		r.NotFound(func(w http.ResponseWriter, req *http.Request) {
			shared.SendError(w, http.StatusServiceUnavailable, "真实用户管理仅在 Docker 容器内可用")
		})
		return r
	}

	svc := deps.users
	if svc == nil {
		svc = newUsersService(newRealUsersDeps(deps.Now))
	}

	// 同源守卫先于读体与路由分发：跨源写请求在解析任何请求体之前就被拒绝
	//（未知路径同样先 403 后 404）。
	r.Use(middleware.SameOriginGuard())

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		users, err := svc.List()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		if users == nil {
			users = []HostUser{}
		}
		sendResult(w, usersListBody{Users: users}, nil)
	})

	r.Post("/", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readBody(w, req)
		if !ok {
			return
		}
		nameValue, present, err := jsonProp(body, "name")
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		name, isString := nameValue.(string)
		if !present || !isString || name == "" {
			middleware.WriteError(w, shared.InvalidRequest("用户名请求体无效"))
			return
		}
		input, err := parseUserInput(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		user, err := svc.Create(name, input)
		sendResult(w, userWrapBody{User: user}, err)
	})

	r.Put("/{id}", func(w http.ResponseWriter, req *http.Request) {
		body, ok := readBody(w, req)
		if !ok {
			return
		}
		input, err := parseUserInput(body)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		// 路径参数已由路由层完成 URL 解码（Go 的 http.Server 解析 URL.Path 时
		// 已解码 %XX），与 TS 版 decodeURIComponent 语义一致。
		user, err := svc.Update(chi.URLParam(req, "id"), input)
		sendResult(w, userWrapBody{User: user}, err)
	})

	r.Delete("/{id}", func(w http.ResponseWriter, req *http.Request) {
		if err := svc.Remove(chi.URLParam(req, "id")); err != nil {
			middleware.WriteError(w, err)
			return
		}
		sendResult(w, okBody{OK: true}, nil)
	})

	r.Post("/sync", func(w http.ResponseWriter, req *http.Request) {
		total, err := svc.SyncFromSystem()
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		sendResult(w, syncResultBody{Total: total}, nil)
	})

	// 未知端点兜底：剥掉挂载前缀后的相对路径进文案（含更深路径），方法不匹配
	//（chi 的 MethodNotAllowed）走同一 404 文案，对齐 Hono app.all('*') 的行为。
	notFound := func(w http.ResponseWriter, req *http.Request) {
		shared.SendError(w, http.StatusNotFound, fmt.Sprintf(
			"未知用户管理端点：%s %s", req.Method, usersRelativePath(req.URL.Path),
		))
	}
	r.NotFound(notFound)
	r.MethodNotAllowed(notFound)
	return r
}

// usersRelativePath 404 文案用的相对路径：剥掉挂载前缀，剥空归一 /。
func usersRelativePath(fullPath string) string {
	relative := fullPath
	if len(fullPath) >= len(shared.UsersMount) && fullPath[:len(shared.UsersMount)] == shared.UsersMount {
		relative = fullPath[len(shared.UsersMount):]
	}
	if relative == "" {
		return "/"
	}
	return relative
}

// parseUserInput 请求体形状校验（校验顺序即返回顺序）：loginMethod 与 status 限
// 契约枚举、isAdmin 限布尔、note 限 string|null（缺键视为 undefined，同样拒绝）、
// password 限 string（缺键与 null 放行）。
func parseUserInput(body any) (HostUserInput, error) {
	if body == nil {
		// TS 版对 null 请求体先解构：TypeError → 500。
		return HostUserInput{}, &typeErrorOfDestructure{key: "loginMethod"}
	}
	get := func(key string) (any, bool) {
		if m, ok := body.(map[string]any); ok {
			v, present := m[key]
			return v, present
		}
		return nil, false
	}

	loginMethodValue, present := get("loginMethod")
	loginMethod, loginIsString := loginMethodValue.(string)
	loginValid := present && loginIsString
	if loginValid {
		loginValid = false
		for _, candidate := range HostUserLoginMethods {
			if candidate == loginMethod {
				loginValid = true
				break
			}
		}
	}
	if !loginValid {
		return HostUserInput{}, shared.InvalidRequest(fmt.Sprintf("无效的登录方式：%s", jsDisplay(loginMethodValue, present)))
	}

	statusValue, present := get("status")
	status, statusIsString := statusValue.(string)
	statusValid := present && statusIsString
	if statusValid {
		statusValid = false
		for _, candidate := range HostUserStatuses {
			if candidate == status {
				statusValid = true
				break
			}
		}
	}
	if !statusValid {
		return HostUserInput{}, shared.InvalidRequest(fmt.Sprintf("无效的账号状态：%s", jsDisplay(statusValue, present)))
	}

	isAdminValue, present := get("isAdmin")
	isAdmin, isAdminIsBool := isAdminValue.(bool)
	if !present || !isAdminIsBool {
		return HostUserInput{}, shared.InvalidRequest("管理员归属需为布尔值")
	}

	noteValue, present := get("note")
	var note *string
	if !present {
		// undefined：TS 版 `note !== null && typeof note !== 'string'` 对 undefined
		// 同样拒绝（JSON 请求体缺 note 键即 400）。
		return HostUserInput{}, shared.InvalidRequest("备注需为字符串或 null")
	}
	if noteValue != nil {
		noteText, isString := noteValue.(string)
		if !isString {
			return HostUserInput{}, shared.InvalidRequest("备注需为字符串或 null")
		}
		note = &noteText
	}

	passwordValue, present := get("password")
	var password *string
	if present && passwordValue != nil {
		passwordText, isString := passwordValue.(string)
		if !isString {
			return HostUserInput{}, shared.InvalidRequest("密码需为字符串")
		}
		password = &passwordText
	}

	return HostUserInput{
		LoginMethod: loginMethod,
		Status:      status,
		IsAdmin:     isAdmin,
		Note:        note,
		Password:    password,
	}, nil
}

// usersListBody GET / 响应形状。
type usersListBody struct {
	Users []HostUser `json:"users"`
}

// userWrapBody POST / 与 PUT /:id 响应形状。
type userWrapBody struct {
	User HostUser `json:"user"`
}

// syncResultBody POST /sync 响应形状。
type syncResultBody struct {
	Total int `json:"total"`
}
