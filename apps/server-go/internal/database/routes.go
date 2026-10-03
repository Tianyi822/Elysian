package database

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"elysian/server/internal/middleware"
	"elysian/server/internal/paths"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// /api/databases 片路由（databaseRoutes.ts 等价物）：HTTP 端点 + 数据库协议 WS 终端
// （会话上限 5、帧校验、空闲超时、输出水位、显式审计）。装配经 NewRouter(Deps)。

// Deps 跨域依赖（go-plan §3.8 冻结形状）。
type Deps struct {
	// EngineAvailable docker.Stack.Ready（socket 就绪事实）。
	EngineAvailable bool
	// SqliteAvailable cfg.HostOpsAvailable()（容器/裸机门禁事实）。
	SqliteAvailable bool
	Engine          seam.DockerTransport
	Views           seam.DockerViews
	SelfID          string
	PortOpener      seam.PortOpener
	Logs            seam.Logs
}

// sqliteWorkerUID 生产 SQLite worker 的降权身份（容器与 go-dev 镜像均建 2001 账号）。
const sqliteWorkerUID = 2001

// NewRouter 构造 /api/databases 子路由器；可用性按子层拆分：
// 非容器/裸机环境整片 503，容器内 socket 未就绪仅剩 SQLite 片。
func NewRouter(deps Deps) chi.Router {
	var svc Service
	if deps.EngineAvailable && deps.Engine != nil && deps.Views != nil {
		svc = newDatabaseService(serviceDeps{
			registry:        newFileDatabaseRegistry(filepath.Join(paths.ConfigDir, "databases.json")),
			docker:          newDockerAPI(deps.Engine, deps.Views.ListImages, deps.Views.Policy().ReservedPorts),
			protocol:        newProtocolAPI(),
			listImages:      deps.Views.ListImages,
			listContainers:  deps.Views.ListContainers,
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
	return newRouter(routerDeps{available: deps.SqliteAvailable, service: svc, sqlite: sqliteSvc, logs: deps.Logs})
}

// routerDeps 路由器内部依赖（测试注入假服务用）。
type routerDeps struct {
	available bool
	service   Service
	sqlite    SqliteService
	logs      seam.Logs
}

// router 域路由器状态。
type router struct {
	deps           routerDeps
	terminalActive atomic.Int32
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
	r.Post("/sqlite", rt.handle(rt.sqliteCreate))
	r.Post("/sqlite/import", rt.handle(rt.sqliteImport))
	r.Get("/sqlite/{id}/download", rt.handle(rt.sqliteDownload))
	r.Delete("/sqlite/{id}", rt.handle(rt.sqliteRemove))
	r.Post("/sqlite/{id}/reconcile", rt.handle(rt.sqliteReconcile))
	r.Delete("/sqlite/{id}/registration", rt.handle(rt.sqliteForget))
	r.Get("/discover", rt.handle(rt.discover))
	r.Post("/{id}/reveal", rt.handle(rt.reveal))
	r.Delete("/{id}", rt.handle(rt.remove))
	r.Delete("/{id}/container", rt.handle(rt.removeContainer))
	r.Post("/{id}/reconcile", rt.handle(rt.reconcile))
	r.Delete("/{id}/registration", rt.handle(rt.forget))
	r.Get("/{id}/terminal", rt.handle(rt.terminal))

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

// requireService 服务型端点的可用性守卫。
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

// list GET /：服务型在前、SQLite 在后。
func (rt *router) list(w http.ResponseWriter, r *http.Request) error {
	instances := []any{}
	if rt.deps.service != nil {
		service, err := rt.requireService()
		if err != nil {
			return err
		}
		rows, err := service.List(r.Context())
		if err != nil {
			return err
		}
		for _, row := range rows {
			instances = append(instances, row)
		}
	}
	if rt.deps.sqlite != nil {
		files, err := rt.deps.sqlite.List(r.Context())
		if err != nil {
			return err
		}
		for _, row := range files {
			instances = append(instances, row)
		}
	}
	shared.SendJSON(w, http.StatusOK, instances)
	return nil
}

// create POST /：创建或接管服务型数据库。
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

// reveal POST /{id}/reveal：按需取普通账号凭证，响应禁止缓存。
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

// remove DELETE /{id}：删除逻辑库 / 清空 Redis DB 0。
func (rt *router) remove(w http.ResponseWriter, r *http.Request) error {
	service, err := rt.requireService()
	if err != nil {
		return err
	}
	if err := service.Remove(r.Context(), chi.URLParam(r, "id")); err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusOK, okBody{OK: true})
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

// reconcile POST /{id}/reconcile：重新核对。
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

// forget DELETE /{id}/registration：移除接管失败的待处理登记。
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

// discover GET /discover?engine=&versionTag=。
func (rt *router) discover(w http.ResponseWriter, r *http.Request) error {
	query := r.URL.Query()
	engine := query.Get("engine")
	if engine != engineMySQL && engine != engineMariaDB && engine != engineRedis {
		return shared.InvalidRequest("数据库引擎无效")
	}
	var versionTag *string
	if values, ok := query["versionTag"]; ok {
		versionTag = &values[0]
	}
	service, err := rt.requireService()
	if err != nil {
		return err
	}
	result, err := service.Discover(r.Context(), engine, versionTag)
	if err != nil {
		return err
	}
	shared.SendJSON(w, http.StatusOK, result)
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

// ---------- 数据库协议终端（WebSocket） ----------

const (
	maxTerminalSessions  = 5
	maxFrameBytes        = 64 * 1024
	terminalIdleTimeout  = 10 * time.Minute
	sendBufferLimitBytes = 1024 * 1024
)

// terminalFrameViolation 终端入站帧的类型与体积检查（先于会话查询）。
func terminalFrameViolation(messageType int, data []byte) string {
	if messageType != websocket.TextMessage {
		return "终端消息无效"
	}
	if len(data) > maxFrameBytes {
		return "输入超过 64 KiB"
	}
	return ""
}

// wsReadyFrame / wsErrorFrame / wsOutputFrame 终端服务端帧（键序对齐 TS）。
type wsReadyFrame struct {
	Type string `json:"type"`
}

type wsErrorFrame struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type wsOutputFrame struct {
	Type  string   `json:"type"`
	Lines []string `json:"lines"`
}

// sendGuarded 带水位检查的回执发送：非 OPEN 不发；缓冲达 1 MiB 以 1008 断开。
func sendGuarded(conn seam.WsConn, isOpen func() bool, payload any) {
	if !isOpen() {
		return
	}
	if conn.BufferedAmount() >= sendBufferLimitBytes {
		conn.Close(1008, "输出缓冲超限")
		return
	}
	data, err := shared.MarshalJSON(payload)
	if err != nil {
		return
	}
	conn.SendText(string(data))
}

// terminalConn 单条终端连接的会话状态。
type terminalConn struct {
	mu        sync.Mutex
	session   Session
	ready     bool
	busy      bool
	timer     *time.Timer
	closed    bool
	accounted bool
}

// isOpen 连接是否仍在 OPEN 态（本域视角）。
func (t *terminalConn) isOpen() func() bool {
	return func() bool {
		t.mu.Lock()
		defer t.mu.Unlock()
		return !t.closed
	}
}

// isClosed 快照读取关闭态。
func (t *terminalConn) isClosed() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.closed
}

// openResult openSession 的异步结果。
type openResult struct {
	session Session
	err     error
}

// auditTerminal 终端路径的显式操作审计（GET 升级不在审计中间件采集范围）。
func (rt *router) auditTerminal(id, action string, summary *string, result string, httpStatus *int) {
	if rt.deps.logs == nil {
		return
	}
	rt.deps.logs.RecordOperation(seam.OperationRecord{
		Category: "database", Action: action, Target: &id, Summary: summary,
		Result: result, Method: http.MethodGet, Path: "/api/databases/" + id + "/terminal",
		HTTPStatus: httpStatus,
	})
}

// releaseTerminal 一次性回收进程级会话计数。
func (rt *router) releaseTerminal(state *terminalConn) {
	state.mu.Lock()
	already := state.accounted
	state.accounted = true
	state.mu.Unlock()
	if !already {
		rt.terminalActive.Add(-1)
	}
}

// closeTerminal 标记关闭并发送关闭帧。
func (rt *router) closeTerminal(state *terminalConn, conn seam.WsConn, code int, reason string) {
	state.mu.Lock()
	state.closed = true
	state.mu.Unlock()
	conn.Close(code, reason)
}

// terminalClosed 读循环退出：清定时器、关会话、按就绪态回收计数。
func (rt *router) terminalClosed(state *terminalConn) {
	state.mu.Lock()
	if state.timer != nil {
		state.timer.Stop()
	}
	wasReady := state.ready
	session := state.session
	state.closed = true
	state.mu.Unlock()
	if session != nil {
		_ = session.Close()
		if wasReady {
			rt.releaseTerminal(state)
		}
	}
	// 未就绪窗口期：计数由 openSession 完成方回收，不重复减。
}

// terminal GET /{id}/terminal：WS 升级与帧协议。
func (rt *router) terminal(w http.ResponseWriter, r *http.Request) error {
	id := chi.URLParam(r, "id")
	// 拒绝路径也要留痕：GET 升级不在采集中间件范围内，被拒的终端连接尝试显式记 failure。
	if !middleware.SameOriginUpgrade(r) {
		status := http.StatusForbidden
		rt.auditTerminal(id, "发起数据库协议终端连接", nil, "failure", &status)
		shared.SendError(w, http.StatusForbidden, "请求来源不允许")
		return nil
	}
	isSqlite := strings.HasPrefix(id, "sqlite-")
	if (isSqlite && rt.deps.sqlite == nil) || (!isSqlite && rt.deps.service == nil) {
		status := http.StatusServiceUnavailable
		rt.auditTerminal(id, "发起数据库协议终端连接", nil, "failure", &status)
		shared.SendError(w, http.StatusServiceUnavailable, "数据库终端服务不可用")
		return nil
	}
	conn, err := middleware.Upgrade(w, r)
	if err != nil {
		// gorilla 已写出拒绝响应（非升级请求等传输层拒绝），不重复写错误体。
		return nil
	}
	state := &terminalConn{}
	if rt.terminalActive.Add(1) > maxTerminalSessions {
		rt.terminalActive.Add(-1)
		conn.Close(1008, "数据库终端会话已达上限")
		summary := "数据库终端会话已达上限"
		rt.auditTerminal(id, "发起数据库协议终端连接", &summary, "failure", nil)
		return nil
	}
	idleClose := func() { rt.closeTerminal(state, conn, 1000, "数据库终端空闲超时") }
	openDone := make(chan openResult, 1)
	go func() {
		var result openResult
		if isSqlite {
			result.session, result.err = rt.deps.sqlite.OpenSession(context.Background(), strings.TrimPrefix(id, "sqlite-"))
		} else {
			result.session, result.err = rt.deps.service.OpenSession(context.Background(), id)
		}
		openDone <- result
		state.mu.Lock()
		if result.err != nil {
			state.mu.Unlock()
			rt.releaseTerminal(state)
			if data, err := shared.MarshalJSON(wsErrorFrame{Type: "error", Text: result.err.Error()}); err == nil {
				conn.SendText(string(data))
			}
			conn.Close(1011, "数据库连接失败")
			rt.auditTerminal(id, "发起数据库协议终端连接", strPtr(result.err.Error()), "failure", nil)
			return
		}
		// 客户端在会话建立完成前断开：升级未真正落地，不记审计（比伪 success 更接近事实）。
		if state.closed {
			state.mu.Unlock()
			rt.releaseTerminal(state)
			_ = result.session.Close()
			return
		}
		state.session = result.session
		state.ready = true
		state.timer = time.AfterFunc(terminalIdleTimeout, idleClose)
		state.mu.Unlock()
		if data, err := shared.MarshalJSON(wsReadyFrame{Type: "ready"}); err == nil {
			conn.SendText(string(data))
		}
		rt.auditTerminal(id, "发起数据库协议终端连接", nil, "success", nil)
	}()
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			rt.terminalClosed(state)
			return nil
		}
		// 类型与体积检查先于会话查询：无会话窗口期与二进制帧同样受检。
		if reason := terminalFrameViolation(messageType, data); reason != "" {
			rt.closeTerminal(state, conn, 1008, reason)
			rt.terminalClosed(state)
			return nil
		}
		state.mu.Lock()
		if !state.ready {
			// 无会话（openSession 未完成窗口期）：直接忽略，等会话建立。
			state.mu.Unlock()
			continue
		}
		var frame struct {
			Type string `json:"type"`
			Text any    `json:"text"`
		}
		if json.Unmarshal(data, &frame) != nil {
			state.mu.Unlock()
			rt.closeTerminal(state, conn, 1008, "终端消息无效")
			rt.terminalClosed(state)
			return nil
		}
		if frame.Type == "interrupt" {
			state.mu.Unlock()
			rt.closeTerminal(state, conn, 1000, "执行已中断")
			rt.terminalClosed(state)
			return nil
		}
		text, textOK := frame.Text.(string)
		if frame.Type != "execute" || !textOK {
			state.mu.Unlock()
			rt.closeTerminal(state, conn, 1008, "终端消息无效")
			rt.terminalClosed(state)
			return nil
		}
		if state.busy {
			state.mu.Unlock()
			sendGuarded(conn, state.isOpen(), wsErrorFrame{Type: "error", Text: "上一条命令仍在执行"})
			continue
		}
		state.busy = true
		if state.timer != nil {
			state.timer.Stop()
		}
		session := state.session
		state.mu.Unlock()
		go func() {
			lines, execErr := session.Execute(context.Background(), text)
			if execErr != nil {
				sendGuarded(conn, state.isOpen(), wsErrorFrame{Type: "error", Text: execErr.Error()})
				rt.auditTerminal(id, "执行数据库终端语句", strPtr(execErr.Error()), "failure", nil)
			} else {
				// 结果由单会话闭包发回，语句正文不进入操作日志。
				if !state.isClosed() && conn.BufferedAmount() < sendBufferLimitBytes {
					if data, err := shared.MarshalJSON(wsOutputFrame{Type: "output", Lines: lines}); err == nil {
						conn.SendText(string(data))
					}
					summary := fmt.Sprintf("输出 %d 行", len(lines))
					rt.auditTerminal(id, "执行数据库终端语句", &summary, "success", nil)
				} else {
					rt.closeTerminal(state, conn, 1008, "输出缓冲超限")
				}
			}
			state.mu.Lock()
			state.busy = false
			if !state.closed {
				state.timer = time.AfterFunc(terminalIdleTimeout, idleClose)
			}
			state.mu.Unlock()
		}()
	}
}

// strPtr 取字符串指针。
func strPtr(value string) *string { return &value }
