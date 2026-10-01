package docker

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/contract"
	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

// 容器管理子路由器（dockerRoutes.ts 逐字移植）：两段 503 先于一切路由与同源守卫；
// 次序 401（app 级）→ 503 → 403 → 415/413/400（读体）→ 端点 → 404 兜底。

const (
	sseRetryMs       = 3000
	sseHeartbeatMs   = 15000
	sseRetryFrame    = "retry: 3000\n\n"
	sseKeepAlive     = ": keep-alive\n\n"
	sseStatusConn    = ": status connecting\n\n"
	sseStatusLive    = ": status live\n\n"
	unavailableMsg   = "真实容器管理仅在 Docker 容器内可用"
	notReadyPrefix   = "Docker 服务未就绪"
	notReadyFallback = "无法连接 Docker socket"
)

var containerIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)

// routerDeps 路由装配入参（两段 503 与各注入项）。
type routerDeps struct {
	available               bool
	socketReady             bool
	socketUnavailableReason string
	service                 *dockerService
	eventsHub               *eventsHub
	transport               seam.DockerTransport
	execSessions            *execSessions
	logs                    seam.Logs
}

// newRouter 容器管理子路由器工厂（app 装配按 DOCKER_MOUNT 挂载）。
func newRouter(deps routerDeps) chi.Router {
	r := chi.NewRouter()

	if !deps.available {
		// 第一段 503：任意方法含未知路径（catch-all 路由，保证次序先于一切）。
		r.HandleFunc("/*", unavailableHandler(unavailableMsg))
		return r
	}
	if !deps.socketReady || deps.service == nil {
		reason := deps.socketUnavailableReason
		if reason == "" {
			reason = notReadyFallback
		}
		r.HandleFunc("/*", unavailableHandler(notReadyPrefix+"："+reason))
		return r
	}

	r.Use(middleware.SameOriginGuard())
	r.Use(middleware.EndpointErrorHandler)

	service := deps.service

	r.Get("/status", func(w http.ResponseWriter, _ *http.Request) {
		shared.SendJSON(w, http.StatusOK, statusBody{OK: true})
	})
	r.Get("/containers", func(w http.ResponseWriter, req *http.Request) {
		containers, err := service.ListContainers(req.Context())
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, containersBody{Containers: containers})
	})
	r.Get("/images", func(w http.ResponseWriter, req *http.Request) {
		images, err := service.ListImages(req.Context())
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, imagesBody{Images: images})
	})
	r.Get("/images/search", func(w http.ResponseWriter, req *http.Request) {
		result, err := service.SearchImages(req.Context(), req.URL.Query().Get("term"), req.URL.Query().Get("registry"))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, result)
	})
	r.Get("/images/tags", func(w http.ResponseWriter, req *http.Request) {
		result, err := service.ImageTags(req.Context(), req.URL.Query().Get("name"), req.URL.Query().Get("registry"))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, result)
	})
	r.Get("/policy", func(w http.ResponseWriter, _ *http.Request) {
		policy := service.Policy()
		shared.SendJSON(w, http.StatusOK, policyBody{MountRoot: policy.MountRoot, ReservedPorts: policy.ReservedPorts})
	})

	if deps.eventsHub != nil {
		r.Get("/events", sseHandler(deps.eventsHub))
	}

	postContainerAction := func(w http.ResponseWriter, req *http.Request, action string) {
		id := chi.URLParam(req, "id")
		if !containerIDPattern.MatchString(id) {
			middleware.WriteError(w, shared.InvalidRequest("容器 ID 格式无效"))
			return
		}
		container, err := service.Action(req.Context(), id, action)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, container)
	}

	r.Post("/containers", func(w http.ResponseWriter, req *http.Request) {
		body, err := middleware.ReadJSONBody(w, req, 0)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		container, err := service.Create(req.Context(), convertJSONValue(body))
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusCreated, container)
	})
	r.Post("/containers/{id}/start", func(w http.ResponseWriter, req *http.Request) {
		postContainerAction(w, req, "start")
	})
	r.Post("/containers/{id}/stop", func(w http.ResponseWriter, req *http.Request) {
		postContainerAction(w, req, "stop")
	})
	r.Post("/containers/{id}/restart", func(w http.ResponseWriter, req *http.Request) {
		postContainerAction(w, req, "restart")
	})
	r.Delete("/containers/{id}", func(w http.ResponseWriter, req *http.Request) {
		id := chi.URLParam(req, "id")
		if !containerIDPattern.MatchString(id) {
			middleware.WriteError(w, shared.InvalidRequest("容器 ID 格式无效"))
			return
		}
		if err := service.RemoveContainer(req.Context(), id); err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	r.Post("/images/pull", func(w http.ResponseWriter, req *http.Request) {
		body, err := middleware.ReadJSONBody(w, req, 0)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		image, err := service.Pull(req.Context(), convertJSONValue(body), nil)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		shared.SendJSON(w, http.StatusOK, image)
	})
	r.Post("/images/pull/stream", pullStreamHandler(service))
	r.Delete("/images/{id}", func(w http.ResponseWriter, req *http.Request) {
		id := chi.URLParam(req, "id")
		if !containerIDPattern.MatchString(id) {
			middleware.WriteError(w, shared.InvalidRequest("镜像 ID 格式无效"))
			return
		}
		if err := service.RemoveImage(req.Context(), id); err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	r.Get("/containers/{id}/terminal", terminalHandler(deps))

	attachFallback(r)
	return r
}

// attachFallback 404 兜底（剥挂载前缀）与 405 同文案兜底。chi 的 NotFound 不经过
// Use 中间件，故同源判定在此内联（对齐 TS 次序：403 先于 404）。
func attachFallback(r chi.Router) {
	fallback := func(w http.ResponseWriter, req *http.Request) {
		if !middleware.SameOrigin(req) {
			shared.SendError(w, http.StatusForbidden, "请求来源不允许")
			return
		}
		path := strings.TrimPrefix(req.URL.Path, shared.DockerMount)
		if path == "" {
			path = "/"
		}
		shared.SendError(w, http.StatusNotFound, fmt.Sprintf("未知容器管理端点：%s %s", req.Method, path))
	}
	r.NotFound(fallback)
	r.MethodNotAllowed(fallback)
}

// unavailableHandler 整片 503（任意方法含未知路径）。
func unavailableHandler(message string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		shared.SendError(w, http.StatusServiceUnavailable, message)
	}
}

// statusBody / containersBody / imagesBody / policyBody 响应形状（键序即输出序）。
type statusBody struct {
	OK bool `json:"ok"`
}

type containersBody struct {
	Containers []contract.Container `json:"containers"`
}

type imagesBody struct {
	Images []contract.ContainerImage `json:"images"`
}

type policyBody struct {
	MountRoot     string `json:"mountRoot"`
	ReservedPorts []int  `json:"reservedPorts"`
}

// ---------- SSE ----------

// sseSubscriber 单订阅者的帧队列（hub 广播侧不阻塞）。
type sseSubscriber struct {
	mu     sync.Mutex
	cond   *sync.Cond
	queue  []string
	closed bool
}

func newSseSubscriber() *sseSubscriber {
	s := &sseSubscriber{}
	s.cond = sync.NewCond(&s.mu)
	return s
}

func (s *sseSubscriber) push(frame string) {
	s.mu.Lock()
	s.queue = append(s.queue, frame)
	s.mu.Unlock()
	s.cond.Signal()
}

func (s *sseSubscriber) close() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.cond.Broadcast()
}

func (s *sseSubscriber) pop() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for len(s.queue) == 0 && !s.closed {
		s.cond.Wait()
	}
	if len(s.queue) == 0 {
		return "", false
	}
	frame := s.queue[0]
	s.queue = s.queue[1:]
	return frame, true
}

