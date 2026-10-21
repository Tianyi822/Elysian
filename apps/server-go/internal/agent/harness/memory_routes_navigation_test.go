package harness

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestMemoryRoutesSelectionDirectoryReadAndRevisions(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	session, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	space, err := m.CreateWikiSpace(ctx, "业务知识", "business")
	if err != nil {
		t.Fatal(err)
	}
	other, err := m.CreateWikiSpace(ctx, "其他知识", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "first", Title: "分页正文", Markdown: "原始正文"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "second", Title: "下一页", Markdown: "其他内容"}); err != nil {
		t.Fatal(err)
	}
	handler := m.Router()
	response := runtimeRouteRequest(handler, http.MethodPut, "/sessions/"+session.ID+"/memory-space", `{"spaceId":"`+space.ID+`","includeGlobal":true}`)
	var selected WikiSpaceSelection
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &selected) != nil || selected.SpaceID != space.ID || !selected.IncludeGlobal {
		t.Fatalf("空间选择没有返回持久选择：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, http.MethodGet, "/sessions/"+session.ID+"/memory", "")
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &selected) != nil || selected.SpaceID != space.ID {
		t.Fatalf("空间选择回读失败：%d %s", response.Code, response.Body.String())
	}
	base := "/memory-spaces/" + space.ID
	response = runtimeRouteRequest(handler, http.MethodGet, base+"/directory?limit=1", "")
	var directory WikiDirectory
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &directory) != nil || len(directory.Items) != 1 || directory.Items[0].ID != page.ID || directory.NextCursor == "" || strings.Contains(response.Body.String(), `"markdown"`) || strings.Contains(response.Body.String(), `"evidence"`) {
		t.Fatalf("目录没有分页摘要：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, http.MethodGet, base+"/directory?limit=1&cursor="+directory.NextCursor, "")
	directory = WikiDirectory{}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &directory) != nil || len(directory.Items) != 1 || directory.Items[0].Slug != "second" || directory.NextCursor != "" {
		t.Fatalf("目录下一页错误：%d %s", response.Code, response.Body.String())
	}
	pagePath := base + "/pages/" + page.ID
	response = runtimeRouteRequest(handler, http.MethodGet, pagePath+"/read?offset=0&limit=6", "")
	var read WikiPageRead
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &read) != nil || read.Markdown != "原始" || read.NextOffset == nil || *read.NextOffset != 6 || read.TotalBytes != 12 {
		t.Fatalf("UTF-8 分页首段错误：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(handler, http.MethodGet, pagePath+"/read?offset=6&limit=6", "")
	read = WikiPageRead{}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &read) != nil || read.Markdown != "正文" || read.NextOffset != nil {
		t.Fatalf("UTF-8 分页续段错误：%d %s", response.Code, response.Body.String())
	}
	if _, err = m.UpdateWikiPage(ctx, page.ID, WikiPageInput{ExpectedRevision: page.Revision, Slug: page.Slug, Title: page.Title, Markdown: "修订正文"}); err != nil {
		t.Fatal(err)
	}
	response = runtimeRouteRequest(handler, http.MethodGet, pagePath+"/revisions", "")
	var revisions []WikiPage
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &revisions) != nil || len(revisions) != 2 || revisions[0].Revision != 2 || revisions[1].Markdown != "原始正文" {
		t.Fatalf("修订历史缺少固定正文：%d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{pagePath + "/revisions/1", "/memory-pages/" + page.ID + "/revisions/1"} {
		response = runtimeRouteRequest(handler, http.MethodGet, path, "")
		var revision WikiPage
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &revision) != nil || revision.Revision != 1 || revision.Markdown != "原始正文" {
			t.Fatalf("固定修订读取错误 %s：%d %s", path, response.Code, response.Body.String())
		}
	}
	for _, suffix := range []string{"/read", "/revisions", "/revisions/1"} {
		response = runtimeRouteRequest(handler, http.MethodGet, "/memory-spaces/"+other.ID+"/pages/"+page.ID+suffix, "")
		if response.Code != http.StatusNotFound {
			t.Fatalf("跨空间页面读取未拒绝：%d %s", response.Code, response.Body.String())
		}
	}
	response = runtimeRouteRequest(handler, http.MethodPut, "/sessions/"+session.ID+"/memory-space", `{"spaceId":"","includeGlobal":false}`)
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &selected) != nil || selected.SpaceID != "" || selected.IncludeGlobal {
		t.Fatalf("明确禁用记忆没有保留：%d %s", response.Code, response.Body.String())
	}
}

