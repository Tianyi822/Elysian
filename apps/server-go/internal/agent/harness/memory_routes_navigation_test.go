package harness

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestWikiBrowserRoutesPreserveEditingAndFixedReferences(t *testing.T) {
	m, _ := sessionAPIManager(t)
	ctx := context.Background()
	space, err := m.CreateWikiSpace(ctx, "既有空间", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "guide", Title: "运维", Markdown: "原文"})
	if err != nil {
		t.Fatal(err)
	}
	handler := m.Router()
	base := "/memory-spaces/" + space.ID + "/pages/" + page.ID
	for _, path := range []string{"/memory-spaces", "/memory-spaces/" + space.ID + "/pages", base} {
		response := runtimeRouteRequest(handler, http.MethodGet, path, "")
		if response.Code != http.StatusOK {
			t.Fatalf("浏览失败 %s: %d %s", path, response.Code, response.Body.String())
		}
	}
	input, _ := json.Marshal(WikiPageInput{ExpectedRevision: 1, Slug: page.Slug, Title: page.Title, Markdown: "人工修改", Maintenance: "automatic"})
	response := runtimeRouteRequest(handler, http.MethodPut, base, string(input))
	var updated WikiPage
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &updated) != nil || updated.Revision != 2 || updated.Maintenance != "manual" {
		t.Fatalf("人工编辑未追加修订: %d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, http.MethodPut, base, string(input))
	if response.Code != http.StatusConflict {
		t.Fatalf("过期修订未拒绝: %d", response.Code)
	}
	for _, path := range []string{base + "/revisions/1", "/memory-pages/" + page.ID + "/revisions/1"} {
		response = runtimeRouteRequest(handler, http.MethodGet, path, "")
		var revision WikiPage
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &revision) != nil || revision.Markdown != "原文" || revision.Digest != page.Digest {
			t.Fatalf("历史引用改变: %d %s", response.Code, response.Body.String())
		}
	}
	for _, suffix := range []string{"", "/revisions/1"} {
		response = runtimeRouteRequest(handler, http.MethodGet, "/memory-spaces/other/pages/"+page.ID+suffix, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("跨空间未拒绝: %d", response.Code)
		}
	}
	for _, path := range []string{base + "/revisions/01", base + "/revisions/0", base + "/revisions/1?extra=1"} {
		if r := runtimeRouteRequest(handler, http.MethodGet, path, ""); r.Code != http.StatusBadRequest {
			t.Fatalf("修订参数未严格验证: %s %d", path, r.Code)
		}
	}
}

func TestRetiredMemoryAndAuthorizationRoutesReturnNotFound(t *testing.T) {
	m, _ := sessionAPIManager(t)
	for _, test := range []struct{ method, path string }{
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
