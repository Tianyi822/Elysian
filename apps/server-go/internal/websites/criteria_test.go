package websites

import (
	"strings"
	"testing"
)

// 契约判据纯函数的 Go 版对等断言（contracts websites.ts 判据语义逐条照抄）。

func TestIsValidWebsiteProjectName(t *testing.T) {
	valid := []string{"site", "  padded  ", "站点-01", strings.Repeat("a", 64)}
	for _, name := range valid {
		if !IsValidWebsiteProjectName(name) {
			t.Fatalf("项目名 %q 应当合法", name)
		}
	}
	invalid := []string{"", "   ", ".", "..", "a/b", `a\b`, "a:b", "a\x00b", "a\nb", strings.Repeat("a", 65)}
	for _, name := range invalid {
		if IsValidWebsiteProjectName(name) {
			t.Fatalf("项目名 %q 应当拒绝", name)
		}
	}
}

func TestIsValidWebsitePort(t *testing.T) {
	if !IsValidWebsitePort(1) || !IsValidWebsitePort(65535) || !IsValidWebsitePort(8080) {
		t.Fatalf("1-65535 的整数应当合法")
	}
	for _, port := range []float64{0, 65536, 8080.5, -1} {
		if IsValidWebsitePort(port) {
			t.Fatalf("端口 %v 应当拒绝", port)
		}
	}
}

func TestIsValidWebsiteDomain(t *testing.T) {
	if !IsValidWebsiteDomain("example.com") || !IsValidWebsiteDomain(" a.example.com ") {
		t.Fatalf("常规域名应当合法")
	}
	for _, domain := range []string{"", "example", "1.2.3.4", "-a.example.com", "a-.example.com", "exa mple.com"} {
		if IsValidWebsiteDomain(domain) {
			t.Fatalf("域名 %q 应当拒绝", domain)
		}
	}
}

func TestJavaReleaseVersionCriteria(t *testing.T) {
	for _, version := range []string{"8u412-b08", "17.0.1+12", "11.0.32.1+1"} {
		if !IsWebsiteRuntimeReleaseVersion(KindJava, version) {
			t.Fatalf("java 版本 %s 应当合法", version)
		}
	}
	for _, version := range []string{"17", "17+35", "17.0.1-rc.1"} {
		if IsWebsiteRuntimeReleaseVersion(KindJava, version) {
			t.Fatalf("java 版本 %s 应当拒绝", version)
		}
	}
	if !IsWebsiteRuntimeReleaseVersion(KindNode, "24.21.0") || IsWebsiteRuntimeReleaseVersion(KindNode, "24.22.0-rc.1") {
		t.Fatalf("node 正式版判据不符")
	}
	if NormalizeWebsiteJavaReleaseVersion("17+35") != "17.0.0+35" {
		t.Fatalf("17+35 应展开为 17.0.0+35")
	}
	if NormalizeWebsiteJavaReleaseVersion("17.0.1+12") != "17.0.1+12" {
		t.Fatalf("完整版本应保持原样")
	}
}

func TestWebsiteRuntimeImageRef(t *testing.T) {
	html := WebsiteRuntimeImageRef(KindHTML, nil, nil)
	if html == nil || *html != WEBSITE_HTML_IMAGE {
		t.Fatalf("HTML 应返回固定镜像")
	}
	catalog := &runtimeCatalog{Node: []catalogEntry{{Version: "24.21.0", Image: "node:24.21.0"}}}
	if ref := WebsiteRuntimeImageRef(KindNode, stringPtr("24.21.0"), catalog); ref == nil || *ref != "node:24.21.0" {
		t.Fatalf("目录命中应返回镜像")
	}
	if ref := WebsiteRuntimeImageRef(KindNode, stringPtr("99.9.9"), catalog); ref != nil {
		t.Fatalf("目录未命中应返回 nil")
	}
	if ref := WebsiteRuntimeImageRef(KindNode, nil, catalog); ref != nil {
		t.Fatalf("无版本应返回 nil")
	}
}

