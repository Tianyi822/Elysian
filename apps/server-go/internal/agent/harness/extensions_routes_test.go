package harness

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"elysian/server/internal/agent/mcp"
	"github.com/go-chi/chi/v5"
)

func extensionRouter(e *Extensions) http.Handler {
	r := chi.NewRouter()
	registerExtensionRoutes(r, &Manager{deps: Deps{Catalog: e}})
	return r
}

func TestExtensionProbeRespectsPersistentRevocationsAfterRestart(t *testing.T) {
	f := newExtensionFixture(t)
	m, _, _ := agentManager(t, operationClient(), func(d *Deps) { d.Catalog = f.extensions })
	if err := m.Revoke(context.Background(), "mcp", f.server.ID, 1, "禁止继续连接"); err != nil {
		t.Fatal(err)
	}
	m = reopenOperationManager(t, m)
	response := runtimeRouteRequest(m.Router(), http.MethodPost, "/mcp-servers/"+f.server.ID+"/probe", `{"revision":1}`)
	if response.Code != 400 || !strings.Contains(response.Body.String(), "capability-revoked") {
		t.Fatalf("探测绕过持久撤销：%d %s", response.Code, response.Body.String())
	}
	server := f.server
	server.Stdio = &mcp.ContainerSpec{GrantID: "revoked-grant", GrantRevision: 2}
	server.ID = "different-server"
	if err := m.Revoke(context.Background(), "grant", "revoked-grant", 0, "撤销全部修订"); err != nil {
		t.Fatal(err)
	}
	runtimeErrorCode(t, m.checkProbe(context.Background(), server), "capability-revoked")
}

