package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/shared"
	"github.com/go-chi/chi/v5"
)

type agentRuntimeService interface {
	ListModelServices() ([]model.Service, error)
	CreateModelService(model.ServiceInput) (model.Service, error)
	UpdateModelService(string, int, model.ServiceInput) (model.Service, error)
	DiscoverModels(context.Context, model.DiscoveryInput) ([]model.DiscoveredModel, error)
	ListModelProfiles() ([]model.Profile, error)
	CreateModelProfile(model.Input) (model.Profile, error)
	UpdateModelProfile(string, int, model.Input) (model.Profile, error)
	CreateSession(context.Context, CreateSessionInput) (Session, error)
	RenameSession(context.Context, string, RenameSessionInput) (Session, error)
	DeleteSession(context.Context, string) error
	SwitchSessionModel(context.Context, string, SwitchModelInput) (Session, error)
	GetSession(context.Context, string) (Session, error)
	ListSessions(context.Context, string, int) (Page[Session], error)
	ListSessionsByActivity(context.Context, string, int) (Page[Session], error)
	GetTask(context.Context, string) (Task, error)
	ListTasks(context.Context, string, string, int) (Page[Task], error)
	Messages(context.Context, string, string, int) (Page[Message], error)
	Memory(context.Context, string, int) (WorkingMemory, error)
	ModelRequests(context.Context, string, string, int) (Page[ModelRequestRecord], error)
	CreateTask(context.Context, string, AgentInput) (Run, bool, error)
	ContinueTask(context.Context, string, AgentInput) (Run, bool, error)
}

func readAgentInput[T any](w http.ResponseWriter, req *http.Request) (T, error) {
	var input T
	if req.Header.Get("Content-Type") != "application/json" && !strings.HasPrefix(req.Header.Get("Content-Type"), "application/json;") {
		return input, shared.InvalidRequest("请求必须使用 application/json")
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, req.Body, int64(DefaultLimits().InputBytes)))
	if err != nil {
		return input, &Error{413, "input-too-large", "请求体超过容量限制"}
	}
	if _, err = jsonvalue.Object(raw); err != nil {
		return input, shared.InvalidRequest("请求必须为 JSON 对象")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&input); err != nil {
		return input, shared.InvalidRequest("请求字段无效或含未声明的字段")
	}
	return input, nil
}