func TestWebsiteDefaultDeployCommand(t *testing.T) {
	if command := WebsiteDefaultDeployCommand(KindHTML); *command != "nginx -g daemon off;" {
		t.Fatalf("HTML 缺省命令不符：%s", *command)
	}
	if command := WebsiteDefaultDeployCommand(KindPython); command != nil {
		t.Fatalf("python 应无缺省命令")
	}
	if command := WebsiteDefaultDeployCommand(KindNode); command != nil {
		t.Fatalf("node 应无缺省命令")
	}
	if command := WebsiteDefaultDeployCommand(KindJava); command != nil {
		t.Fatalf("java 应无缺省命令")
	}
	if command := WebsiteDefaultDeployCommand(KindGo); command != nil {
		t.Fatalf("go 应无缺省命令")
	}
}

func runtimeReportFixture() runtimeCatalogReport {
	return runtimeCatalogReport{
		Catalog: runtimeCatalog{
			Java:   []catalogEntry{{Version: "17.0.1+12", Image: "eclipse-temurin:17.0.1_12-jre", Maintenance: MaintenanceLegacy, CheckedAt: "2026-09-30"}},
			Node:   []catalogEntry{{Version: "24.21.0", Image: "node:24.21.0", Maintenance: MaintenanceMaintained, CheckedAt: "2026-09-30"}},
			Go:     []catalogEntry{{Version: "1.16.7", Image: "golang:1.16.7", Maintenance: MaintenanceLegacy, CheckedAt: "2026-09-30"}},
			Python: []catalogEntry{{Version: "3.9.7", Image: "python:3.9.7-slim", Maintenance: MaintenanceLegacy, CheckedAt: "2026-09-30"}},
		},
		FetchedAt: "2026-09-30T00:00:00.000Z",
		Stale:     false,
		Detail:    nil,
	}
}

func TestParseWebsiteRuntimeCatalogReport(t *testing.T) {
	report, err := ParseWebsiteRuntimeCatalogReport(marshalAnyValue(runtimeReportFixture()))
	if err != nil {
		t.Fatalf("合法报告应通过：%v", err)
	}
	if report.FetchedAt != "2026-09-30T00:00:00.000Z" || report.Stale || report.Detail != nil {
		t.Fatalf("报告字段回读不符")
	}
	if len(report.Catalog.Java) != 1 || report.Catalog.Java[0].Image != "eclipse-temurin:17.0.1_12-jre" {
		t.Fatalf("java 条目回读不符")
	}

	broken := map[string]any{}
	for key, value := range marshalAnyValue(runtimeReportFixture()).(map[string]any) {
		broken[key] = value
	}
	brokenCatalog := map[string]any{}
	for key, value := range broken["catalog"].(map[string]any) {
		brokenCatalog[key] = value
	}
	brokenCatalog["node"] = []any{map[string]any{"version": "24.21.0", "image": "node:25.0.0", "maintenance": "maintained", "checkedAt": "2026-09-30"}}
	broken["catalog"] = brokenCatalog
	if _, err := ParseWebsiteRuntimeCatalogReport(broken); err == nil || err.Error() != "正式运行时版本目录响应无效" {
		t.Fatalf("镜像与版本不匹配应拒绝，得到 %v", err)
	}

	duplicated := runtimeReportFixture()
	duplicated.Catalog.Node = []catalogEntry{
		{Version: "24.21.0", Image: "node:24.21.0", Maintenance: MaintenanceMaintained, CheckedAt: "2026-09-30"},
		{Version: "24.21.0", Image: "node:24.21.0", Maintenance: MaintenanceMaintained, CheckedAt: "2026-09-30"},
	}
	if _, err := ParseWebsiteRuntimeCatalogReport(marshalAnyValue(duplicated)); err == nil {
		t.Fatalf("重复版本应拒绝")
	}

	empty := runtimeReportFixture()
	empty.Catalog.Python = nil
	if _, err := ParseWebsiteRuntimeCatalogReport(marshalAnyValue(empty)); err == nil {
		t.Fatalf("空目录应拒绝")
	}
}

// marshalAnyValue 测试辅助：把值过一遍 JSON 编解码得到判读函数可导航的形态。
func marshalAnyValue(value any) any {
	data, err := marshalJSONCompact(value)
	if err != nil {
		return nil
	}
	return parseJSONValue(data)
}