func TestExtensionMCPRoutesProtectCredentialsAndImmutableRevisions(t *testing.T) {
	store, err := mcp.Open(filepath.Join(t.TempDir(), "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	router := extensionRouter(&Extensions{Servers: store})
	body := `{"name":"测试 MCP","transport":"streamable-http","url":"https://example.test/mcp","active":true,"revoked":false,"credential":"secret-route-token"}`
	created := runtimeRouteRequest(router, http.MethodPost, "/mcp-servers", body)
	if created.Code != 201 || strings.Contains(created.Body.String(), "secret-route-token") {
		t.Fatalf("配置创建泄露凭据或失败：%d %s", created.Code, created.Body.String())
	}
	var first mcp.Server
	if err := json.Unmarshal(created.Body.Bytes(), &first); err != nil || !first.HasCredential || first.Revision != 1 {
		t.Fatalf("公开投影无效：%+v %v", first, err)
	}
	updated := runtimeRouteRequest(router, http.MethodPut, "/mcp-servers/"+first.ID, `{"expectedRevision":1,"name":"已更新","transport":"streamable-http","url":"https://example.test/mcp","active":true,"revoked":false}`)
	if updated.Code != 200 {
		t.Fatalf("更新失败：%d %s", updated.Code, updated.Body.String())
	}
	conflict := runtimeRouteRequest(router, http.MethodPut, "/mcp-servers/"+first.ID, `{"expectedRevision":1,"name":"冲突","transport":"streamable-http","url":"https://example.test/mcp","active":true,"revoked":false}`)
	if conflict.Code != 409 {
		t.Fatalf("旧修订更新未拒绝：%d", conflict.Code)
	}
	old := runtimeRouteRequest(router, http.MethodGet, "/mcp-servers/"+first.ID+"?revision=1", "")
	if old.Code != 200 || !strings.Contains(old.Body.String(), "测试 MCP") || strings.Contains(old.Body.String(), "secret-route-token") {
		t.Fatalf("历史修订投影错误：%d %s", old.Code, old.Body.String())
	}
	for _, invalid := range []string{`{"name":"一","name":"二"}`, `{"name":"测试","extra":true}`, `null`} {
		response := runtimeRouteRequest(router, http.MethodPost, "/mcp-servers", invalid)
		if response.Code != 400 {
			t.Fatalf("非法配置被接收：%s %d", invalid, response.Code)
		}
	}
	if len(store.List()) != 1 {
		t.Fatal("非法请求产生了新配置")
	}
}

func TestExtensionCatalogRoutesExposeDeterministicSelectionAliases(t *testing.T) {
	store, err := mcp.Open(filepath.Join(t.TempDir(), "mcp.json"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := store.Create(mcp.Input{Name: "测试 MCP", Transport: "streamable-http", URL: "https://example.test/mcp", Active: true})
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := store.SaveCatalog(server.ID, server.Revision, mcp.Catalog{ProtocolVersion: mcp.ProtocolVersion, Capabilities: mcp.Capabilities{Tools: true, Resources: true, Prompts: true}, Tools: []mcp.Tool{{Name: "write", InputSchema: json.RawMessage(`{"type":"object"}`)}}, Resources: []mcp.Resource{{URI: "test://status", Name: "状态"}}, Prompts: []mcp.Prompt{{Name: "diagnose"}}})
	if err != nil {
		t.Fatal(err)
	}
	router := extensionRouter(&Extensions{Servers: store})
	response := runtimeRouteRequest(router, http.MethodGet, "/mcp-servers/"+server.ID+"/catalog?revision=1", "")
	var got mcpCatalogProjection
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &got) != nil {
		t.Fatalf("目录响应失败：%d %s", response.Code, response.Body.String())
	}
	if !reflect.DeepEqual(got, publicMCPCatalog(server.ID, catalog)) {
		t.Fatalf("目录投影发生变化：%+v", got)
	}
	if got.ModelAliases["write"] != capabilityAlias("mcp", server.ID, "write") || got.ResourceAliases["test://status"] != capabilityAlias("resource", server.ID, "test://status") || got.PromptAliases["diagnose"] != capabilityAlias("prompt", server.ID, "diagnose") {
		t.Fatal("目录名称不能映射到环境选择")
	}
	for _, query := range []string{"", "?revision=0", "?revision=01", "?revision=1&revision=2", "?revision=1&unknown=true"} {
		response = runtimeRouteRequest(router, http.MethodGet, "/mcp-servers/"+server.ID+"/catalog"+query, "")
		if response.Code != 400 {
			t.Fatalf("非法目录查询被接收：%s %d", query, response.Code)
		}
	}
}

func TestExtensionRoutesUnavailableAndExplicitToggle(t *testing.T) {
	for _, path := range []string{"/skills", "/mcp-servers", "/execution-profiles", "/grants"} {
		response := runtimeRouteRequest(extensionRouter(&Extensions{}), http.MethodGet, path, "")
		if response.Code != 503 {
			t.Fatalf("未装配能力未正确报错：%s %d", path, response.Code)
		}
	}
	for _, body := range []string{`{"expectedRevision":1}`, `{"expectedRevision":1,"enabled":null}`, `{"enabled":false}`, `{"expectedRevision":0,"enabled":true}`} {
		req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if _, err := readEnabledInput(httptest.NewRecorder(), req); err == nil {
			t.Fatalf("不完整启停输入被接收：%s", body)
		}
	}
	req := httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{"expectedRevision":1,"enabled":false}`))
	req.Header.Set("Content-Type", "application/json")
	in, err := readEnabledInput(httptest.NewRecorder(), req)
	if err != nil || in.Enabled == nil || *in.Enabled {
		t.Fatalf("显式停用被拒绝：%+v %v", in, err)
	}
}

func skillMultipartRequest(t *testing.T, metadata string, extra bool) *http.Request {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormField("metadata")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.WriteString(part, metadata); err != nil {
		t.Fatal(err)
	}
	part, err = writer.CreateFormFile("archive", "skill.zip")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.WriteString(part, "zip-bytes"); err != nil {
		t.Fatal(err)
	}
	if extra {
		part, err = writer.CreateFormField("unexpected")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = io.WriteString(part, "extra"); err != nil {
			t.Fatal(err)
		}
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "/skills/imports", bytes.NewReader(body.Bytes()))
	req.Header.Set("Content-Type", writer.FormDataContentType())
	return req
}

func TestSkillImportMultipartRejectsDuplicateMetadataAndTrailingParts(t *testing.T) {
	metadata := `{"requestId":"import-1","source":{"kind":"zip"},"enabled":true}`
	in, archive, err := readSkillImport(httptest.NewRecorder(), skillMultipartRequest(t, metadata, false))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(archive)
	if err != nil || string(raw) != "zip-bytes" || in.RequestID != "import-1" {
		t.Fatalf("上传解析错误：%+v %s %v", in, raw, err)
	}
	_, archive, err = readSkillImport(httptest.NewRecorder(), skillMultipartRequest(t, metadata, true))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.ReadAll(archive); err == nil {
		t.Fatal("多余 multipart 内容在被接收前未拒绝")
	}
	for _, invalid := range []string{`{"requestId":"a","requestId":"b","source":{"kind":"zip"}}`, `{"source":{"kind":"git"}}`, `{"source":{"kind":"zip"},"unknown":true}`} {
		if _, _, err = readSkillImport(httptest.NewRecorder(), skillMultipartRequest(t, invalid, false)); err == nil {
			t.Fatalf("非法元数据被接收：%s", invalid)
		}
	}
}
