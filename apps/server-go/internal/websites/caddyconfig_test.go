package websites

import (
	"encoding/json"
	"strings"
	"testing"
)

// Caddy 配置生成与判读纯函数（caddyConfig.test.ts 4 例的 Go 对等）。

const testAdminListen = "unix//run/caddy/admin.sock"

func TestBuildCaddyConfigShape(t *testing.T) {
	cert := "证书"
	key := "私钥"
	config := parseJSONValue(BuildCaddyConfig([]CaddyManagedSite{{Domain: "example.com", Port: 8080, CertificatePEM: &cert, PrivateKeyPEM: &key}}, testAdminListen))
	root, ok := config.(map[string]any)
	if !ok {
		t.Fatalf("配置应为对象")
	}
	apps := root["apps"].(map[string]any)
	http := apps["http"].(map[string]any)
	servers := http["servers"].(map[string]any)
	https := servers["elysian"].(map[string]any)
	plainHTTP := servers["elysian_http"].(map[string]any)
	if listen := https["listen"].([]any); len(listen) != 1 || listen[0] != ":443" {
		t.Fatalf("443 server 监听应为 [:443]")
	}
	if policies := https["tls_connection_policies"].([]any); len(policies) != 1 {
		t.Fatalf("tls_connection_policies 应为 [{}]")
	}
	if !https["automatic_https"].(map[string]any)["disable"].(bool) {
		t.Fatalf("443 server 应关闭自动签发")
	}
	route := https["routes"].([]any)[0].(map[string]any)
	handle := route["handle"].([]any)[0].(map[string]any)
	if handle["handler"] != "reverse_proxy" {
		t.Fatalf("443 路由应为 reverse_proxy")
	}
	upstream := handle["upstreams"].([]any)[0].(map[string]any)
	if upstream["dial"] != "127.0.0.1:8080" {
		t.Fatalf("反代目标应为 127.0.0.1:8080，得到 %v", upstream["dial"])
	}
	if listen := plainHTTP["listen"].([]any); len(listen) != 1 || listen[0] != ":80" {
		t.Fatalf("80 server 监听应为 [:80]")
	}
	if !plainHTTP["automatic_https"].(map[string]any)["disable"].(bool) {
		t.Fatalf("80 server 应关闭自动签发")
	}
	redirect := plainHTTP["routes"].([]any)[0].(map[string]any)
	redirectHandle := redirect["handle"].([]any)[0].(map[string]any)
	if redirectHandle["handler"] != "static_response" || redirectHandle["status_code"] != "308" {
		t.Fatalf("80 路由应为 308 静态响应")
	}
	headers := redirectHandle["headers"].(map[string]any)
	location := headers["Location"].([]any)
	if len(location) != 1 || location[0] != "https://example.com{http.request.uri}" {
		t.Fatalf("重定向位置不符：%v", location)
	}
	tls := apps["tls"].(map[string]any)
	loaded := tls["certificates"].(map[string]any)["load_pem"].([]any)
	if len(loaded) != 1 {
		t.Fatalf("load_pem 应有一项")
	}
	item := loaded[0].(map[string]any)
	if item["certificate"] != "证书" || item["key"] != "私钥" {
		t.Fatalf("load_pem 内容不符")
	}
	// 键序对齐 TS 插入序：admin → logging → apps。
	raw := string(BuildCaddyConfig([]CaddyManagedSite{{Domain: "example.com", Port: 8080}}, testAdminListen))
	adminIndex := strings.Index(raw, `"admin"`)
	loggingIndex := strings.Index(raw, `"logging"`)
	appsIndex := strings.Index(raw, `"apps"`)
	if !(adminIndex < loggingIndex && loggingIndex < appsIndex) {
		t.Fatalf("配置根键序应为 admin → logging → apps：%s", raw)
	}
}

