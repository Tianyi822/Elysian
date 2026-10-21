package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/skills"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/middleware"
	"elysian/server/internal/shared"
)

// runtimeService 只声明 HTTP 所需能力；Worker 与存储的生命周期由宿主管理。
type runtimeService interface {
	Info() RuntimeInfo
	Submit(context.Context, SubmitInput) (Run, bool, error)
	List(context.Context, ListQuery) (Page[Run], error)
	Get(context.Context, string) (Run, error)
	Calls(context.Context, string, string, int) (Page[Call], error)
	Events(context.Context, string, string, int) (Page[Event], error)
	Cancel(context.Context, string) (Run, error)
}

// Router 挂载在 /api/agent；会话鉴权由 app 统一覆盖。
func (m *Manager) Router() http.Handler { return newRuntimeRouter(m, "") }

// UnavailableRouter 保留可读取的运行能力报告，不创建演示任务。
func UnavailableRouter(reason string) http.Handler {
	if reason == "" {
		reason = "任务运行服务不可用"
	}
	return newRuntimeRouter(nil, reason)
}

func newRuntimeRouter(service runtimeService, unavailableReason string) http.Handler {
	r := chi.NewRouter()
	r.Use(panicGuard)
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			if !middleware.SameOrigin(req) {
				writeRuntimeError(w, &Error{Status: http.StatusForbidden, Code: "forbidden-origin", Message: "请求来源不允许"})
				return
			}
			next.ServeHTTP(w, req)
		})
	})
	r.Use(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			next.ServeHTTP(w, req)
		})
	})
	r.Get("/runtime", func(w http.ResponseWriter, req *http.Request) {
		info := RuntimeInfo{
			Available: false, Worker: "unavailable", Storage: "unavailable",
			Reason: unavailableReason, Tools: []tools.PublicSchema{}, Limits: DefaultLimits(),
		}
		if service != nil {
			info = service.Info()
			if info.Tools == nil {
				info.Tools = []tools.PublicSchema{}
			}
		}
		shared.SendJSON(w, http.StatusOK, info)
	})
	r.Group(func(r chi.Router) {
		r.Use(func(next http.Handler) http.Handler {
			return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
				if service == nil {
					writeRuntimeError(w, &Error{Status: http.StatusServiceUnavailable, Code: "unavailable", Message: unavailableReason})
					return
				}
				next.ServeHTTP(w, req)
			})
		})
		r.Post("/runs", func(w http.ResponseWriter, req *http.Request) {
			body, err := middleware.ReadJSONBody(w, req, int64(DefaultLimits().InputBytes))
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			raw, err := json.Marshal(body)
			if err != nil || len(raw) == 0 || raw[0] != '{' {
				writeRuntimeError(w, shared.InvalidRequest("任务请求必须为 JSON 对象"))
				return
			}
			var input SubmitInput
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			if err = decoder.Decode(&input); err != nil {
				writeRuntimeError(w, shared.InvalidRequest("任务请求字段无效或含未声明的字段"))
				return
			}
			run, duplicate, err := service.Submit(req.Context(), input)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			status := http.StatusAccepted
			if duplicate {
				status = http.StatusOK
			}
			w.Header().Set("Location", "/api/agent/runs/"+url.PathEscape(run.ID))
			shared.SendJSON(w, status, run)
		})
		r.Get("/runs", func(w http.ResponseWriter, req *http.Request) {
			query, err := runtimeQuery(req, 50, "status", "requestId", "sessionId", "taskId", "workflowId", "cursor", "limit")
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			status := req.URL.Query().Get("status")
			if status != "" && !validState(status) {
				writeRuntimeError(w, shared.InvalidRequest("运行状态无效"))
				return
			}
			query.WorkflowID = req.URL.Query().Get("workflowId")
			query.Status, query.RequestID = status, req.URL.Query().Get("requestId")
			query.SessionID, query.TaskID = req.URL.Query().Get("sessionId"), req.URL.Query().Get("taskId")
			page, err := service.List(req.Context(), query)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			if page.Items == nil {
				page.Items = []Run{}
			}
			shared.SendJSON(w, http.StatusOK, page)
		})
		r.Get("/runs/{id}", func(w http.ResponseWriter, req *http.Request) {
			run, err := service.Get(req.Context(), chi.URLParam(req, "id"))
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			shared.SendJSON(w, http.StatusOK, run)
		})
		r.Get("/runs/{id}/calls", func(w http.ResponseWriter, req *http.Request) {
			query, err := runtimeQuery(req, 50, "cursor", "limit")
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			page, err := service.Calls(req.Context(), chi.URLParam(req, "id"), query.Cursor, query.Limit)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			if page.Items == nil {
				page.Items = []Call{}
			}
			shared.SendJSON(w, http.StatusOK, page)
		})
		r.Get("/runs/{id}/events", func(w http.ResponseWriter, req *http.Request) {
			query, err := runtimeQuery(req, 100, "after", "limit")
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			after := req.URL.Query().Get("after")
			if after != "" {
				if _, err = strconv.ParseUint(after, 10, 63); err != nil || strings.HasPrefix(after, "+") {
					writeRuntimeError(w, shared.InvalidRequest("事件序号必须为非负十进制字符串"))
					return
				}
			}
			page, err := service.Events(req.Context(), chi.URLParam(req, "id"), after, query.Limit)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			if page.Items == nil {
				page.Items = []Event{}
			}
			shared.SendJSON(w, http.StatusOK, page)
		})
		r.Post("/runs/{id}/cancel", func(w http.ResponseWriter, req *http.Request) {
			run, err := service.Cancel(req.Context(), chi.URLParam(req, "id"))
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			status := http.StatusOK
			if run.Status == StateQueued || run.Status == StateRunning {
				status = http.StatusAccepted
			}
			shared.SendJSON(w, status, run)
		})
		registerAgentRoutes(r, service)
		registerCapabilityRoutes(r, service)
		registerExtensionRoutes(r, service)
		registerWikiRoutes(r, service)
		registerResourceRuleRoutes(r, service)
	})
	r.NotFound(func(w http.ResponseWriter, req *http.Request) {
		writeRuntimeError(w, &Error{Status: http.StatusNotFound, Code: "not-found", Message: "未知的任务运行端点"})
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, req *http.Request) {
		writeRuntimeError(w, &Error{Status: http.StatusMethodNotAllowed, Code: "method-not-allowed", Message: "任务运行端点不支持此请求方法"})
	})
	return r
}

