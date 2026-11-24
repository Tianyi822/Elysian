package docker

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/go-chi/chi/v5"

	"elysian/server/internal/middleware"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

func registerRecreateRoutes(r chi.Router, a *AgentFacade) {
	if a == nil {
		return
	}
	scope := func(req *http.Request) string {
		session, _ := seam.ParseSessionCookie(req.Header.Get("Cookie"))
		return "web:" + session
	}
	r.Get("/containers/{id}/recreate", func(w http.ResponseWriter, req *http.Request) {
		data, err := a.RecreateConfiguration(req.Context(), chi.URLParam(req, "id"))
		writeRecreateResponse(w, http.StatusOK, data, err)
	})
	r.Post("/containers/{id}/recreate/preview", func(w http.ResponseWriter, req *http.Request) {
		var patch RecreatePatch
		if err := readRecreateRequest(w, req, &patch); err != nil {
			middleware.WriteError(w, err)
			return
		}
		data, err := a.previewRecreate(req.Context(), chi.URLParam(req, "id"), patch, scope(req), true)
		writeRecreateResponse(w, http.StatusOK, data, err)
	})
	r.Post("/containers/{id}/recreate", func(w http.ResponseWriter, req *http.Request) {
		var input RecreateInput
		if err := readRecreateRequest(w, req, &input); err != nil {
			middleware.WriteError(w, err)
			return
		}
		id := chi.URLParam(req, "id")
		if input.ID != "" && input.ID != id {
			middleware.WriteError(w, shared.InvalidRequest("容器 ID 不一致"))
			return
		}
		input.ID = id
		data, err := a.submitRecreate(req.Context(), input, scope(req), true)
		writeRecreateResponse(w, http.StatusAccepted, RecreateTaskStatus(AgentOperationReceipt(data)), err)
	})
	r.Get("/recreate-tasks/{requestId}", func(w http.ResponseWriter, req *http.Request) {
		requestID := chi.URLParam(req, "requestId")
		if !agentOperationIDPattern.MatchString(requestID) {
			middleware.WriteError(w, shared.InvalidRequest("重建请求 ID 无效"))
			return
		}
		data, err := a.InspectContainerOperation(req.Context(), operationID(requestID))
		if err == nil && data.Recreate == nil {
			err = shared.NotFound("重建任务不存在")
		}
		if err == nil {
			data, err = a.ObserveRecreate(req.Context(), data)
		}
		writeRecreateResponse(w, http.StatusOK, RecreateTaskStatus(AgentOperationReceipt(data)), err)
	})
}

func writeRecreateResponse(w http.ResponseWriter, status int, value any, err error) {
	if err != nil {
		middleware.WriteError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	shared.SendJSON(w, status, value)
}

func readRecreateRequest(w http.ResponseWriter, req *http.Request, value any) error {
	decoder := json.NewDecoder(http.MaxBytesReader(w, req.Body, 128<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return shared.InvalidRequest("重建请求格式无效或超出大小限制")
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		return shared.InvalidRequest("重建请求必须是单个对象")
	}
	return nil
}
