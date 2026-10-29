package harness

import (
	"context"
	"elysian/server/internal/shared"
	"github.com/go-chi/chi/v5"
	"net/http"
	"net/url"
	"strconv"
)

// Wiki 仅开放浏览、人工编辑和历史引用，其他记忆管理接口退役。
func registerMemoryRoutes(r chi.Router, s wikiRuntimeService) {
	respond := func(w http.ResponseWriter, status int, value any, err error) {
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		shared.SendJSON(w, status, value)
	}
	pageInSpace := func(ctx context.Context, req *http.Request) (WikiPage, error) {
		p, err := s.GetWikiPage(ctx, chi.URLParam(req, "id"))
		if err != nil {
			return p, err
		}
		if p.SpaceID != chi.URLParam(req, "spaceId") {
			return WikiPage{}, &Error{404, "wiki-page-not-found", "Wiki 页面不属于当前空间"}
		}
		return p, nil
	}
	r.Get("/memory-spaces", func(w http.ResponseWriter, req *http.Request) {
		value, err := s.ListWikiSpaces(req.Context())
		respond(w, 200, value, err)
	})
	r.Get("/memory-spaces/{spaceId}/pages", func(w http.ResponseWriter, req *http.Request) {
		if _, err := runtimeQuery(req, 50, "includeWithdrawn"); err != nil {
			writeRuntimeError(w, err)
			return
		}
		value, err := s.ListWikiPages(req.Context(), chi.URLParam(req, "spaceId"), req.URL.Query().Get("includeWithdrawn") == "1")
		respond(w, 200, value, err)
	})
	r.Get("/memory-spaces/{spaceId}/pages/{id}", func(w http.ResponseWriter, req *http.Request) {
		value, err := pageInSpace(req.Context(), req)
		respond(w, 200, value, err)
	})
	r.Put("/memory-spaces/{spaceId}/pages/{id}", func(w http.ResponseWriter, req *http.Request) {
		if _, err := pageInSpace(req.Context(), req); err != nil {
			writeRuntimeError(w, err)
			return
		}
		input, err := readAgentInput[WikiPageInput](w, req)
		if err != nil {
			writeRuntimeError(w, err)
			return
		}
		// 浏览页保存固定为人工维护。
		input.Maintenance = "manual"
		value, err := s.UpdateWikiPage(req.Context(), chi.URLParam(req, "id"), input)
		respond(w, 200, value, err)
	})
	if m, ok := s.(*Manager); ok {
		revision := func(w http.ResponseWriter, req *http.Request) {
			if _, err := memoryRouteQuery(req); err != nil {
				writeRuntimeError(w, err)
				return
			}
			rev, err := memoryRouteInt(chi.URLParam(req, "revision"), 0, 1, int(^uint(0)>>1))
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			page, err := s.GetWikiPage(req.Context(), chi.URLParam(req, "id"))
			if err != nil {
				writeRuntimeError(w, err)
				return
			}
			if sid := chi.URLParam(req, "spaceId"); sid != "" && sid != page.SpaceID {
				http.NotFound(w, req)
				return
			}
			value, err := m.WikiPageRevision(req.Context(), page.SpaceID, page.ID, rev)
			respond(w, 200, value, err)
		}
		r.Get("/memory-pages/{id}/revisions/{revision}", revision)
		r.Get("/memory-spaces/{spaceId}/pages/{id}/revisions/{revision}", revision)
	}
	r.Get("/sessions/{id}/memory", http.NotFound)
	r.Put("/sessions/{id}/memory-space", http.NotFound)
	r.Get("/memory-spaces/{spaceId}/directory", http.NotFound)
	r.Get("/memory-spaces/{spaceId}/pages/{id}/revisions", http.NotFound)
	r.Get("/memory-spaces/{spaceId}/pages/{id}/read", http.NotFound)
	r.Post("/memory-spaces/{spaceId}/sources", http.NotFound)
	r.Put("/memory-spaces/{spaceId}", http.NotFound)
	r.Post("/memory-spaces", http.NotFound)
	r.Post("/memory-spaces/{spaceId}/pages", http.NotFound)
	r.Delete("/memory-spaces/{spaceId}/pages/{id}", http.NotFound)
	r.Get("/memory-spaces/{spaceId}/search", http.NotFound)
	r.Post("/memory-spaces/{spaceId}/imports", http.NotFound)
	r.Get("/memory-spaces/{spaceId}/export", http.NotFound)
	r.Get("/memory-spaces/{spaceId}/checks", http.NotFound)
	r.Get("/memory-spaces/{spaceId}/indexes", http.NotFound)
	r.Post("/memory-spaces/{spaceId}/indexes", http.NotFound)
	r.Get("/memory-proposals", http.NotFound)
	r.Post("/memory-proposals/{id}/decision", http.NotFound)
	r.Get("/memory-extractions", http.NotFound)
	r.Post("/memory-extractions", http.NotFound)
	r.Get("/memory-extractions/{id}", http.NotFound)
	r.Get("/embedding-profiles", http.NotFound)
	r.Get("/embedding-requests", http.NotFound)
	r.Post("/embedding-profiles", http.NotFound)
	r.Put("/embedding-profiles/{id}", http.NotFound)
}

// 新记忆入口只接收显式声明且单值的参数，避免宽松 URL 解析悄悄丢弃歧义。
func memoryRouteQuery(req *http.Request, allowed ...string) (url.Values, error) {
	values, err := url.ParseQuery(req.URL.RawQuery)
	if err != nil {
		return nil, shared.InvalidRequest("查询参数编码无效")
	}
	for key, entries := range values {
		known := false
		for _, name := range allowed {
			known = known || key == name
		}
		if !known || len(entries) != 1 || entries[0] == "" || len(entries[0]) > 256 {
			return nil, shared.InvalidRequest("查询参数无效或重复")
		}
	}
	return values, nil
}

func memoryRouteInt(raw string, fallback, minimum, maximum int) (int, error) {
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || strconv.Itoa(value) != raw || value < minimum || value > maximum {
		return 0, shared.InvalidRequest("记忆分页参数或修订必须是范围内的规范整数")
	}
	return value, nil
}