func registerAgentRoutes(r chi.Router, service runtimeService) {
	wrap := func(handler func(agentRuntimeService, http.ResponseWriter, *http.Request)) http.HandlerFunc {
		return func(w http.ResponseWriter, req *http.Request) {
			agent, ok := service.(agentRuntimeService)
			if !ok {
				writeRuntimeError(w, &Error{Status: 503, Code: "unavailable", Message: "Agent 会话服务不可用"})
				return
			}
			handler(agent, w, req)
		}
	}
	r.Post("/model-services/discover", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		input, err := readAgentInput[model.DiscoveryInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		models, err := s.DiscoverModels(req.Context(), input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, models)
	}))
	r.Get("/model-services", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		services, err := s.ListModelServices()
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, services)
	}))
	r.Post("/model-services", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		input, err := readAgentInput[model.ServiceInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		service, err := s.CreateModelService(input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 201, service)
	}))
	r.Put("/model-services/{id}", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		input, err := readAgentInput[struct {
			ExpectedRevision int `json:"expectedRevision"`
			model.ServiceInput
		}](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		service, err := s.UpdateModelService(chi.URLParam(req, "id"), input.ExpectedRevision, input.ServiceInput)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, service)
	}))

	r.Get("/model-profiles", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50); err != nil {
			writeRuntimeError(w, err)
			return
		}
		profiles, err := s.ListModelProfiles()
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		if profiles == nil {
			profiles = []model.Profile{}
		}
		shared.SendJSON(w, 200, profiles)
	}))
	r.Post("/model-profiles", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		input, err := readAgentInput[model.Input](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		profile, err := s.CreateModelProfile(input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 201, profile)
	}))
	r.Put("/model-profiles/{id}", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		input, err := readAgentInput[struct {
			ExpectedRevision int `json:"expectedRevision"`
			model.Input
		}](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		profile, err := s.UpdateModelProfile(chi.URLParam(req, "id"), input.ExpectedRevision, input.Input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, profile)
	}))
	r.Post("/sessions", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		input, err := readAgentInput[CreateSessionInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		session, err := s.CreateSession(req.Context(), input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		w.Header().Set("Location", "/api/agent/sessions/"+url.PathEscape(session.ID))
		shared.SendJSON(w, 201, session)
	}))
	r.Get("/sessions", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		q, err := runtimeQuery(req, 50, "cursor", "limit", "sort")
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		var page Page[Session]
		switch req.URL.Query().Get("sort") {
		case "":
			page, err = s.ListSessions(req.Context(), q.Cursor, q.Limit)
		case "activity":
			page, err = s.ListSessionsByActivity(req.Context(), q.Cursor, q.Limit)
		default:
			err = bad("invalid-sort", "会话排序方式无效")
		}
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, page)
	}))
	r.Get("/sessions/{id}", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		session, err := s.GetSession(req.Context(), chi.URLParam(req, "id"))
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, session)
	}))
	r.Put("/sessions/{id}/model", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		input, err := readAgentInput[SwitchModelInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		session, err := s.SwitchSessionModel(req.Context(), chi.URLParam(req, "id"), input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, session)
	}))
	r.Put("/sessions/{id}/title", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		input, err := readAgentInput[RenameSessionInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		session, err := s.RenameSession(req.Context(), chi.URLParam(req, "id"), input)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, session)
	}))
	r.Delete("/sessions/{id}", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		if err := s.DeleteSession(req.Context(), chi.URLParam(req, "id")); err != nil {
			writeRuntimeError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	r.Get("/sessions/{id}/messages", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		q, err := runtimeQuery(req, 100, "after", "limit")
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		page, err := s.Messages(req.Context(), chi.URLParam(req, "id"), req.URL.Query().Get("after"), q.Limit)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, page)
	}))
	r.Get("/sessions/{id}/tasks", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		q, err := runtimeQuery(req, 50, "cursor", "limit")
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		page, err := s.ListTasks(req.Context(), chi.URLParam(req, "id"), q.Cursor, q.Limit)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, page)
	}))
	r.Get("/tasks/{id}", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		task, err := s.GetTask(req.Context(), chi.URLParam(req, "id"))
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, task)
	}))
	r.Get("/tasks/{id}/memory", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50, "revision"); err != nil {
			writeRuntimeError(w, err)
			return
		}
		revision := 0
		if raw := req.URL.Query().Get("revision"); raw != "" {
			value, err := numberCursor(raw)
			if err != nil || value < 1 || value > 2147483647 {
				writeRuntimeError(w, bad("invalid-revision", "工作记忆版本必须为正整数"))
				return
			}
			revision = int(value)
		}
		memory, err := s.Memory(req.Context(), chi.URLParam(req, "id"), revision)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, memory)
	}))
	r.Get("/runs/{id}/output", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		streamChatOutput(service, s, w, req)
	}))
	r.Get("/runs/{id}/model-requests", wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
		q, err := runtimeQuery(req, 50, "cursor", "limit")
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		page, err := s.ModelRequests(req.Context(), chi.URLParam(req, "id"), q.Cursor, q.Limit)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, 200, page)
	}))
	for _, entry := range []struct {
		path   string
		create bool
	}{{"/sessions/{id}/tasks", true}, {"/tasks/{id}/runs", false}} {
		create := entry.create
		r.Post(entry.path, wrap(func(s agentRuntimeService, w http.ResponseWriter, req *http.Request) {
			input, err := readAgentInput[AgentInput](w, req)
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			var run Run
			var duplicate bool
			if create {
				run, duplicate, err = s.CreateTask(req.Context(), chi.URLParam(req, "id"), input)
			} else {
				run, duplicate, err = s.ContinueTask(req.Context(), chi.URLParam(req, "id"), input)
			}
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			status := http.StatusAccepted
			if duplicate {
				status = http.StatusOK
			}
			w.Header().Set("Location", "/api/agent/runs/"+url.PathEscape(run.ID))
			w.Header().Set("X-Agent-Run-Number", strconv.Itoa(run.RunNumber))
			shared.SendJSON(w, status, run)
		}))
	}
}