// sseHandler GET /events：订阅超限 503；retry 首帧；心跳 15s；断开即退订。
func sseHandler(hub *eventsHub) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		lastEventID := req.Header.Get("Last-Event-ID")
		subscriber := newSseSubscriber()
		unsubscribe, err := hub.Subscribe(hubHandlers{
			lastEventID: lastEventID,
			onEvent: func(event, id, data string) {
				subscriber.push(fmt.Sprintf("event: %s\nid: %s\ndata: %s\n\n", event, id, data))
			},
			onStatus: func(status string) {
				if status == "connecting" {
					subscriber.push(sseStatusConn)
				} else {
					subscriber.push(sseStatusLive)
				}
			},
		})
		if err != nil {
			if err == errMaxSubscribers {
				shared.SendError(w, http.StatusServiceUnavailable, err.Error())
				return
			}
			middleware.WriteError(w, err)
			return
		}
		defer unsubscribe()

		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.WriteHeader(http.StatusOK)

		flusher, _ := w.(http.Flusher)
		writeFrame := func(frame string) bool {
			if _, err := io.WriteString(w, frame); err != nil {
				return false
			}
			if flusher != nil {
				flusher.Flush()
			}
			return true
		}

		// 首帧 retry；断开监视与心跳先于出队循环建立（否则缓存循环等下一帧时
		// 取消无法生效），FIFO 队列保证 connecting → resync → live 次序。
		if !writeFrame(sseRetryFrame) {
			return
		}

		heartbeat := time.NewTicker(time.Duration(sseHeartbeatMs) * time.Millisecond)
		defer heartbeat.Stop()
		done := make(chan struct{})
		go func() {
			select {
			case <-req.Context().Done():
			case <-done:
			}
			subscriber.close()
		}()
		defer close(done)

		go func() {
			for {
				select {
				case <-heartbeat.C:
					subscriber.push(sseKeepAlive)
				case <-done:
					return
				}
			}
		}()

		for {
			frame, ok := subscriber.pop()
			if !ok {
				return
			}
			if !writeFrame(frame) {
				return
			}
		}
	}
}

// ---------- NDJSON 拉取流 ----------

