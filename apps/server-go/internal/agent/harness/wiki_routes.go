package harness

import (
	"context"
	"github.com/go-chi/chi/v5"
	"net/http"
)

type wikiRuntimeService interface {
	ListWikiSpaces(context.Context) ([]WikiSpace, error)
	ListWikiPages(context.Context, string, bool) ([]WikiPage, error)
	GetWikiPage(context.Context, string) (WikiPage, error)
	UpdateWikiPage(context.Context, string, WikiPageInput) (WikiPage, error)
}

func registerWikiRoutes(r chi.Router, service runtimeService) {
	s, ok := service.(wikiRuntimeService)
	if !ok {
		return
	}
	registerMemoryRoutes(r, s)
	r.Handle("/wiki/*", http.NotFoundHandler())
	r.Put("/sessions/{id}/memory", http.NotFound)
}
