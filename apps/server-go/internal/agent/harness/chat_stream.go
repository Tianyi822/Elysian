package harness

import (
	"encoding/json"
	"net/http"
	"time"

	hstate "elysian/server/internal/agent/harness/state"

	"github.com/go-chi/chi/v5"
)

// 短连接只读流：合并 100ms 内的变化，重连发送当前快照，不重放模型请求。
// 每 30 秒重连；装配层绑定登录撤销与被动复验，写入超时及页面离开也会回收连接。
func streamChatOutput(_ runtimeService, agent agentRuntimeService, w http.ResponseWriter, req *http.Request) {
	if req.Context().Err() != nil {
		return
	}
	id := chi.URLParam(req, "id")
	read := func() (hstate.ChatOutput, error) {
		return agent.ChatSnapshot(req.Context(), id)
	}
	output, err := read()
	if err != nil {
		writeRuntimeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	controller := http.NewResponseController(w)
	defer controller.SetWriteDeadline(time.Time{})
	send := func(event string, data []byte) bool {
		if req.Context().Err() != nil {
			return false
		}
		_ = controller.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if _, err := w.Write(append(append([]byte("event: "+event+"\ndata: "), data...), '\n', '\n')); err != nil {
			return false
		}
		return controller.Flush() == nil
	}
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()
	deadline := time.NewTimer(30 * time.Second)
	defer deadline.Stop()
	previous := ""
	for {
		data, _ := json.Marshal(output)
		if string(data) != previous {
			if !send("output", data) {
				return
			}
			previous = string(data)
		}
		if output.Done {
			return
		}
		select {
		case <-req.Context().Done():
			return
		case <-deadline.C:
			return
		case <-heartbeat.C:
			if !send("ping", []byte("{}")) {
				return
			}
		case <-tick.C:
			output, err = read()
			if err != nil {
				return
			}
		}
	}
}