// pullProgressFrame / pullResultFrame / pullErrorFrame 三种帧形状（键序固定）。
type pullProgressFrame struct {
	Type     string            `json:"type"`
	Progress imagePullProgress `json:"progress"`
}

type pullResultFrame struct {
	Type  string                  `json:"type"`
	Image contract.ContainerImage `json:"image"`
}

type pullErrorFrame struct {
	Type  string `json:"type"`
	Error string `json:"error"`
}

// pullStreamHandler POST /images/pull/stream：progress/result/error 三种帧；
// 校验失败也走 error 帧（200 开流后），客户端已断开则静默。
func pullStreamHandler(service *dockerService) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		body, err := middleware.ReadJSONBody(w, req, 0)
		if err != nil {
			middleware.WriteError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)

		writeLine := func(line string) {
			_, _ = io.WriteString(w, line+"\n")
			if flusher != nil {
				flusher.Flush()
			}
		}

		image, err := service.Pull(req.Context(), convertJSONValue(body), func(progress imagePullProgress) {
			data, marshalErr := shared.MarshalJSON(pullProgressFrame{Type: "progress", Progress: progress})
			if marshalErr != nil {
				return
			}
			writeLine(string(data))
		})
		if err != nil {
			if req.Context().Err() == nil {
				message := err.Error()
				data, marshalErr := shared.MarshalJSON(pullErrorFrame{Type: "error", Error: message})
				if marshalErr == nil {
					writeLine(string(data))
				}
			}
			return
		}
		data, marshalErr := shared.MarshalJSON(pullResultFrame{Type: "result", Image: image})
		if marshalErr != nil {
			return
		}
		writeLine(string(data))
	}
}

// ---------- 容器终端 WS 升级 ----------

// terminalHandler GET /containers/{id}/terminal：守卫次序 同源 → id → 就绪 →
// 运行态校验 → 审计 → 升级；自容器运行中也放行（终端不拦自己）。
func terminalHandler(deps routerDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		if !middleware.SameOriginUpgrade(req) {
			shared.SendError(w, http.StatusForbidden, "请求来源不允许")
			return
		}
		id := chi.URLParam(req, "id")
		if !containerIDPattern.MatchString(id) {
			middleware.WriteError(w, shared.InvalidRequest("容器 ID 格式无效"))
			return
		}
		if deps.transport == nil || deps.execSessions == nil {
			shared.SendError(w, http.StatusServiceUnavailable, notReadyPrefix)
			return
		}
		if err := assertContainerTerminalAllowed(req.Context(), deps.transport, id); err != nil {
			middleware.WriteError(w, err)
			return
		}
		if deps.logs != nil {
			status := http.StatusOK
			target := "容器 " + id
			deps.logs.RecordOperation(seam.OperationRecord{
				Category:   "containers",
				Action:     "打开容器终端",
				Target:     &target,
				Result:     "success",
				Method:     http.MethodGet,
				Path:       shared.DockerMount + "/containers/" + id + "/terminal",
				HTTPStatus: &status,
			})
		}
		events := deps.execSessions.CreateConnEvents(id)
		conn, err := middleware.Upgrade(w, req)
		if err != nil {
			// 升级失败：响应已写出，连接不可用。
			return
		}
		events.OnOpen(conn)
		go func() {
			for {
				_, data, err := conn.ReadMessage()
				if err != nil {
					events.OnClose()
					return
				}
				events.OnMessage(conn, data)
			}
		}()
	}
}

// assertContainerTerminalAllowed 终端升级前校验：404 / 非 running 409 / 其他 500。
func assertContainerTerminalAllowed(ctx context.Context, transport seam.DockerTransport, id string) error {
	response, err := transport.Request(ctx, seam.EngineRequest{
		Method:   http.MethodGet,
		Path:     "/containers/" + encodeEngineID(id) + "/json",
		Timeout:  10 * time.Second,
		MaxBytes: 32 * 1024 * 1024,
	})
	if err != nil {
		return err
	}
	if response.Status == http.StatusNotFound {
		return &shared.InvalidRequestError{Status: http.StatusNotFound, Message: containerNotFoundMessage}
	}
	if response.Status < 200 || response.Status >= 300 {
		return fmt.Errorf("获取容器详情失败（HTTP %d）", response.Status)
	}
	value, err := decodeOrderedJSON(response.Body)
	if err != nil {
		return errorsNewInvalidJSON()
	}
	record, ok := asRecord(value)
	if !ok {
		return fmt.Errorf("获取容器详情失败（HTTP %d）", response.Status)
	}
	status := ""
	if state, ok := asRecord(mustGet(record, "State")); ok {
		if s, ok := asString(mustGet(state, "Status")); ok {
			status = s
		}
	}
	if status != "running" {
		return &shared.InvalidRequestError{Status: http.StatusConflict, Message: "只有运行中的容器可以打开终端"}
	}
	return nil
}

func errorsNewInvalidJSON() error {
	return &staticError{"Docker 响应不是有效 JSON"}
}
