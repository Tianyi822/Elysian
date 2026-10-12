package model

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCatalogProtocolsAndPublicMetadata(t *testing.T) {
	for _, tc := range []struct{ provider, format, base, path, header string }{
		{ProviderDeepSeek, FormatChatCompletions, "", "/models", "Authorization"},
		{ProviderDeepSeek, FormatResponses, "/v1", "/v1/models", "Authorization"},
		{ProviderDeepSeek, FormatAnthropicMessages, "/anthropic", "/models", "Authorization"},
		{ProviderDeepSeek, FormatAnthropicMessages, "/anthropic/v1", "/models", "Authorization"},
		{ProviderOpenAICompatible, FormatResponses, "/v1", "/v1/models", "Authorization"},
		{ProviderOpenAICompatible, FormatAnthropicMessages, "", "/v1/models", "x-api-key"},
		{ProviderOpenAICompatible, FormatAnthropicMessages, "/v1", "/v1/models", "x-api-key"},
	} {
		t.Run(tc.provider+tc.format+tc.base, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				want := "fake-key"
				if tc.header == "Authorization" {
					want = "Bearer " + want
				}
				if r.Method != "GET" || r.URL.Path != tc.path || r.Header.Get(tc.header) != want || r.Header.Get("Cookie") != "" {
					t.Errorf("目录请求协议或鉴权无效：%s %s", r.Method, r.URL.Path)
				}
				if tc.header == "x-api-key" && r.Header.Get("anthropic-version") != "2023-06-01" {
					t.Error("缺少 Anthropic 版本")
				}
				io.WriteString(w, `{"object":"list","data":[{"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash","context_window":1048576,"max_output_tokens":393216,"credential":"不得回显","input_modalities":["text","image"]},{"id":"generic-model","display_name":"模型名称"}]}`)
			}))
			defer server.Close()
			profile := testProfile(server.URL + tc.base)
			profile.Provider, profile.APIFormat, profile.Credential = tc.provider, tc.format, "fake-key"
			rows, err := NewCatalogClient(server.Client()).ListModels(context.Background(), profile)
			if err != nil || len(rows) != 2 || rows[0].Model != "deepseek-flash" || *rows[0].ContextTokens != 1048576 || *rows[0].OutputTokens != 393216 || rows[1].Name != "模型名称" || rows[1].ContextTokens != nil || calls.Load() != 1 {
				t.Fatalf("目录读取失败：%+v %v", rows, err)
			}
		})
	}
}

func TestCatalogRejectsMalformedOversizedAndSensitiveFailures(t *testing.T) {
	for _, tc := range []struct {
		body, code string
		status     int
	}{
		{`{"data":[{"id":"a","id":"b"}]}`, "invalid-model-catalog", 200},
		{`{"data":[{"id":"a"},{"id":"a"}]}`, "invalid-model-catalog", 200},
		{`{"data":null}`, "invalid-model-catalog", 200},
		{`{"data":[],"has_more":true}`, "invalid-model-catalog", 200},
		{`{"data":[{"id":"a","context_window":0}]}`, "invalid-model-catalog", 200},
		{`{"data":[{"id":"a","max_output_tokens":2000001}]}`, "invalid-model-catalog", 200},
		{strings.Repeat("x", MaxResponseBytes+1), "model-response-too-large", 200},
		{"secret-in-upstream-error", "model-auth-failed", 401},
		{"secret-in-upstream-error", "model-rate-limited", 429},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); io.WriteString(w, tc.body) }))
		_, err := NewCatalogClient(server.Client()).ListModels(context.Background(), testProfile(server.URL))
		server.Close()
		requireCode(t, err, tc.code)
		if strings.Contains(err.Error(), "secret-in-upstream-error") {
			t.Fatal("上游正文泄漏")
		}
	}
}

func TestCatalogEmptyRedirectAndCancellation(t *testing.T) {
	var leaked atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { leaked.Add(1) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	profile := testProfile(server.URL)
	profile.Credential = "fake-key"
	_, err := NewCatalogClient(server.Client()).ListModels(context.Background(), profile)
	requireCode(t, err, "model-redirect-refused")
	server.Close()
	if leaked.Load() != 0 {
		t.Fatal("跳转携带了凭据")
	}
	empty := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"data":[]}`) }))
	defer empty.Close()
	rows, err := NewCatalogClient(empty.Client()).ListModels(context.Background(), testProfile(empty.URL))
	if err != nil || rows == nil || len(rows) != 0 {
		t.Fatal("空目录应返回空数组")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = NewCatalogClient(empty.Client()).ListModels(ctx, testProfile(empty.URL))
	requireCode(t, err, "model-cancelled")
	deadline, stop := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer stop()
	_, err = NewCatalogClient(empty.Client()).ListModels(deadline, testProfile(empty.URL))
	requireCode(t, err, "model-timeout")
}

func TestDiscoveryCredentialStatesRevisionAndChangedAddress(t *testing.T) {
	store, err := Open(filepath.Join(t.TempDir(), "models.json"))
	if err != nil {
		t.Fatal(err)
	}
	input := serviceInput()
	key := "saved-fake-key"
	input.Credential = &key
	service, err := store.CreateService(input)
	if err != nil {
		t.Fatal(err)
	}
	writes := 0
	store.write = func(string, []Profile) (bool, error) { writes++; return true, nil }
	discovery := DiscoveryInput{ServiceID: service.ID, ExpectedRevision: service.Revision, Provider: input.Provider, APIFormat: input.APIFormat, BaseURL: input.BaseURL}
	p, err := store.DiscoveryProfile(discovery)
	if err != nil || p.Credential != key {
		t.Fatal("省略凭据未沿用")
	}
	discovery.BaseURL = "https://changed.example.com"
	_, err = store.DiscoveryProfile(discovery)
	requireCode(t, err, "discovery-credential-required")
	replacement := "replacement-fake-key"
	discovery.Credential = &replacement
	p, err = store.DiscoveryProfile(discovery)
	if err != nil || p.Credential != replacement {
		t.Fatal("显式替换失败")
	}
	empty := ""
	discovery.Credential = &empty
	p, err = store.DiscoveryProfile(discovery)
	if err != nil || p.Credential != "" {
		t.Fatal("显式清除失败")
	}
	discovery.ExpectedRevision++
	_, err = store.DiscoveryProfile(discovery)
	requireCode(t, err, "revision-conflict")
	discovery.ExpectedRevision = service.Revision
	discovery.ServiceID = "missing"
	_, err = store.DiscoveryProfile(discovery)
	requireCode(t, err, "service-not-found")
	if writes != 0 || store.Services()[0].Revision != service.Revision {
		t.Fatal("获取模型修改配置")
	}
	for _, invalid := range []DiscoveryInput{
		{Provider: ProviderDeepSeek, APIFormat: FormatResponses, BaseURL: "https://api.deepseek.com"},
		{Provider: ProviderOpenAICompatible, APIFormat: FormatResponses, BaseURL: "http://remote.example.com", Credential: &key},
		{Provider: "unknown", APIFormat: FormatResponses, BaseURL: "https://example.com"},
	} {
		if _, err := store.DiscoveryProfile(invalid); err == nil {
			t.Fatal("无效连接被接受")
		}
	}
}
