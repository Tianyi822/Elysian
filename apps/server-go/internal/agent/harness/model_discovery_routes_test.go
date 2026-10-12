package harness

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestDiscoverModelsRouteUsesDraftAndSavedCredentialWithoutWriting(t *testing.T) {
	m, _ := sessionAPIManager(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path != "/models" || r.Header.Get("Authorization") != "Bearer saved-fake-key" {
			t.Error("目录未使用正确连接和凭据")
		}
		io.WriteString(w, `{"data":[{"id":"deepseek-flash","name":"Flash","context_window":1048576,"max_output_tokens":393216,"credential":"saved-fake-key"}]}`)
	}))
	defer server.Close()
	m.deps.ModelCatalog = model.NewCatalogClient(server.Client())
	key := "saved-fake-key"
	input := model.ServiceInput{Name: "DeepSeek", Provider: model.ProviderDeepSeek, APIFormat: model.FormatAnthropicMessages, BaseURL: server.URL + "/anthropic", Active: true, Credential: &key, Models: []model.ServiceModelInput{{Name: "Flash", Model: "deepseek-flash", ContextTokens: 1000000, OutputTokens: 4096, Capabilities: model.Capabilities{Text: true, Tools: true, Source: "测试"}, Enabled: true}}}
	service, err := m.CreateModelService(input)
	if err != nil {
		t.Fatal(err)
	}
	request := model.DiscoveryInput{ServiceID: service.ID, ExpectedRevision: service.Revision, Provider: input.Provider, APIFormat: input.APIFormat, BaseURL: input.BaseURL}
	body, _ := json.Marshal(request)
	response := runtimeRouteRequest(m.Router(), "POST", "/model-services/discover", string(body))
	if response.Code != 200 || strings.Contains(response.Body.String(), key) || !strings.Contains(response.Body.String(), "1048576") {
		t.Fatalf("目录读取或公开过滤失败：%d %s", response.Code, response.Body.String())
	}
	request.ServiceID, request.ExpectedRevision, request.Credential = "", 0, &key
	body, _ = json.Marshal(request)
	if response = runtimeRouteRequest(m.Router(), "POST", "/model-services/discover", string(body)); response.Code != 200 {
		t.Fatalf("新建草稿目录读取失败：%s", response.Body.String())
	}
	request.ServiceID, request.ExpectedRevision, request.Credential = service.ID, service.Revision+1, nil
	body, _ = json.Marshal(request)
	if response = runtimeRouteRequest(m.Router(), "POST", "/model-services/discover", string(body)); response.Code != 409 {
		t.Fatal("旧修订未拒绝")
	}
	if response = runtimeRouteRequest(m.Router(), "POST", "/model-services/discover", `{"provider":"deepseek","credential":"first","credential":"second"}`); response.Code != 400 {
		t.Fatal("重复字段未拒绝")
	}
	services, _ := m.ListModelServices()
	if len(services) != 2 || calls.Load() != 2 {
		t.Fatal("目录请求隐式新增配置或重复请求")
	}
	for _, saved := range services {
		if saved.ID == service.ID && saved.Revision != 1 {
			t.Fatal("目录请求修改服务修订")
		}
	}
}
