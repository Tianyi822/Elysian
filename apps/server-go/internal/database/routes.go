package database

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// /api/databases 片路由：数据库容器端点 + SQLite 文件端点。SQL 终端（WS）、
// 镜像发现与逻辑库删除已退役。装配经 NewRouter(Deps)。

// Deps 跨域依赖。
type Deps struct {
	AgentFacade *AgentFacade
	// EngineAvailable docker.Stack.Ready（socket 就绪事实）。
	EngineAvailable bool
	// SqliteAvailable cfg.HostOpsAvailable()（容器/裸机门禁事实）。
	SqliteAvailable bool
	Engine          seam.DockerTransport
	Views           seam.DockerViews
	SelfID          string
	PortOpener      seam.PortOpener
}

// sqliteWorkerUID 生产 SQLite worker 的降权身份（容器与 go-dev 镜像均建 2001 账号）。
const sqliteWorkerUID = 2001

// NewRouter 构造 /api/databases 子路由器；可用性按子层拆分：
// 非容器/裸机环境整片 503，容器内 socket 未就绪仅剩 SQLite 片。
func NewRouter(deps Deps) chi.Router {
	var svc Service
	if deps.AgentFacade != nil {
		if deps.AgentFacade.service != nil {
			svc = deps.AgentFacade.service
		}
	} else if deps.EngineAvailable && deps.Engine != nil && deps.Views != nil {
		svc = newDatabaseService(serviceDeps{
			registry:        newFileDatabaseRegistry(filepath.Join(paths.ConfigDir, "databases.json")),
			docker:          newDockerAPI(deps.Engine, deps.Views.ListImages, deps.Views.Policy().ReservedPorts),
			listContainers:  deps.Views.ListContainers,
			listImages:      deps.Views.ListImages,
			selfContainerID: deps.SelfID,
			portOpener:      deps.PortOpener,
		})
	}
	var sqliteSvc SqliteService
	if deps.SqliteAvailable {
		uid := uint32(sqliteWorkerUID)
		gid := uint32(sqliteWorkerUID)
		sqliteSvc = newSqliteService(sqliteOptions{UID: &uid, GID: &gid})
	}
	return newRouter(routerDeps{available: deps.SqliteAvailable, service: svc, sqlite: sqliteSvc})
}

// routerDeps 路由器内部依赖（测试注入假服务用）。
type routerDeps struct {
	available bool
	service   Service
	sqlite    SqliteService
}

// router 域路由器状态。
type router struct {
	deps routerDeps
}

// newRouter 组装子路由器；次序：错误映射 → 503（可用性）→ 403（同源）→ 端点。
func newRouter(deps routerDeps) chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.EndpointErrorHandler)
	if !deps.available || (deps.service == nil && deps.sqlite == nil) {
		r.Use(func(http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				shared.SendError(w, http.StatusServiceUnavailable, "真实数据库仅在 Docker 环境可用")
			})
		})
		r.NotFound(notAvailableHandler)
		r.MethodNotAllowed(notAvailableHandler)
		return r
	}
	r.Use(middleware.SameOriginGuard())
	rt := &router{deps: deps}

	r.Get("/", rt.handle(rt.list))
	r.Post("/", rt.handle(rt.create))
	r.Get("/sqlite", rt.handle(rt.sqliteList))
	r.Post("/sqlite", rt.handle(rt.sqliteCreate))
	r.Post("/sqlite/import", rt.handle(rt.sqliteImport))
	r.Get("/sqlite/{id}/download", rt.handle(rt.sqliteDownload))
	r.Delete("/sqlite/{id}", rt.handle(rt.sqliteRemove))
	r.Post("/sqlite/{id}/reconcile", rt.handle(rt.sqliteReconcile))
	r.Delete("/sqlite/{id}/registration", rt.handle(rt.sqliteForget))
	r.Post("/{id}/reveal", rt.handle(rt.reveal))
	r.Delete("/{id}/container", rt.handle(rt.removeContainer))
	r.Post("/{id}/reconcile", rt.handle(rt.reconcile))
	r.Delete("/{id}/registration", rt.handle(rt.forget))

	// 未知路径与方法回落纯文本 404（对齐 Hono 缺省 404；正文不承诺逐字、前端不消费）。
	r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "404 Not Found", http.StatusNotFound)
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "404 Not Found", http.StatusNotFound)
	})
	return r
}

