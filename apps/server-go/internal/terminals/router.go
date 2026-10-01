package terminals

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/gorilla/websocket"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 终端路由（/api/terminals/*）：只做守卫链与升级委托，会话编排全部在服务层。
// 守卫链次序固定：503（可用性，Available=false 整片）→ 403（同源）→ 端点 → 404
//（未知终端端点：METHOD path）。app 级 requireSession（401）在挂载之前。

// Deps 终端片装配入参（go-plan §3.8）：Available 来自 cfg.HostOpsAvailable()
// （ModeDocker 与 ModeBareMetal 为真）；Logs 与 SessionConns 由装配层与 auth 片穿
// 同一实例——漏穿 logs 不会有测试变红、只会静默缺操作日志。
type Deps struct {
	Available    bool
	Logs         seam.Logs
	SessionConns seam.SessionConnections
}

// NewRouter 终端片路由器：不可用整片 503（任意方法、含未知路径，宿主机上绝不
// spawn PTY）；可用时挂真实宿主依赖的会话机。
func NewRouter(deps Deps) chi.Router {
	if !deps.Available {
		return unavailableRouter()
	}
	svc := newService(newHostDeps(), resolveHostIdentity, HostShellSessionSpec, TERMINAL_MAX_SESSIONS, realClock{})
	return newRouterWithService(deps, svc)
}

// unavailableRouter 不可用整片换 503 分支：任意方法、含未知路径。
func unavailableRouter() chi.Router {
	r := chi.NewRouter()
	h := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		shared.SendError(w, http.StatusServiceUnavailable, TERMINAL_UNAVAILABLE_MESSAGE)
	})
	r.Handle("/*", h)
	r.MethodNotAllowed(h)
	r.NotFound(h)
	return r
}

// statusBody /status 响应体；键序即 JSON 输出序。
type statusBody struct {
	OK bool `json:"ok"`
}

// newRouterWithService 挂指定会话机的路由器（NewRouter 的注入形态，路由测试用）。
func newRouterWithService(deps Deps, svc serviceApi) chi.Router {
	r := chi.NewRouter()
	r.Use(middleware.EndpointErrorHandler)
	// 同源守卫先于路由分发：跨源写请求（含未知路径的写）先 403 后 404。
	r.Use(middleware.SameOriginGuard())

	// 辅助端点：浏览器 WebSocket 拿不到升级失败的 HTTP 状态与原因，客户端连接
	// 失败时请求它取回中文原因。无副作用 GET，走既有放行语义。
	r.Get("/status", func(w http.ResponseWriter, _ *http.Request) {
		shared.SendJSON(w, http.StatusOK, statusBody{OK: true})
	})

	// WS 升级端点：前置校验（更严的同源 → 操作日志 → 撤销接线）全部以普通响应
	// 短路在升级调用之前；升级成功后本 handler goroutine 驱动读循环直至连接结束。
	r.Get("/ws", func(w http.ResponseWriter, req *http.Request) {
		if !middleware.SameOriginUpgrade(req) {
			shared.SendError(w, http.StatusForbidden, "请求来源不允许")
			return
		}
		// 打开会话是系统级操作，但 WS 升级不经写端点、采集中间件包不到，因此在
		// 同源校验通过之后、升级之前显式记一条操作日志（记录必须发生在升级前——
		// 升级之后没有 HTTP 响应可挂）。命令级别的记录不做：终端命令既不经 HTTP、
		// 也可能含敏感内容。
		if deps.Logs != nil {
			status := http.StatusOK
			deps.Logs.RecordOperation(seam.OperationRecord{
				Category:   "terminals",
				Action:     "打开本机终端会话",
				Result:     "success",
				Method:     "GET",
				Path:       shared.TerminalMount + "/ws",
				HTTPStatus: &status,
			})
		}
		// 会话撤销接线：requireSession 已在升级边界校验过该请求的会话，这里只取
		// id 不再 validate。connEvents 每请求构造（撤销归属该连接的会话）。
		var revocation seam.SessionConnections
		sessionID := ""
		if deps.SessionConns != nil {
			if id, ok := seam.ParseSessionCookie(req.Header.Get("Cookie")); ok {
				revocation = deps.SessionConns
				sessionID = id
			}
		}
		conn, err := middleware.Upgrade(w, req)
		if err != nil {
			// gorilla 已以普通 HTTP 响应回绝升级（拒绝天然发生在升级之前）。
			return
		}
		events := newConnEvents(svc, revocation, sessionID)
		events.OnOpen(conn)
		defer events.OnClose()
		for {
			messageType, data, err := conn.ReadMessage()
			if err != nil {
				break
			}
			if messageType == websocket.BinaryMessage {
				// 二进制帧一律违规（终端消息过大）；text 传 nil 表达该信号。
				events.OnMessage(conn, nil)
			} else {
				events.OnMessage(conn, data)
			}
		}
	})

	// 未知端点兜底：剥掉挂载前缀后的相对路径进文案；已有路径的方法不匹配
	//（如 POST /ws）同样落此 404，不走 chi 缺省 405。
	notFound := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		path := strings.TrimPrefix(req.URL.Path, shared.TerminalMount)
		if path == "" {
			path = "/"
		}
		shared.SendError(w, http.StatusNotFound, "未知终端端点："+req.Method+" "+path)
	})
	r.Handle("/*", notFound)
	r.MethodNotAllowed(notFound)
	r.NotFound(notFound)
	return r
}