func TestAppliedManagedHostsDrift(t *testing.T) {
	site := CaddyManagedSite{Domain: "example.com", Port: 8080}
	config := parseJSONValue(BuildCaddyConfig([]CaddyManagedSite{site}, testAdminListen))
	if _, ok := AppliedManagedHosts([]CaddyManagedSite{site}, config)["example.com"]; !ok {
		t.Fatalf("目标配置应识别为已应用")
	}
	server := config.(map[string]any)["apps"].(map[string]any)["http"].(map[string]any)["servers"].(map[string]any)["elysian"].(map[string]any)
	// 目标漂移：dial 不匹配。
	route := server["routes"].([]any)[0].(map[string]any)
	handle := route["handle"].([]any)[0].(map[string]any)
	handle["upstreams"].([]any)[0].(map[string]any)["dial"] = "127.0.0.1:9999"
	if _, ok := AppliedManagedHosts([]CaddyManagedSite{site}, config)["example.com"]; ok {
		t.Fatalf("dial 漂移应识别为未应用")
	}
	handle["upstreams"].([]any)[0].(map[string]any)["dial"] = "127.0.0.1:8080"
	// 监听漂移：:80 出现在 443 server。
	server["listen"] = []any{":80"}
	if _, ok := AppliedManagedHosts([]CaddyManagedSite{site}, config)["example.com"]; ok {
		t.Fatalf("监听漂移应整体视为未应用")
	}
}

func TestHasForeignConfigRejects(t *testing.T) {
	site := CaddyManagedSite{Domain: "example.com", Port: 8080}
	config := parseJSONValue(BuildCaddyConfig([]CaddyManagedSite{site}, testAdminListen))
	if HasForeignConfig(config, hostSet("example.com"), testAdminListen) {
		t.Fatalf("面板自产配置不应视为外部")
	}
	apps := config.(map[string]any)["apps"].(map[string]any)
	apps["tls"].(map[string]any)["automation"] = map[string]any{}
	if !HasForeignConfig(config, hostSet("example.com"), testAdminListen) {
		t.Fatalf("外部 app（tls.automation）应视为外部配置")
	}
	delete(apps["tls"].(map[string]any), "automation")
	servers := apps["http"].(map[string]any)["servers"].(map[string]any)
	servers["foreign"] = map[string]any{}
	if !HasForeignConfig(config, hostSet("example.com"), testAdminListen) {
		t.Fatalf("外部 server 应视为外部配置")
	}
	delete(servers, "foreign")
}

func TestHasForeignConfigUnknownHost(t *testing.T) {
	site := CaddyManagedSite{Domain: "example.com", Port: 8080}
	config := parseJSONValue(BuildCaddyConfig([]CaddyManagedSite{site}, testAdminListen))
	if !HasForeignConfig(config, map[string]struct{}{}, testAdminListen) {
		t.Fatalf("同一 admin socket 下的未知域名路由应视为外部配置")
	}
	if HasForeignConfig(config, hostSet("example.com"), testAdminListen) {
		t.Fatalf("已知域名不应视为外部")
	}
}

func TestMissingHosts(t *testing.T) {
	expected := hostSet("a.example.com", "b.example.com")
	config := parseJSONValue(BuildCaddyConfig([]CaddyManagedSite{{Domain: "a.example.com", Port: 80}}, testAdminListen))
	missing := MissingHosts(expected, config)
	if len(missing) != 1 {
		t.Fatalf("应缺一个域名，得到 %v", missing)
	}
	if _, ok := missing["b.example.com"]; !ok {
		t.Fatalf("缺失集合应含 b.example.com")
	}
}

func TestManagedHostsShapeMismatch(t *testing.T) {
	if hosts := ManagedHosts(nil); len(hosts) != 0 {
		t.Fatalf("空配置应得空集合")
	}
	if hosts := ManagedHosts(json.RawMessage("{}")); len(hosts) != 0 {
		t.Fatalf("形状不符应得空集合")
	}
}

// hostSet 测试辅助。
func hostSet(hosts ...string) map[string]struct{} {
	set := map[string]struct{}{}
	for _, host := range hosts {
		set[host] = struct{}{}
	}
	return set
}
