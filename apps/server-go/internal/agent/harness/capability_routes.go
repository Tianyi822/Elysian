package harness

import (
	"net/http"
	"strconv"

	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/shared"
	"github.com/go-chi/chi/v5"
)

func registerCapabilityRoutes(r chi.Router, service runtimeService) {
	wrap := func(fn func(*Manager, http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			m, ok := service.(*Manager)
			if !ok {
				writeRuntimeError(w, &Error{503, "unavailable", "扩展运行服务不可用"})
				return
			}
			fn(m, w, req)
		}
	}
	respond := func(w http.ResponseWriter, value any, err error) {
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, value)
	}

	r.Post("/approvals/{id}/access-decision", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[AccessDecision](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := m.DecideAccess(req.Context(), chi.URLParam(req, "id"), in)
		respond(w, v, e)
	}))
	r.Get("/sessions/{id}/authorizations", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		rows, e := m.SessionAuthorizations(req.Context(), chi.URLParam(req, "id"))
		respond(w, map[string]any{"items": rows}, e)
	}))
	r.Delete("/sessions/{id}/authorizations/{authorizationId}", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[RevokeAuthorizationInput](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := m.RevokeSessionAuthorization(req.Context(), chi.URLParam(req, "id"), chi.URLParam(req, "authorizationId"), in)
		respond(w, v, e)
	}))
	r.Get("/sessions/{id}/environment", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := m.GetEnvironment(req.Context(), chi.URLParam(req, "id"))
		respond(w, v, e)
	}))
	r.Put("/sessions/{id}/environment", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[struct {
			ExpectedRevision int         `json:"expectedRevision"`
			Environment      Environment `json:"environment"`
		}](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := m.PutEnvironment(req.Context(), chi.URLParam(req, "id"), in.ExpectedRevision, in.Environment)
		respond(w, v, e)
	}))
	r.Get("/approvals", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		if _, e := runtimeQuery(req, 50, "workflowId", "runId"); e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := m.ApprovalsByRun(req.Context(), req.URL.Query().Get("workflowId"), req.URL.Query().Get("runId"))
		respond(w, v, e)
	}))
	r.Get("/tools", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		if _, e := runtimeQuery(req, 50, "sessionId", "domain", "available"); e != nil {
			writeRuntimeError(w, e)
			return
		}
		var available *bool
		if raw := req.URL.Query().Get("available"); raw != "" {
			value, e := strconv.ParseBool(raw)
			if e != nil {
				writeRuntimeError(w, bad("invalid-filter", "available 必须为 true 或 false"))
				return
			}
			available = &value
		}
		v, e := m.ToolCatalog(req.Context(), req.URL.Query().Get("sessionId"), req.URL.Query().Get("domain"), available)
		respond(w, v, e)
	}))
	r.Post("/approvals/{id}/decision", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[struct {
			Decision string `json:"decision"`
		}](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := m.Decide(req.Context(), chi.URLParam(req, "id"), in.Decision)
		respond(w, v, e)
	}))
	r.Get("/runs/{id}/operations", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := m.Operations(req.Context(), chi.URLParam(req, "id"))
		respond(w, v, e)
	}))
	r.Get("/runs/{id}/context-items", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := m.ContextItems(req.Context(), chi.URLParam(req, "id"))
		respond(w, v, e)
	}))
	r.Get("/execution-barriers", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		v, e := m.BarriersFiltered(req.Context(), req.URL.Query().Get("workflowId"))
		respond(w, v, e)
	}))
	r.Post("/execution-barriers/{id}/reconcile", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[struct {
			Decision string `json:"decision"`
			Evidence string `json:"evidence"`
		}](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := m.Reconcile(req.Context(), chi.URLParam(req, "id"), in.Evidence, in.Decision)
		respond(w, v, e)
	}))
	for _, entry := range []struct{ path, kind string }{{"skills", "skill"}, {"mcp-servers", "mcp"}, {"execution-profiles", "execution-profile"}, {"grants", "grant"}} {
		kind := entry.kind
		r.Post("/"+entry.path+"/{id}/revoke", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
			in, e := readAgentInput[struct {
				Revision int    `json:"revision"`
				Reason   string `json:"reason"`
			}](w, req)
			if e != nil {
				writeRuntimeError(w, e)
				return
			}
			e = m.Revoke(req.Context(), kind, chi.URLParam(req, "id"), in.Revision, in.Reason)
			respond(w, map[string]bool{"revoked": e == nil}, e)
		}))
	}
	r.Get("/capability-revocations", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		query, e := runtimeQuery(req, 50, "kind", "id", "cursor", "limit")
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		page, e := m.CapabilityRevocations(req.Context(), CapabilityRevocationQuery{
			Kind: req.URL.Query().Get("kind"), ID: req.URL.Query().Get("id"), Cursor: query.Cursor, Limit: query.Limit,
		})
		respond(w, page, e)
	}))
	r.Get("/tasks/{id}/workspace", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
		if _, e := runtimeQuery(req, 50, "path"); e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := m.Workspace(req.Context(), chi.URLParam(req, "id"), req.URL.Query().Get("path"))
		respond(w, v, e)
	}))
	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		method := method
		r.Method(method, "/tasks/{id}/workspace", wrap(func(m *Manager, w http.ResponseWriter, req *http.Request) {
			if _, e := runtimeQuery(req, 50, "path", "expectedRevision"); e != nil {
				writeRuntimeError(w, e)
				return
			}
			expected, e := strconv.Atoi(req.URL.Query().Get("expectedRevision"))
			if e != nil || expected < 0 || req.URL.Query().Get("path") == "" {
				writeRuntimeError(w, bad("workspace-input", "必须提供 path 与非负 expectedRevision"))
				return
			}
			var v workspace.Version
			if method == http.MethodPut {
				v, e = m.WriteWorkspace(req.Context(), chi.URLParam(req, "id"), expected, req.URL.Query().Get("path"), http.MaxBytesReader(w, req.Body, workspace.DefaultTaskBytes))
			} else {
				v, e = m.DeleteWorkspace(req.Context(), chi.URLParam(req, "id"), expected, req.URL.Query().Get("path"))
			}
			respond(w, v, e)
		}))
	}
}
