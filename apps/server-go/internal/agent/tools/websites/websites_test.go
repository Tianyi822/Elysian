// 网站能力的测试：登记表用域自带的内存实现，Caddy 通道是替身，不连宿主 socket。
package websites

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/seam"
	domainwebsites "elysian/server/internal/websites"
)

// fakeCaddy 是 seam.CaddyAdmin 的替身。
type fakeCaddy struct {
	config      json.RawMessage
	unavailable *seam.CaddyChannelError
	loaded      []byte
}

func (f *fakeCaddy) CurrentConfig(context.Context) (json.RawMessage, *seam.CaddyChannelError) {
	if f.unavailable != nil {
		return nil, f.unavailable
	}
	return f.config, nil
}

func (f *fakeCaddy) Load(_ context.Context, config []byte) *seam.CaddyChannelError {
	f.loaded = config
	return f.unavailable
}

func install(t *testing.T, deps Deps, cfg Config) (*kardia.Context, *tools.Registry) {
	t.Helper()
	root := kardia.NewContext()
	fibers, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(deps, cfg))
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	t.Cleanup(func() {
		for i := len(fibers) - 1; i >= 0; i-- {
			if err := fibers[i].Dispose(context.Background()); err != nil {
				t.Errorf("销毁失败：%v", err)
			}
		}
	})
	registry, err := tools.RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}
	return root, registry
}

// seededSites 建一张带两条记录的内存登记表，其中一条内嵌访问令牌。
func seededSites(t *testing.T) domainwebsites.Registry {
	t.Helper()
	sites := domainwebsites.NewMemoryWebsiteRegistry()
	gitURL := "https://deploy:ghp_secret_token@github.com/tianyi/demo.git"
	domain := "demo.example.com"
	records := []domainwebsites.WebsiteRecord{
		{
			ID: "site-a", Kind: "static", Name: "演示站点", Category: "默认",
			Port: 48300, AccessMode: "domain", Domain: &domain, Enabled: true,
			RootDir: "/srv/elysian/websites/site-a", GitURL: &gitURL,
			DeployCommand: &gitURL, CreatedAt: "2026-10-01T00:00:00Z",
		},
		{
			ID: "site-b", Kind: "node", Name: "接口服务", Category: "默认",
			Port: 48301, AccessMode: "port", Enabled: false, CreatedAt: "2026-10-02T00:00:00Z",
		},
	}
	for _, record := range records {
		if err := sites.Put(context.Background(), record); err != nil {
			t.Fatalf("写入登记失败：%v", err)
		}
	}
	return sites
}

func TestWebsiteListProjectsAwaySecrets(t *testing.T) {
	sites := seededSites(t)
	root, registry := install(t, Deps{Sites: sites, Caddy: &fakeCaddy{}}, Config{})

	value, err := registry.Execute(root, "website_list", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	summaries, ok := value.([]WebsiteSummary)
	if !ok || len(summaries) != 2 {
		t.Fatalf("网站列表不符：%v", value)
	}
	if summaries[0].ID != "site-a" || summaries[0].Port != 48300 || summaries[0].AccessMode != "domain" {
		t.Fatalf("投影字段不符：%v", summaries[0])
	}

	encoded, err := json.Marshal(summaries)
	if err != nil {
		t.Fatalf("结果应可序列化：%v", err)
	}
	if strings.Contains(string(encoded), "ghp_secret_token") {
		t.Fatalf("来源地址里的令牌不得进工具结果：%s", encoded)
	}
	if !strings.Contains(string(encoded), "demo.example.com") {
		t.Fatalf("域名应保留：%s", encoded)
	}
}

func TestWebsiteListHonoursLimit(t *testing.T) {
	sites := seededSites(t)
	root, registry := install(t, Deps{Sites: sites, Caddy: &fakeCaddy{}}, Config{ListLimit: 1})

	value, err := registry.Execute(root, "website_list", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if summaries := value.([]WebsiteSummary); len(summaries) != 1 {
		t.Fatalf("应按上限截断：%v", summaries)
	}
}

func TestCaddyConfigCurrent(t *testing.T) {
	config := json.RawMessage(`{"apps":{"http":{}}}`)
	root, registry := install(t, Deps{Sites: seededSites(t), Caddy: &fakeCaddy{config: config}}, Config{})

	value, err := registry.Execute(root, "caddy_config_current", nil)
	if err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	raw, ok := value.(json.RawMessage)
	if !ok || string(raw) != string(config) {
		t.Fatalf("配置原文不符：%v", value)
	}
}

func TestCaddyUnavailableSurfacesChineseReason(t *testing.T) {
	channelErr := &seam.CaddyChannelError{
		Unavailable: true,
		Code:        "ENOENT",
		Message:     seam.CaddyChannelUnavailableDetail,
	}
	root, registry := install(t, Deps{Sites: seededSites(t), Caddy: &fakeCaddy{unavailable: channelErr}}, Config{})

	_, err := registry.Execute(root, "caddy_config_current", nil)
	if err == nil || !strings.Contains(err.Error(), seam.CaddyChannelUnavailableDetail) {
		t.Fatalf("通道不可用应带回中文说明：%v", err)
	}
}

func TestMissingDepsFailClosed(t *testing.T) {
	caddy := &fakeCaddy{}
	cases := []struct {
		name   string
		deps   Deps
		needle string
	}{
		{"缺登记表", Deps{Caddy: caddy}, "缺少登记表"},
		{"缺 Caddy 通道", Deps{Sites: domainwebsites.NewMemoryWebsiteRegistry()}, "缺少 Caddy 通道"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := kardia.NewContext()
			_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(tc.deps, Config{}))
			if err == nil || !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("期望错误含 %q，实际：%v", tc.needle, err)
			}
		})
	}
}

func TestNegativeLimitFailsClosed(t *testing.T) {
	root := kardia.NewContext()
	deps := Deps{Sites: domainwebsites.NewMemoryWebsiteRegistry(), Caddy: &fakeCaddy{}}
	_, err := tools.Install(context.Background(), root, tools.Plugin, Plugin(deps, Config{ListLimit: -1}))
	if err == nil || !strings.Contains(err.Error(), "列举上限不得为负") {
		t.Fatalf("负上限应被拒：%v", err)
	}
}