// notAvailableHandler 503 态下未知路径也保持整片不可用。
func notAvailableHandler(w http.ResponseWriter, _ *http.Request) {
	shared.SendError(w, http.StatusServiceUnavailable, "真实数据库仅在 Docker 环境可用")
}

// handle 把返回错误的 handler 接到统一错误映射。
func (rt *router) handle(fn func(w http.ResponseWriter, r *http.Request) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := fn(w, r); err != nil {
			middleware.WriteError(w, err)
		}
	}
}

// requireService 容器端点的可用性守卫。
func (rt *router) requireService() (Service, error) {
	if rt.deps.service == nil {
		return nil, &shared.InvalidRequestError{Status: http.StatusServiceUnavailable, Message: "容器数据库服务不可用"}
	}
	return rt.deps.service, nil
}

// requireSqlite SQLite 端点的可用性守卫。
func (rt *router) requireSqlite() (SqliteService, error) {
	if rt.deps.sqlite == nil {
		return nil, &shared.InvalidRequestError{Status: http.StatusServiceUnavailable, Message: "SQLite 服务不可用"}
	}
	return rt.deps.sqlite, nil
}

// okBody {ok:true} 响应体。
type okBody struct {
	OK bool `json:"ok"`
}

// list GET /：数据库容器实例行（SQLite 不再混入本端点）。
func (rt *router) list(w http.ResponseWriter, r *http.Request) error {
	service, err := rt.requireService()
	if err != nil {
		return err
	}
	rows, err := service.List(r.Context())
	if err != nil {
		return err
	}
	if rows == nil {
		rows = []containerInstance{}
	}
	shared.SendJSON(w, http.StatusOK, rows)
	return nil
}

// create POST /：新建数据库容器。
func (rt *router) create(w http.ResponseWriter, r *http.Request) error {
	body, err := middleware.ReadJSONBody(w, r, 0)
	if err != nil {
		return err
	}
	request, err := validateCreateRequest(body)
	if err != nil {
		return err
	}
	service, err := rt.requireService()
	if err != nil {
		return err
	}
	result, err := service.Create(r.Context(), request)
	if err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusCreated, result)
	return nil
}

// reveal POST /{id}/reveal：按需取容器管理员凭据，响应禁止缓存。
func (rt *router) reveal(w http.ResponseWriter, r *http.Request) error {
	service, err := rt.requireService()
	if err != nil {
		return err
	}
	secret, err := service.Reveal(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	shared.SendJSON(w, http.StatusOK, secret)
	return nil
}

// removeContainer DELETE /{id}/container：删除容器及专属卷（需确认正文）。
func (rt *router) removeContainer(w http.ResponseWriter, r *http.Request) error {
	body, err := middleware.ReadJSONBody(w, r, 0)
	if err != nil {
		return err
	}
	if obj(body)["confirm"] != "DELETE_CONTAINER_AND_DATA" {
		return shared.InvalidRequest("必须确认删除容器及全部数据")
	}
	service, err := rt.requireService()
	if err != nil {
		return err
	}
	if err := service.RemoveContainer(r.Context(), chi.URLParam(r, "id")); err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}

// reconcile POST /{id}/reconcile：重新核对容器事实。
func (rt *router) reconcile(w http.ResponseWriter, r *http.Request) error {
	service, err := rt.requireService()
	if err != nil {
		return err
	}
	instance, err := service.Reconcile(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusOK, instance)
	return nil
}

// forget DELETE /{id}/registration：容器已不存在时清理该容器全部登记行。
func (rt *router) forget(w http.ResponseWriter, r *http.Request) error {
	service, err := rt.requireService()
	if err != nil {
		return err
	}
	if err := service.Forget(r.Context(), chi.URLParam(r, "id")); err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}

// sqliteList GET /sqlite：SQLite 文件实例列表。
func (rt *router) sqliteList(w http.ResponseWriter, r *http.Request) error {
	files, err := rt.requireSqlite()
	if err != nil {
		return err
	}
	rows, err := files.List(r.Context())
	if err != nil {
		return err
	}
	if rows == nil {
		rows = []sqliteInstance{}
	}
	shared.SendJSON(w, http.StatusOK, rows)
	return nil
}

// sqliteCreate POST /sqlite。
func (rt *router) sqliteCreate(w http.ResponseWriter, r *http.Request) error {
	files, err := rt.requireSqlite()
	if err != nil {
		return err
	}
	body, err := middleware.ReadJSONBody(w, r, 0)
	if err != nil {
		return err
	}
	instance, err := files.Create(r.Context(), obj(body)["name"])
	if err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusCreated, instance)
	return nil
}

