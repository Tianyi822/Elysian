package harness

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"elysian/server/internal/shared"
	"github.com/go-chi/chi/v5"
)

type wikiRuntimeService interface {
	ListWikiSpaces(context.Context) ([]WikiSpace, error)
	CreateWikiSpace(context.Context, string, string) (WikiSpace, error)
	SetWikiSessionSpace(context.Context, string, string, bool) (WikiSpace, error)
	ListWikiPages(context.Context, string, bool) ([]WikiPage, error)
	CreateWikiPage(context.Context, string, WikiPageInput) (WikiPage, error)
	GetWikiPage(context.Context, string) (WikiPage, error)
	UpdateWikiPage(context.Context, string, WikiPageInput) (WikiPage, error)
	WithdrawWikiPage(context.Context, string, int) (WikiPage, error)
	SearchWiki(context.Context, string, string, int) (WikiSearchResult, error)
	WikiCheck(context.Context, string) (WikiCheck, error)
	ExportWiki(context.Context, string) (WikiExport, error)
	ImportWiki(context.Context, string, map[string]string) ([]WikiCandidate, error)
	ListWikiCandidates(context.Context, string, string) ([]WikiCandidate, error)
	DecideWikiCandidate(context.Context, string, string, ...int) (WikiCandidate, error)
	ListEmbeddingProfiles(context.Context) ([]EmbeddingProfile, error)
	CreateEmbeddingProfile(context.Context, EmbeddingProfileInput) (EmbeddingProfile, error)
	UpdateEmbeddingProfile(context.Context, string, int, EmbeddingProfileInput) (EmbeddingProfile, error)
	ListWikiJobs(context.Context, string, int) (Page[WikiJob], error)
	GetWikiJob(context.Context, string) (WikiJob, error)
	CreateWikiExtraction(context.Context, WikiExtractionInput) (WikiJob, bool, error)
	ListWikiIndexes(context.Context, string) ([]WikiIndexStatus, error)
	RebuildWikiIndex(context.Context, string, WikiIndexInput) (WikiJob, error)
	ListEmbeddingRequests(context.Context, string, int) (Page[EmbeddingRequest], error)
}

