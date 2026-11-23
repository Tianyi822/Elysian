package harness

import (
	"net/http"
	"testing"
)

func TestRetiredMemoryAndAuthorizationRoutesReturnNotFound(t *testing.T) {
	m, _ := sessionAPIManager(t)
	for _, test := range []struct{ method, path string }{
		{"GET", "/memory-spaces"}, {"GET", "/memory-spaces/s/pages"},
		{"GET", "/memory-spaces/s/pages/p"}, {"PUT", "/memory-spaces/s/pages/p"},
		{"GET", "/memory-spaces/s/pages/p/revisions/1"}, {"GET", "/memory-pages/p/revisions/1"},
		{"POST", "/memory-spaces"}, {"PUT", "/memory-spaces/s"},
		{"POST", "/memory-spaces/s/pages"}, {"DELETE", "/memory-spaces/s/pages/p"},
		{"GET", "/memory-spaces/s/pages/p/revisions"}, {"GET", "/memory-spaces/s/pages/p/read"},
		{"GET", "/memory-spaces/s/directory"}, {"GET", "/memory-spaces/s/search"},
		{"POST", "/memory-spaces/s/sources"}, {"POST", "/memory-spaces/s/imports"},
		{"GET", "/memory-spaces/s/export"}, {"GET", "/memory-spaces/s/checks"},
		{"GET", "/memory-spaces/s/indexes"}, {"POST", "/memory-spaces/s/indexes"},
		{"GET", "/memory-proposals"}, {"POST", "/memory-proposals/p/decision"},
		{"GET", "/memory-extractions"}, {"POST", "/memory-extractions"}, {"GET", "/memory-extractions/j"},
		{"GET", "/embedding-profiles"}, {"POST", "/embedding-profiles"}, {"PUT", "/embedding-profiles/p"}, {"GET", "/embedding-requests"},
		{"GET", "/sessions/s/memory"}, {"PUT", "/sessions/s/memory"}, {"PUT", "/sessions/s/memory-space"},
		{"GET", "/sessions/s/authorizations"}, {"DELETE", "/sessions/s/authorizations/a"},
		{"GET", "/wiki/spaces"}, {"POST", "/wiki/spaces"}, {"GET", "/wiki/pages/p"}, {"PUT", "/wiki/pages/p"}, {"POST", "/wiki/import"},
	} {
		t.Run(test.method+test.path, func(t *testing.T) {
			r := runtimeRouteRequest(m.Router(), test.method, test.path, `{}`)
			if r.Code != http.StatusNotFound {
				t.Fatalf("退役接口仍开放: %d %s", r.Code, r.Body.String())
			}
		})
	}
}
