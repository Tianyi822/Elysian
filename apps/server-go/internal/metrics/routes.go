package metrics

import (
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/shared"
)

// Register 把 metrics 域两个根级端点挂进 api 路由。路径无共同前缀（仪表盘契约
// 固定为 /api/resources/history 与 /api/events），不走 Mount、由装配层整组
// RequireSession 保护；非 GET 由 chi 缺省 405＋Allow 头。
func Register(r chi.Router, service *Service) {
	h := &handlers{service: service}
	r.Get(shared.ResourcesHistoryPath, h.history)
	r.Get(shared.EventsStreamPath, h.events)
}

// handlers 域路由处理器。
type handlers struct {
	service *Service
}

// historyHandler GET /api/resources/history?range=5m|30m|1h|5h|7d：返回窗口内采样点
// 数组（键序即 JSON 输出序）；range 缺失或非法 400 {"error":"无效的时间范围"}。
func (h *handlers) history(w http.ResponseWriter, r *http.Request) {
	rangeKey := r.URL.Query().Get("range")
	if _, ok := timeRangeDurationMs(rangeKey); !ok {
		shared.SendError(w, http.StatusBadRequest, "无效的时间范围")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	shared.SendJSON(w, http.StatusOK, h.service.History(rangeKey, h.service.NowMs()))
}

// eventsHandler GET /api/events：resource/sample 事件流（SSE）。首帧 retry、连接即
// 补发最近一拍、15 秒 keep-alive 心跳、Last-Event-ID 重连不重发已投递事件；
// 断开即退订，超订 503。
func (h *handlers) events(w http.ResponseWriter, r *http.Request) {
	lastEventID := r.Header.Get("Last-Event-ID")
	if lastEventID == "" {
		// EventSource 重连只会带头；查询参数兜底对齐 mock 端点（调试用）。
		lastEventID = r.URL.Query().Get("lastEventId")
	}
	frames, cancel, err := h.service.hub.subscribe(lastEventID)
	if err != nil {
		shared.SendError(w, http.StatusServiceUnavailable, err.Error())
		return
	}
	defer cancel()

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
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

	// 首帧重连间隔；心跳与请求取消并行于读帧循环（谁先到处理谁，断开即退订）。
	if !writeFrame(sseRetryFrame()) {
		return
	}
	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case frame, ok := <-frames:
			if !ok || !writeFrame(frame) {
				return
			}
		case <-heartbeat.C:
			if !writeFrame(sseKeepAliveFrame) {
				return
			}
		case <-r.Context().Done():
			return
		}
	}
}

// sseRetryFrame 重连间隔首帧：`retry: 5000`（毫秒）。
func sseRetryFrame() string {
	return "retry: " + strconv.Itoa(sseRetryMs) + "\n\n"
}

// sseKeepAliveFrame 心跳注释帧（SSE 规范的 `: keep-alive`）。
const sseKeepAliveFrame = ": keep-alive\n\n"
