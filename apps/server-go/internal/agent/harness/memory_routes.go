package harness

import (
	"context"
	"net/http"
	"strconv"

	"elysian/server/internal/shared"
	"github.com/go-chi/chi/v5"
)

// 正式 memory API 与原 /wiki 入口共用同一份持久状态。
func registerMemoryRoutes(r chi.Router, s wikiRuntimeService) {
	respond := func(w http.ResponseWriter, status int, value any, err error) {
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, status, value)
	}
	if m, ok := s.(*Manager); ok {
		r.Get("/sessions/{id}/memory", func(w http.ResponseWriter, req *http.Request) {
			v, e := m.WikiSessionSelection(req.Context(), chi.URLParam(req, "id"))
			respond(w, 200, v, e)
		})
		r.Put("/memory-spaces/{spaceId}", func(w http.ResponseWriter, req *http.Request) {
			in, e := readAgentInput[struct {
				ExpectedRevision int    `json:"expectedRevision"`
				Name             string `json:"name"`
			}](w, req)
			if e != nil {
				writeRuntimeError(w, e)
				return
			}
			v, e := m.UpdateWikiSpace(req.Context(), chi.URLParam(req, "spaceId"), in.ExpectedRevision, in.Name)
			respond(w, 200, v, e)
		})
		r.Get("/memory-spaces/{spaceId}/pages/{id}/revisions/{revision}", func(w http.ResponseWriter, req *http.Request) {
			rev, e := strconv.Atoi(chi.URLParam(req, "revision"))
			if e != nil || rev < 1 {
				writeRuntimeError(w, bad("invalid-revision", "Wiki 修订必须是正整数"))
				return
			}
			v, e := m.WikiPageRevision(req.Context(), chi.URLParam(req, "spaceId"), chi.URLParam(req, "id"), rev)
			respond(w, 200, v, e)
		})
	}
	r.Get("/memory-spaces", func(w http.ResponseWriter, req *http.Request) {
		v, e := s.ListWikiSpaces(req.Context())
		respond(w, 200, v, e)
	})
	r.Post("/memory-spaces", func(w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[struct {
			Name string `json:"name"`
			Kind string `json:"kind"`
		}](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.CreateWikiSpace(req.Context(), in.Name, in.Kind)
		respond(w, 201, v, e)
	})
	r.Get("/memory-spaces/{spaceId}/pages", func(w http.ResponseWriter, req *http.Request) {
		if _, e := runtimeQuery(req, 50, "includeWithdrawn"); e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.ListWikiPages(req.Context(), chi.URLParam(req, "spaceId"), req.URL.Query().Get("includeWithdrawn") == "1")
		respond(w, 200, v, e)
	})
	r.Post("/memory-spaces/{spaceId}/pages", func(w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[WikiPageInput](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.CreateWikiPage(req.Context(), chi.URLParam(req, "spaceId"), in)
		respond(w, 201, v, e)
	})
	pageInSpace := func(ctx context.Context, req *http.Request) (WikiPage, error) {
		p, e := s.GetWikiPage(ctx, chi.URLParam(req, "id"))
		if e != nil {
			return p, e
		}
		if p.SpaceID != chi.URLParam(req, "spaceId") {
			return WikiPage{}, &Error{404, "wiki-page-not-found", "Wiki 页面不属于当前空间"}
		}
		return p, nil
	}
	r.Get("/memory-spaces/{spaceId}/pages/{id}", func(w http.ResponseWriter, req *http.Request) {
		v, e := pageInSpace(req.Context(), req)
		respond(w, 200, v, e)
	})
	r.Put("/memory-spaces/{spaceId}/pages/{id}", func(w http.ResponseWriter, req *http.Request) {
		if _, e := pageInSpace(req.Context(), req); e != nil {
			writeRuntimeError(w, e)
			return
		}
		in, e := readAgentInput[WikiPageInput](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.UpdateWikiPage(req.Context(), chi.URLParam(req, "id"), in)
		respond(w, 200, v, e)
	})
	r.Delete("/memory-spaces/{spaceId}/pages/{id}", func(w http.ResponseWriter, req *http.Request) {
		if _, e := pageInSpace(req.Context(), req); e != nil {
			writeRuntimeError(w, e)
			return
		}
		in, e := readAgentInput[struct {
			ExpectedRevision int `json:"expectedRevision"`
		}](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.WithdrawWikiPage(req.Context(), chi.URLParam(req, "id"), in.ExpectedRevision)
		respond(w, 200, v, e)
	})
	r.Get("/memory-spaces/{spaceId}/search", func(w http.ResponseWriter, req *http.Request) {
		q, e := runtimeQuery(req, 8, "q", "limit")
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.SearchWiki(req.Context(), chi.URLParam(req, "spaceId"), req.URL.Query().Get("q"), q.Limit)
		respond(w, 200, v, e)
	})
	r.Post("/memory-spaces/{spaceId}/imports", func(w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[struct {
			Files map[string]string `json:"files"`
		}](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.ImportWiki(req.Context(), chi.URLParam(req, "spaceId"), in.Files)
		respond(w, 202, v, e)
	})
	r.Get("/memory-spaces/{spaceId}/export", func(w http.ResponseWriter, req *http.Request) {
		v, e := s.ExportWiki(req.Context(), chi.URLParam(req, "spaceId"))
		respond(w, 200, v, e)
	})
	r.Get("/memory-spaces/{spaceId}/checks", func(w http.ResponseWriter, req *http.Request) {
		v, e := s.WikiCheck(req.Context(), chi.URLParam(req, "spaceId"))
		respond(w, 200, v, e)
	})
	r.Get("/memory-spaces/{spaceId}/indexes", func(w http.ResponseWriter, req *http.Request) {
		v, e := s.ListWikiIndexes(req.Context(), chi.URLParam(req, "spaceId"))
		respond(w, 200, v, e)
	})
	r.Post("/memory-spaces/{spaceId}/indexes", func(w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[WikiIndexInput](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.RebuildWikiIndex(req.Context(), chi.URLParam(req, "spaceId"), in)
		respond(w, 202, v, e)
	})
	r.Get("/memory-proposals", func(w http.ResponseWriter, req *http.Request) {
		if _, e := runtimeQuery(req, 50, "spaceId", "status"); e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.ListWikiCandidates(req.Context(), req.URL.Query().Get("spaceId"), req.URL.Query().Get("status"))
		respond(w, 200, v, e)
	})
	r.Post("/memory-proposals/{id}/decision", func(w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[struct {
			Decision string `json:"decision"`
		}](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.DecideWikiCandidate(req.Context(), chi.URLParam(req, "id"), in.Decision)
		respond(w, 200, v, e)
	})
	r.Get("/memory-extractions", func(w http.ResponseWriter, req *http.Request) {
		q, e := runtimeQuery(req, 50, "cursor", "limit")
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.ListWikiJobs(req.Context(), q.Cursor, q.Limit)
		respond(w, 200, v, e)
	})
	r.Post("/memory-extractions", func(w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[WikiExtractionInput](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, duplicate, e := s.CreateWikiExtraction(req.Context(), in)
		status := http.StatusAccepted
		if duplicate {
			status = http.StatusOK
		}
		respond(w, status, v, e)
	})
	r.Get("/memory-extractions/{id}", func(w http.ResponseWriter, req *http.Request) {
		v, e := s.GetWikiJob(req.Context(), chi.URLParam(req, "id"))
		respond(w, 200, v, e)
	})
	r.Get("/embedding-profiles", func(w http.ResponseWriter, req *http.Request) {
		v, e := s.ListEmbeddingProfiles(req.Context())
		respond(w, 200, v, e)
	})
	r.Get("/embedding-requests", func(w http.ResponseWriter, req *http.Request) {
		q, e := runtimeQuery(req, 50, "cursor", "limit")
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.ListEmbeddingRequests(req.Context(), q.Cursor, q.Limit)
		respond(w, 200, v, e)
	})
	r.Post("/embedding-profiles", func(w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[EmbeddingProfileInput](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.CreateEmbeddingProfile(req.Context(), in)
		respond(w, 201, v, e)
	})
	r.Put("/embedding-profiles/{id}", func(w http.ResponseWriter, req *http.Request) {
		in, e := readAgentInput[struct {
			ExpectedRevision int `json:"expectedRevision"`
			EmbeddingProfileInput
		}](w, req)
		if e != nil {
			writeRuntimeError(w, e)
			return
		}
		v, e := s.UpdateEmbeddingProfile(req.Context(), chi.URLParam(req, "id"), in.ExpectedRevision, in.EmbeddingProfileInput)
		respond(w, 200, v, e)
	})
}
