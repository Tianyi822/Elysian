package harness

import (
	"bytes"
	"context"
	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/shared"
	"encoding/json"
	"github.com/go-chi/chi/v5"
	"io"
	"net/http"
	"strconv"
	"strings"
)

func workflowPage[T any](ctx context.Context, m *Manager, table, where string, args []any, cursor string, n int) (Page[T], error) {
	p := Page[T]{Items: []T{}}
	limit, e := pageSize(n, 50)
	if e != nil {
		return p, e
	}
	offset, e := numberCursor(cursor)
	if e != nil {
		return p, e
	}
	args = append(args, offset, limit+1)
	rows, e := m.store.db.QueryContext(ctx, "SELECT rowid,document FROM "+table+" WHERE "+where+" AND rowid>? ORDER BY rowid LIMIT ?", args...)
	if e != nil {
		return p, e
	}
	defer rows.Close()
	var last int64
	for rows.Next() {
		var id int64
		var raw string
		if e = rows.Scan(&id, &raw); e != nil {
			return p, e
		}
		if len(p.Items) == limit {
			p.HasMore = true
			break
		}
		var item T
		if e = json.Unmarshal([]byte(raw), &item); e != nil {
			return p, e
		}
		p.Items = append(p.Items, item)
		last = id
	}
	if p.HasMore {
		p.NextCursor = strconv.FormatInt(last, 10)
	}
	return p, rows.Err()
}
func readWorkflowBody[T any](w http.ResponseWriter, req *http.Request) (T, error) {
	var v T
	if !strings.HasPrefix(req.Header.Get("Content-Type"), "application/json") {
		return v, bad("invalid-content-type", "请求必须使用 application/json")
	}
	raw, e := io.ReadAll(http.MaxBytesReader(w, req.Body, 1048576))
	if e != nil {
		return v, &Error{413, "input-too-large", "工作流请求体过大"}
	}
	if _, e = jsonvalue.Object(raw); e != nil {
		return v, bad("invalid-json", "请求必须是无重复键的 JSON 对象")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	dec.UseNumber()
	if e = dec.Decode(&v); e != nil {
		return v, bad("invalid-input", "工作流请求字段无效")
	}
	return v, nil
}

// registerWorkflowRoutes 保留一轮用于回滚；入口已退役，newRuntimeRouter 不再调用。
func registerWorkflowRoutes(r chi.Router, service runtimeService) {
	wrap := func(fn func(*Manager, http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			m, ok := service.(*Manager)
			if !ok {
				writeRuntimeError(w, &Error{503, "unavailable", "工作流服务不可用"})
				return
			}
			fn(m, w, req)
		}
	}
	send := func(w http.ResponseWriter, status int, v any, e error) {
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, status, v)
	}
	r.Get("/workflow-definitions", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := m.WorkflowDefinitions(req.Context())
		send(w, 200, v, e)
	}))
	r.Post("/workflow-definitions", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := readWorkflowBody[WorkflowDefinition](w, req)
		if e != nil {
			send(w, 0, nil, e)
			return
		}
		v, e = m.PutWorkflowDefinition(req.Context(), "", 0, v)
		send(w, 201, v, e)
	}))
	r.Get("/workflow-definitions/{id}", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		revision := 0
		var e error
		if s := req.URL.Query().Get("revision"); s != "" {
			revision, e = strconv.Atoi(s)
			if e != nil || revision < 1 {
				send(w, 0, nil, bad("invalid-revision", "模板修订必须为正整数"))
				return
			}
		}
		v, e := m.WorkflowDefinition(req.Context(), chi.URLParam(req, "id"), revision)
		send(w, 200, v, e)
	}))
	r.Put("/workflow-definitions/{id}", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		input, e := readWorkflowBody[struct {
			ExpectedRevision int `json:"expectedRevision"`
			WorkflowDefinition
		}](w, req)
		if e != nil {
			send(w, 0, nil, e)
			return
		}
		v, e := m.PutWorkflowDefinition(req.Context(), chi.URLParam(req, "id"), input.ExpectedRevision, input.WorkflowDefinition)
		send(w, 200, v, e)
	}))
	r.Post("/workflow-instances", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		input, e := readWorkflowBody[CreateWorkflowInput](w, req)
		if e != nil {
			send(w, 0, nil, e)
			return
		}
		v, duplicate, e := m.CreateWorkflow(req.Context(), input)
		status := 202
		if duplicate {
			status = 200
		}
		send(w, status, v, e)
	}))
	r.Get("/workflow-instances", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		q, e := runtimeQuery(req, 50, "status", "cursor", "limit")
		if e != nil {
			send(w, 0, nil, e)
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closed {
			send(w, 0, nil, closedError())
			return
		}
		state := req.URL.Query().Get("status")
		v, e := workflowPage[WorkflowInstance](req.Context(), m, "workflow_instances", "(?='' OR state=?)", []any{state, state}, q.Cursor, q.Limit)
		if e == nil {
			for i := range v.Items {
				v.Items[i].AllowedActions = m.workflowAllowedActions(req.Context(), v.Items[i])
			}
		}
		send(w, 200, v, e)
	}))
	r.Get("/workflow-instances/{id}", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := m.GetWorkflow(req.Context(), chi.URLParam(req, "id"))
		send(w, 200, v, e)
	}))
	r.Get("/workflow-instances/{id}/execution-tree", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := m.GetWorkflow(req.Context(), chi.URLParam(req, "id"))
		if e != nil {
			send(w, 0, nil, e)
			return
		}
		if v.ExecutionTree == nil {
			send(w, 200, WorkflowExecutionTree{Scopes: []WorkflowScope{}, Nodes: []WorkflowNodeExecution{}}, nil)
			return
		}
		send(w, 200, v.ExecutionTree, nil)
	}))
	r.Get("/workflow-instances/{id}/steps", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		q, e := runtimeQuery(req, 50, "cursor", "limit")
		if e != nil {
			send(w, 0, nil, e)
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closed {
			send(w, 0, nil, closedError())
			return
		}
		v, e := workflowPage[WorkflowAttempt](req.Context(), m, "workflow_attempts", "workflow_id=?", []any{chi.URLParam(req, "id")}, q.Cursor, q.Limit)
		send(w, 200, v, e)
	}))
	r.Get("/workflow-instances/{id}/events", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		q, e := runtimeQuery(req, 50, "cursor", "limit")
		if e != nil {
			send(w, 0, nil, e)
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closed {
			send(w, 0, nil, closedError())
			return
		}
		v, e := workflowPage[WorkflowEvent](req.Context(), m, "workflow_events", "workflow_id=?", []any{chi.URLParam(req, "id")}, q.Cursor, q.Limit)
		send(w, 200, v, e)
	}))
	r.Post("/workflow-instances/{id}/cancel", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := m.CancelWorkflow(req.Context(), chi.URLParam(req, "id"))
		send(w, 200, v, e)
	}))
	r.Post("/workflow-instances/{id}/recover", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		input, e := readWorkflowBody[WorkflowRecoveryInput](w, req)
		if e != nil {
			send(w, 0, nil, e)
			return
		}
		v, duplicate, e := m.RecoverWorkflow(req.Context(), chi.URLParam(req, "id"), input)
		status := 202
		if duplicate {
			status = 200
		}
		send(w, status, v, e)
	}))
}