func registerWikiRoutes(r chi.Router, service runtimeService) {
	s, ok := service.(wikiRuntimeService)
	if !ok {
		return
	}
	registerMemoryRoutes(r, s)
	read := func(w http.ResponseWriter, req *http.Request, fn func() (any, error)) {
		v, e := fn()
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusOK, v)
	}
	r.Get("/wiki/spaces", func(w http.ResponseWriter, req *http.Request) {
		read(w, req, func() (any, error) { return s.ListWikiSpaces(req.Context()) })
	})
	r.Post("/wiki/spaces", func(w http.ResponseWriter, req *http.Request) {
		var in struct {
			Name string `json:"name"`
			Kind string `json:"kind"`
		}
		if json.NewDecoder(req.Body).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Wiki 空间请求无效"))
			return
		}
		v, e := s.CreateWikiSpace(req.Context(), in.Name, in.Kind)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusCreated, v)
	})
	r.Put("/sessions/{id}/memory", func(w http.ResponseWriter, req *http.Request) {
		var in struct {
			SpaceID       string `json:"spaceId"`
			IncludeGlobal bool   `json:"includeGlobal"`
		}
		if json.NewDecoder(req.Body).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Wiki 空间选择请求无效"))
			return
		}
		v, e := s.SetWikiSessionSpace(req.Context(), chi.URLParam(req, "id"), in.SpaceID, in.IncludeGlobal)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusOK, v)
	})
	r.Get("/wiki/pages", func(w http.ResponseWriter, req *http.Request) {
		read(w, req, func() (any, error) {
			return s.ListWikiPages(req.Context(), req.URL.Query().Get("spaceId"), req.URL.Query().Get("includeWithdrawn") == "1")
		})
	})
	r.Post("/wiki/spaces/{spaceId}/pages", func(w http.ResponseWriter, req *http.Request) {
		var in WikiPageInput
		if json.NewDecoder(http.MaxBytesReader(w, req.Body, wikiPageBytes+4096)).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Wiki 页面请求无效"))
			return
		}
		v, e := s.CreateWikiPage(req.Context(), chi.URLParam(req, "spaceId"), in)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusCreated, v)
	})
	r.Get("/wiki/pages/{id}", func(w http.ResponseWriter, req *http.Request) {
		read(w, req, func() (any, error) { return s.GetWikiPage(req.Context(), chi.URLParam(req, "id")) })
	})
	r.Put("/wiki/pages/{id}", func(w http.ResponseWriter, req *http.Request) {
		var in WikiPageInput
		if json.NewDecoder(http.MaxBytesReader(w, req.Body, wikiPageBytes+4096)).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Wiki 页面请求无效"))
			return
		}
		v, e := s.UpdateWikiPage(req.Context(), chi.URLParam(req, "id"), in)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusOK, v)
	})
	r.Delete("/wiki/pages/{id}", func(w http.ResponseWriter, req *http.Request) {
		var in struct {
			ExpectedRevision int `json:"expectedRevision"`
		}
		if json.NewDecoder(req.Body).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Wiki 撤回请求无效"))
			return
		}
		v, e := s.WithdrawWikiPage(req.Context(), chi.URLParam(req, "id"), in.ExpectedRevision)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusOK, v)
	})
	r.Get("/wiki/search", func(w http.ResponseWriter, req *http.Request) {
		q := strings.TrimSpace(req.URL.Query().Get("q"))
		if q == "" {
			writeRuntimeError(w, shared.InvalidRequest("Wiki 搜索内容不能为空"))
			return
		}
		v, e := s.SearchWiki(req.Context(), req.URL.Query().Get("spaceId"), q, 8)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusOK, v)
	})
	r.Get("/wiki/check", func(w http.ResponseWriter, req *http.Request) {
		read(w, req, func() (any, error) { return s.WikiCheck(req.Context(), req.URL.Query().Get("spaceId")) })
	})
	r.Get("/wiki/export", func(w http.ResponseWriter, req *http.Request) {
		read(w, req, func() (any, error) { return s.ExportWiki(req.Context(), req.URL.Query().Get("spaceId")) })
	})
	r.Post("/wiki/import", func(w http.ResponseWriter, req *http.Request) {
		var in struct {
			SpaceID string            `json:"spaceId"`
			Files   map[string]string `json:"files"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, req.Body, 8*wikiPageBytes)).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Wiki 导入请求无效"))
			return
		}
		v, e := s.ImportWiki(req.Context(), in.SpaceID, in.Files)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusAccepted, v)
	})
	r.Get("/wiki/candidates", func(w http.ResponseWriter, req *http.Request) {
		read(w, req, func() (any, error) {
			return s.ListWikiCandidates(req.Context(), req.URL.Query().Get("spaceId"), req.URL.Query().Get("status"))
		})
	})
	r.Post("/wiki/candidates/{id}/decision", func(w http.ResponseWriter, req *http.Request) {
		var in struct {
			Decision string `json:"decision"`
		}
		if json.NewDecoder(req.Body).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Wiki 候选决定请求无效"))
			return
		}
		v, e := s.DecideWikiCandidate(req.Context(), chi.URLParam(req, "id"), in.Decision)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusOK, v)
	})
	r.Get("/wiki/embedding-profiles", func(w http.ResponseWriter, req *http.Request) {
		read(w, req, func() (any, error) { return s.ListEmbeddingProfiles(req.Context()) })
	})
	r.Post("/wiki/embedding-profiles", func(w http.ResponseWriter, req *http.Request) {
		var in EmbeddingProfileInput
		if json.NewDecoder(req.Body).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Embedding 配置请求无效"))
			return
		}
		v, e := s.CreateEmbeddingProfile(req.Context(), in)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusCreated, v)
	})
	r.Put("/wiki/embedding-profiles/{id}", func(w http.ResponseWriter, req *http.Request) {
		var in struct {
			ExpectedRevision int `json:"expectedRevision"`
			EmbeddingProfileInput
		}
		if json.NewDecoder(req.Body).Decode(&in) != nil {
			writeRuntimeError(w, shared.InvalidRequest("Embedding 配置请求无效"))
			return
		}
		v, e := s.UpdateEmbeddingProfile(req.Context(), chi.URLParam(req, "id"), in.ExpectedRevision, in.EmbeddingProfileInput)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		shared.SendJSON(w, http.StatusOK, v)
	})
}
