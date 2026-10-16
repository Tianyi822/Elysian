package harness

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// ChatOutput 是可替换的展示快照，最终消息仍以 Messages 为准。
type ChatOutput struct {
	RunID      string                `json:"runId"`
	ResponseID string                `json:"responseId"`
	Reasoning  string                `json:"reasoning"`
	Content    string                `json:"content"`
	Done       bool                  `json:"done"`
	Timeline   *ChatTimelineSnapshot `json:"timeline,omitempty"`
}

func chatOutput(run Run, records []ModelRequestRecord) ChatOutput {
	out := ChatOutput{RunID: run.ID, Done: terminal(run.Status)}
	var reasoning []string
	for _, record := range records {
		if record.Purpose != "inference" {
			continue
		}
		out.ResponseID, out.Content = record.ID, ""
		if record.Status == StateRunning || record.Status == StateCancelled {
			reasoning = append(reasoning, record.Reasoning)
			out.Content = record.Content
		} else if record.Response != nil {
			reasoning = append(reasoning, record.Response.Reasoning)
			if len(record.Response.ToolCalls) == 0 && record.Response.FinishReason == "stop" {
				out.Content = record.Response.Content
			}
		}
	}
	out.Reasoning = strings.TrimSpace(strings.Join(reasoning, "\n\n"))
	if out.Done && run.Status != StateSucceeded && run.Status != StateCancelled {
		out.Content = ""
	}
	return out
}

// 短连接只读流：合并 100ms 内的变化，重连发送当前快照，不重放模型请求。
// 每 30 秒重连；装配层绑定登录撤销与被动复验，写入超时及页面离开也会回收连接。
func streamChatOutput(_ runtimeService, agent agentRuntimeService, w http.ResponseWriter, req *http.Request) {
	if req.Context().Err() != nil {
		return
	}
	id := chi.URLParam(req, "id")
	read := func() (ChatOutput, error) {
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
