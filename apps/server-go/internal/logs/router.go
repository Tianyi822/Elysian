package logs

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

/*
 * 平台日志路由（logsRoutes.ts 等价物）：只做守卫链、路由分发与 service 透传。
 *
 * 本片没有容器边界：只读写 ~/.Elysian 下面板自有目录，守卫链没有 503 段。
 * 守卫链：同源 403「请求来源不允许」→ 读体 415/413/400（仅清空端点）→ 端点 →
 * 404「未知日志端点：METHOD 相对路径」。错误映射统一走 middleware.WriteError。
 *
 * 读端点显式声明 Cache-Control: no-store（面板语义是每次刷新都要最新）；清空路由由
 * logClearableCategories 推导而不是写死两条；请求体内容不参与任何决策（路径即类别），
 * 越界的类别名自然落到 404 兜底。
 */

// Deps 路由装配入参：**无 available**（本片无容器边界）。
// Service 类型按 go-plan §3.8 冻结为 seam.Logs；路由需要的完整接口在构造时类型断言
// （OpenService 产出的 *Service 恒满足），断言失败时端点统一 500「日志数据库不可用」。
type Deps struct {
	Service seam.Logs
}

// NewRouter 日志子路由器（挂载 shared.LogsMount）；守卫链与 404 兜底自带。
func NewRouter(deps Deps) chi.Router {
	full, ok := deps.Service.(ServiceAPI)
	r := chi.NewRouter()

	// 同源守卫先于路由分发：跨源写请求在解析任何请求体之前就被拒绝（未知路径先 403 后 404）。
	r.Use(middleware.SameOriginGuard())

	r.Get("/runtime", func(w http.ResponseWriter, req *http.Request) {
		if !ok {
			shared.SendError(w, http.StatusInternalServerError, unavailableMessage)
			return
		}
		query, err := ParseRuntimeListQuery(req.URL.Query())
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		report, err := full.RuntimeLog(query)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, http.StatusOK, report)
	})

	r.Get("/operation", func(w http.ResponseWriter, req *http.Request) {
		if !ok {
			shared.SendError(w, http.StatusInternalServerError, unavailableMessage)
			return
		}
		query, err := ParseOperationListQuery(req.URL.Query())
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		report, err := full.OperationLog(query)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, http.StatusOK, report)
	})

	r.Get("/login", func(w http.ResponseWriter, req *http.Request) {
		if !ok {
			shared.SendError(w, http.StatusInternalServerError, unavailableMessage)
			return
		}
		query, err := ParseLoginListQuery(req.URL.Query())
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		report, err := full.LoginLog(query)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		shared.SendJSON(w, http.StatusOK, report)
	})

	// 清空是写端点：读体只为走同一套守卫链（同源、Content-Type、体积上限）。
	for _, clearable := range logClearableCategories {
		category := clearable
		r.Post("/"+category+"/clear", func(w http.ResponseWriter, req *http.Request) {
			if _, err := middleware.ReadJSONBody(w, req, 0); err != nil {
				middleware.WriteError(w, err)
				return
			}
			if !ok {
				shared.SendError(w, http.StatusInternalServerError, unavailableMessage)
				return
			}
			report, err := full.Clear(category)
			if err != nil {
				middleware.WriteError(w, err)
				return
			}
			shared.SendJSON(w, http.StatusOK, clearResponseBody{Cleared: report})
		})
	}

	// 未知端点兜底：方法不符（405）与路径未命中（404）在 TS 侧都落到 app.all('*') 的
	// 同一条 404 JSON，这里用同一 handler 复现。
	fallback := func(w http.ResponseWriter, req *http.Request) {
		shared.SendJSON(w, http.StatusNotFound, unknownEndpointBody{
			Error: "未知日志端点：" + req.Method + " " + relativeLogsPath(req.URL.Path),
		})
	}
	r.NotFound(fallback)
	r.MethodNotAllowed(fallback)
	return r
}

// clearResponseBody 清空端点响应体：{"cleared": {...}}。
type clearResponseBody struct {
	Cleared LogClearReport `json:"cleared"`
}

// unknownEndpointBody 404 兜底响应体。
type unknownEndpointBody struct {
	Error string `json:"error"`
}

// relativeLogsPath 404 文案用的相对路径：剥掉挂载前缀，空则归一 /。
func relativeLogsPath(fullPath string) string {
	relative := fullPath
	if len(fullPath) >= len(shared.LogsMount) && fullPath[:len(shared.LogsMount)] == shared.LogsMount {
		relative = fullPath[len(shared.LogsMount):]
	}
	if relative == "" {
		return "/"
	}
	return relative
}