func TestMemoryRoutesRejectAmbiguousParametersAndBodies(t *testing.T) {
	m, profile := sessionAPIManager(t)
	ctx := context.Background()
	session, err := m.CreateSession(ctx, CreateSessionInput{ModelProfileID: profile.ID, ModelRevision: profile.Revision})
	if err != nil {
		t.Fatal(err)
	}
	space, err := m.CreateWikiSpace(ctx, "严格参数", "business")
	if err != nil {
		t.Fatal(err)
	}
	page, err := m.CreateWikiPage(ctx, space.ID, WikiPageInput{Slug: "unicode", Title: "多字节", Markdown: "中文"})
	if err != nil {
		t.Fatal(err)
	}
	base := "/memory-spaces/" + space.ID
	pagePath := base + "/pages/" + page.ID
	selectionPath := "/sessions/" + session.ID + "/memory-space"
	for _, test := range []struct{ method, path, body string }{
		{http.MethodGet, base + "/directory?limit=01", ""},
		{http.MethodGet, base + "/directory?limit=%2B1", ""},
		{http.MethodGet, base + "/directory?limit=0", ""},
		{http.MethodGet, base + "/directory?limit=201", ""},
		{http.MethodGet, base + "/directory?limit=1&limit=2", ""},
		{http.MethodGet, base + "/directory?limit=", ""},
		{http.MethodGet, base + "/directory?cursor=01", ""},
		{http.MethodGet, base + "/directory?unknown=1", ""},
		{http.MethodGet, pagePath + "/read?offset=-1", ""},
		{http.MethodGet, pagePath + "/read?offset=00", ""},
		{http.MethodGet, pagePath + "/read?offset=1", ""},
		{http.MethodGet, pagePath + "/read?offset=7", ""},
		{http.MethodGet, pagePath + "/read?offset=999999999999999999999999999", ""},
		{http.MethodGet, pagePath + "/read?limit=1", ""},
		{http.MethodGet, pagePath + "/read?limit=4097", ""},
		{http.MethodGet, pagePath + "/read?offset=0&offset=0", ""},
		{http.MethodGet, pagePath + "/read?cursor=0", ""},
		{http.MethodGet, pagePath + "/revisions?limit=1", ""},
		{http.MethodGet, pagePath + "/revisions/01", ""},
		{http.MethodGet, pagePath + "/revisions/0", ""},
		{http.MethodGet, "/memory-pages/" + page.ID + "/revisions/01", ""},
		{http.MethodGet, "/memory-pages/" + page.ID + "/revisions/1?extra=1", ""},
		{http.MethodPut, selectionPath, `{"spaceId":"","includeGlobal":false,"extra":true}`},
		{http.MethodPut, selectionPath, `{"spaceId":"","spaceId":"another"}`},
		{http.MethodPut, selectionPath + "?extra=1", `{"spaceId":""}`},
		{http.MethodPost, base + "/sources", `{"requestId":"source-unknown","unknown":true}`},
		{http.MethodPost, base + "/sources", `{"requestId":"first","requestId":"second"}`},
		{http.MethodPost, base + "/sources?extra=1", `{}`},
	} {
		t.Run(test.method+" "+test.path+" "+test.body, func(t *testing.T) {
			response := runtimeRouteRequest(m.Router(), test.method, test.path, test.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("歧义参数或未声明字段未拒绝：%d %s", response.Code, response.Body.String())
			}
		})
	}
	if _, _, err = m.CreateTask(ctx, session.ID, AgentInput{RequestID: "busy-memory-selection", Content: "运行中"}); err != nil {
		t.Fatal(err)
	}
	response := runtimeRouteRequest(m.Router(), http.MethodPut, selectionPath, `{"spaceId":"","includeGlobal":false}`)
	if response.Code != http.StatusConflict {
		t.Fatalf("忙碌会话仍可改空间：%d %s", response.Code, response.Body.String())
	}
}

func TestMemoryRoutesSourceSubmissionIsIdempotent(t *testing.T) {
	m, profile := sessionAPIManager(t)
	space, err := m.CreateWikiSpace(context.Background(), "原始资料", "business")
	if err != nil {
		t.Fatal(err)
	}
	in := WikiSourceInput{RequestID: "source-route-request", Title: "主机约定", Filename: "hosts.md", Text: "每台主机使用统一时区。", ModelProfileID: profile.ID, ModelProfileRevision: profile.Revision}
	body, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	path := "/memory-spaces/" + space.ID + "/sources"
	response := runtimeRouteRequest(m.Router(), http.MethodPost, path, string(body))
	var first WikiSourceResult
	if response.Code != http.StatusAccepted || json.Unmarshal(response.Body.Bytes(), &first) != nil || first.Source.Kind != "sources" || first.Source.Markdown != in.Text || first.Job.Status != StateQueued || first.Job.Strategy != wikiNavigationStrategy {
		t.Fatalf("原始资料没有作为异步编译入队：%d %s", response.Code, response.Body.String())
	}
	response = runtimeRouteRequest(m.Router(), http.MethodPost, path, string(body))
	var repeated WikiSourceResult
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &repeated) != nil || repeated.Source.ID != first.Source.ID || repeated.Job.ID != first.Job.ID {
		t.Fatalf("同请求重试重复导入来源：%d %s", response.Code, response.Body.String())
	}
	in.Text = "被同编号替换的资料"
	body, err = json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	response = runtimeRouteRequest(m.Router(), http.MethodPost, path, string(body))
	if response.Code != http.StatusConflict {
		t.Fatalf("同编号接受了不同资料：%d %s", response.Code, response.Body.String())
	}
	pages, err := m.ListWikiPages(context.Background(), space.ID, false)
	if err != nil || len(pages) != 1 || pages[0].ID != first.Source.ID {
		t.Fatalf("重试留下重复来源：%+v %v", pages, err)
	}
}
