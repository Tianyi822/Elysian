// Package app 是装配层（go-plan §2）：app.New 逐域挂载与跨域注入 + 跨域 import 守卫
// 测试。骨架阶段只装配公共层与 health；域路由按 §3.5 固定次序由各域实现者接入。
package app

import (
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/config"
	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
	"elysian/server/web"
)

// New 装配完整 http.Handler。骨架阶段经手次序：
//
//	RequestID → StripTailSlash → /api/health → /api 兜底 404（纯文本）→ 非 /api SPA。
//
// 域实现接入后的完整次序（go-plan §3.5，次序即行为）：
//
//	RequestID → StripTailSlash → OperationAudit(logs，仅 /api/*) →
//	RequireSession(auth) → health → auth → platform(memory→dependencies) →
//	firewall → ssh → users → files → terminals → logs → docker →
//	databases → websites → /api 兜底 404 → 非 /api SPA。
//
// OperationAudit 在 RequireSession 之前（401 也落审计），RequireSession 挡全部片
// （豁免恰好四条：/api/health 与 auth 三端点，先剥单个尾斜杠再精确匹配）。
func New(cfg *config.Config) (http.Handler, error) {
	_ = cfg // 域实现接入后：cfg 的模式事实经各域 Deps 注入，装配层不递给域包 env
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.StripTailSlash)

	// 存活检查：无守卫（鉴权豁免清单之首），供容器存活检查。
	r.Get(shared.HealthPath, func(w http.ResponseWriter, r *http.Request) {
		shared.SendJSON(w, http.StatusOK, healthBody{OK: true})
	})

	// 全局 /api 404：会话有效而未匹配任何域挂载的请求回纯文本正文（对齐 Hono 缺省
	// 404；正文不承诺逐字、前端不消费）。各域内 404 才是 {"error":"未知…端点…"} JSON。
	r.HandleFunc("/api/*", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "404 Not Found", http.StatusNotFound)
	})

	// 非 /api 路径：嵌入前端静态资源 + SPA 回落 index.html，禁目录列表（go-plan §8）。
	r.HandleFunc("/*", spaHandler(web.DistFS()))

	// panic 兜底：与各域 EndpointErrorHandler 同一条错误映射路径。
	return middleware.EndpointErrorHandler(r), nil
}

// healthBody 存活检查响应体；键序即 JSON 输出序。
type healthBody struct {
	OK bool `json:"ok"`
}

// spaHandler 服务嵌入的前端静态资源：命中文件直出（按扩展名定 Content-Type），
// 未命中回落 index.html（占位 dist 无 index.html 时如实 404）；仅 GET/HEAD。
func spaHandler(dist fs.FS) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "404 Not Found", http.StatusNotFound)
			return
		}
		name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
		if name == "" {
			name = "index.html"
		}
		data, err := fs.ReadFile(dist, path.Join("dist", name))
		if err != nil {
			index, indexErr := fs.ReadFile(dist, "dist/index.html")
			if indexErr != nil {
				// 占位 dist 没有前端产物：如实 404，不影响 /api/* 路由与 404 语义。
				http.Error(w, "404 Not Found", http.StatusNotFound)
				return
			}
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(index)
			return
		}
		if ct := mime.TypeByExtension(path.Ext(name)); ct != "" {
			w.Header().Set("Content-Type", ct)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}