func runtimeQuery(req *http.Request, defaultLimit int, allowed ...string) (ListQuery, error) {
	query := ListQuery{Limit: defaultLimit}
	values, err := url.ParseQuery(req.URL.RawQuery)
	if err != nil {
		return query, shared.InvalidRequest("查询参数编码无效")
	}
	for key, entries := range values {
		known := false
		for _, name := range allowed {
			known = known || key == name
		}
		if !known || len(entries) != 1 || entries[0] == "" || len(entries[0]) > 256 {
			return query, shared.InvalidRequest("查询参数无效或重复")
		}
	}
	if value := values.Get("limit"); value != "" {
		limit, err := strconv.Atoi(value)
		if err != nil || strings.HasPrefix(value, "+") || limit < 1 || limit > 200 {
			return query, shared.InvalidRequest("每页条数必须为 1 到 200 的整数")
		}
		query.Limit = limit
	}
	query.Cursor = values.Get("cursor")
	return query, nil
}

func writeRuntimeError(w http.ResponseWriter, err error) {
	status, code, message := http.StatusInternalServerError, "internal", "任务运行服务发生错误"
	var runtimeErr *Error
	var invalid *shared.InvalidRequestError
	var guard *shared.EndpointGuardError
	var modelErr *model.Error
	var skillErr *skills.Error
	var mcpErr *mcp.Error
	var execErr *execution.Error
	var configErr *execconfig.Error
	var workspaceErr *workspace.Error
	switch {
	case errors.As(err, &skillErr):
		status, code, message = skillErr.Status, skillErr.Code, skillErr.Message
	case errors.As(err, &mcpErr):
		status, code, message = mcpErr.Status, mcpErr.Code, mcpErr.Message
	case errors.As(err, &execErr):
		status, code, message = execErr.Status, execErr.Code, execErr.Message
	case errors.As(err, &configErr):
		status, code, message = configErr.Status, configErr.Code, configErr.Message
	case errors.As(err, &workspaceErr):
		status, code, message = workspaceErr.Status, workspaceErr.Code, workspaceErr.Message
	case errors.As(err, &runtimeErr):
		status, code, message = runtimeErr.Status, runtimeErr.Code, runtimeErr.Message
	case errors.As(err, &invalid):
		status, code, message = invalid.Status, "invalid-request", invalid.Message
	case errors.As(err, &guard):
		status, code, message = guard.Status, "invalid-request", guard.Message
	case errors.As(err, &modelErr):
		status, code, message = modelErr.Status, modelErr.Code, modelErr.Message
	}
	shared.SendJSON(w, status, struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}{Error: message, Code: code})
}

// panicGuard panic 兜底：recover 到的 panic 值可能携带绝对路径、SQL/引擎细节等
// 内部状态，一律不回显给客户端，固定按运行时未知错误回 500（与 writeRuntimeError
// 对未知错误的净化同口径，panic 路径不得旁路）；细节只写标准错误日志。
func panicGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		defer func() {
			rec := recover()
			if rec == nil {
				return
			}
			log.Printf("任务运行路由 panic：%s %s — %v", req.Method, req.URL.Path, rec)
			writeRuntimeError(w, &Error{Status: http.StatusInternalServerError, Code: "internal", Message: "任务运行服务发生错误"})
		}()
		next.ServeHTTP(w, req)
	})
}