// sqliteImport POST /sqlite/import?name=（查询参数 + 原始流请求体）。
func (rt *router) sqliteImport(w http.ResponseWriter, r *http.Request) error {
	files, err := rt.requireSqlite()
	if err != nil {
		return err
	}
	instance, err := files.ImportFile(r.Context(), r.URL.Query().Get("name"), r.Body, r.ContentLength, r.Header.Get("Content-Type"))
	if err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusCreated, instance)
	return nil
}

// sqliteDownload GET /sqlite/{id}/download：一致性快照流式下载。
func (rt *router) sqliteDownload(w http.ResponseWriter, r *http.Request) error {
	files, err := rt.requireSqlite()
	if err != nil {
		return err
	}
	id := strings.TrimPrefix(chi.URLParam(r, "id"), "sqlite-")
	snapshot, err := files.Download(r.Context(), id)
	if err != nil {
		return err
	}
	file, err := os.Open(snapshot.Path)
	if err != nil {
		snapshot.Cleanup()
		return err
	}
	defer file.Close()
	w.Header().Set("Content-Type", "application/vnd.sqlite3")
	w.Header().Set("Content-Length", strconv.FormatInt(snapshot.Bytes, 10))
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", snapshot.Name))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, file); err != nil {
		snapshot.Cleanup()
		return nil // 响应已开始，无法再改状态码；清理快照后如实结束。
	}
	snapshot.Cleanup()
	return nil
}

// sqliteRemove DELETE /sqlite/{id}（需确认正文）。
func (rt *router) sqliteRemove(w http.ResponseWriter, r *http.Request) error {
	files, err := rt.requireSqlite()
	if err != nil {
		return err
	}
	body, err := middleware.ReadJSONBody(w, r, 0)
	if err != nil {
		return err
	}
	if obj(body)["confirm"] != "DELETE_SQLITE_FILE" {
		return shared.InvalidRequest("必须确认删除 SQLite 文件")
	}
	if err := files.Remove(r.Context(), strings.TrimPrefix(chi.URLParam(r, "id"), "sqlite-")); err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}

// sqliteReconcile POST /sqlite/{id}/reconcile；deleting 清理路径回 200 空主体。
func (rt *router) sqliteReconcile(w http.ResponseWriter, r *http.Request) error {
	files, err := rt.requireSqlite()
	if err != nil {
		return err
	}
	instance, hasBody, err := files.Reconcile(r.Context(), strings.TrimPrefix(chi.URLParam(r, "id"), "sqlite-"))
	if err != nil {
		return err
	}
	if !hasBody {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		return nil
	}
	shared.SendJSON(w, http.StatusOK, instance)
	return nil
}

// sqliteForget DELETE /sqlite/{id}/registration。
func (rt *router) sqliteForget(w http.ResponseWriter, r *http.Request) error {
	files, err := rt.requireSqlite()
	if err != nil {
		return err
	}
	if err := files.Forget(r.Context(), strings.TrimPrefix(chi.URLParam(r, "id"), "sqlite-")); err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusOK, okBody{OK: true})
	return nil
}
