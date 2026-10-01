package websites

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

// 官方源抓取（websiteRuntimeSources.test.ts 2 例的 Go 对等，全假件 fetcher）。

// fakeSource 按主机路由的官方源假件。
type fakeSource struct {
	handler func(url string) (int, http.Header, string)
}

func (s *fakeSource) Do(req *http.Request) (*http.Response, error) {
	status, header, body := s.handler(req.URL.String())
	return &http.Response{StatusCode: status, Header: header, Body: io.NopCloser(strings.NewReader(body))}, nil
}

func officialSources() *fakeSource {
	jsonHeaders := http.Header{}
	return &fakeSource{handler: func(rawURL string) (int, http.Header, string) {
		json := func(data string) (int, http.Header, string) { return 200, jsonHeaders, data }
		switch {
		case strings.HasPrefix(rawURL, "https://auth.docker.io/token"):
			return json(`{"token":"test-token"}`)
		case strings.HasPrefix(rawURL, "https://registry-1.docker.io/"):
			tags := map[string]string{
				"library/node":            `{"tags":["30.2.1","26.10.0","26.0.0","14.17.6","27.0.0-rc.1","99.0.0"]}`,
				"library/golang":          `{"tags":["1.29.1","1.27.1","1.16.7","1.15.0","1.28rc1","1.26.9"]}`,
				"library/python":          `{"tags":["2.7.18-slim","3.17.1-slim","3.14.7-slim","3.9.7-slim","3.15.0-slim","3.15.0rc1-slim","3.14.8-slim"]}`,
				"library/eclipse-temurin": `{"tags":["29.0.1_1-jre","11.0.32.1_1-jre","11.0.32_9-jre","17.0.1_12-jre","17_35-jre","16.0.2_7-jdk","28-ea-jdk"]}`,
			}
			for repo, payload := range tags {
				if strings.Contains(rawURL, "/v2/"+repo+"/tags/list") {
					return json(payload)
				}
			}
			return 404, jsonHeaders, `{}`
		case strings.HasPrefix(rawURL, "https://nodejs.org/"):
			return json(`[
				{"version":"v30.2.1","date":"2029-06-01"},{"version":"v26.10.0","date":"2026-09-21"},
				{"version":"v26.0.0","date":"2026-05-05"},{"version":"v14.17.6","date":"2021-08-30"},
				{"version":"v27.0.0-rc.1","date":"2026-09-20"},{"version":"v99.0.0","date":"2032-01-01"}
			]`)
		case strings.HasPrefix(rawURL, "https://raw.githubusercontent.com/"):
			return json(`{"v26":{"start":"2026-05-05","end":"2029-04-30"}}`)
		case strings.HasPrefix(rawURL, "https://go.dev/"):
			return json(`[
				{"version":"go1.29.1","stable":true},{"version":"go1.27.1","stable":true},{"version":"go1.16.7","stable":true},
				{"version":"go1.15","stable":true},{"version":"go1.28rc1","stable":false},{"version":"go1.26.9","stable":false}
			]`)
		case strings.HasPrefix(rawURL, "https://www.python.org/"):
			return json(`[
				{"name":"Python 2.7.18","pre_release":false,"is_published":true,"release_date":"2020-04-20"},
				{"name":"Python 3.17.1","pre_release":false,"is_published":true,"release_date":"2029-10-01"},
				{"name":"Python 3.14.7","pre_release":false,"is_published":true,"release_date":"2026-08-01"},
				{"name":"Python 3.9.7","pre_release":false,"is_published":true,"release_date":"2021-08-30"},
				{"name":"Python 3.14.0","pre_release":false,"is_published":true,"release_date":"2025-10-07"},
				{"name":"Python 3.15.0","pre_release":true,"is_published":true,"release_date":"2026-09-20"},
				{"name":"Python 3.15.0rc1","pre_release":true,"is_published":true,"release_date":"2026-09-20"},
				{"name":"Python 3.14.8","pre_release":false,"is_published":false,"release_date":"2026-09-20"}
			]`)
		case strings.HasSuffix(rawURL, "/available_releases"):
			return json(`{"available_lts_releases":[8,11,17,21,25,29],"most_recent_feature_release":29}`)
		case strings.Contains(rawURL, "/release_names"):
			if strings.Contains(rawURL, "page=0") {
				return json(`{"releases":["jdk-29.0.1+1","jdk-11.0.32.1+1","jdk-11.0.32+9","jdk-17.0.1+12","jdk-17+35","jdk-16.0.2+7","jdk-28-ea"]}`)
			}
			return json(`{"releases":[]}`)
		}
		return 500, jsonHeaders, fmt.Sprintf(`{"unexpected":%q}`, rawURL)
	}}
}

func catalogVersions(catalog runtimeCatalog, kind string) []string {
	versions := make([]string, 0, len(catalogEntriesFor(&catalog, kind)))
	for _, entry := range catalogEntriesFor(&catalog, kind) {
		versions = append(versions, entry.Version)
	}
	return versions
}

func TestFetchWebsiteRuntimeCatalogIntersection(t *testing.T) {
	catalog, err := FetchWebsiteRuntimeCatalog(context.Background(), officialSources(), "2026-09-30")
	if err != nil {
		t.Fatalf("抓取应成功：%v", err)
	}
	node := catalogVersions(catalog, KindNode)
	if strings.Join(node, ",") != "26.10.0,26.0.0,14.17.6" {
		t.Fatalf("node 应排除 rc 与未来版本并降序，得到 %v", node)
	}
	found := false
	for _, version := range catalogVersions(catalog, KindGo) {
		if version == "1.15.0" {
			found = true
		}
	}
	if !found {
		t.Fatalf("go 应保留五年前的历史正式补丁 1.15.0")
	}
	python := catalogVersions(catalog, KindPython)
	if strings.Join(python, ",") != "3.14.7,3.9.7" {
		t.Fatalf("python 应排除 2.x/pre-release/未发布/无镜像版本，得到 %v", python)
	}
	javaImage := func(version string) string {
		for _, entry := range catalog.Java {
			if entry.Version == version {
				return entry.Image
			}
		}
		return ""
	}
	if javaImage("11.0.32.1+1") != "eclipse-temurin:11.0.32.1_1-jre" {
		t.Fatalf("java 11.0.32.1+1 应优先 jre 镜像，得到 %s", javaImage("11.0.32.1+1"))
	}
	if javaImage("17.0.0+35") != "eclipse-temurin:17_35-jre" {
		t.Fatalf("java 17+35 应展开并映射 17_35-jre，得到 %s", javaImage("17.0.0+35"))
	}
	if javaImage("16.0.2+7") != "eclipse-temurin:16.0.2_7-jdk" {
		t.Fatalf("java 16.0.2+7 应回落 jdk 镜像，得到 %s", javaImage("16.0.2+7"))
	}
	for _, entry := range catalog.Java {
		if len(entry.Version) > 0 && entry.Version[0] >= '0' && entry.Version[0] <= '9' && !strings.Contains(entry.Version, ".") && !strings.Contains(entry.Version, "+") {
			t.Fatalf("不应有纯数字版本：%s", entry.Version)
		}
	}
	for kind, entries := range map[string][]catalogEntry{
		KindJava: catalog.Java, KindNode: catalog.Node, KindGo: catalog.Go, KindPython: catalog.Python,
	} {
		for _, entry := range entries {
			lower := strings.ToLower(entry.Image)
			if strings.Contains(lower, "rc") || strings.Contains(lower, "beta") || strings.Contains(lower, "ea") {
				t.Fatalf("%s 不应有预发布镜像：%s", kind, entry.Image)
			}
		}
	}
}

func TestFetchWebsiteRuntimeCatalogFutureAsOf(t *testing.T) {
	catalog, err := FetchWebsiteRuntimeCatalog(context.Background(), officialSources(), "2030-09-30")
	if err != nil {
		t.Fatalf("抓取应成功：%v", err)
	}
	contains := func(kind, version string) bool {
		for _, entry := range catalogVersions(catalog, kind) {
			if entry == version {
				return true
			}
		}
		return false
	}
	if !contains(KindNode, "30.2.1") || !contains(KindGo, "1.29.1") || !contains(KindPython, "3.17.1") || !contains(KindJava, "29.0.1+1") {
		t.Fatalf("未来正式版本应随 asOf 自动进入目录")
	}
}

func TestFetchWebsiteRuntimeCatalogEmptyKindRejected(t *testing.T) {
	// node 镜像标签为空 → node 目录为空 → 拒绝覆盖（防止空目录顶掉已有可选版本）。
	base := officialSources()
	source := &fakeSource{handler: func(rawURL string) (int, http.Header, string) {
		if strings.Contains(rawURL, "/v2/library/node/tags/list") {
			return 200, http.Header{}, `{"tags":[]}`
		}
		return base.handler(rawURL)
	}}
	if _, err := FetchWebsiteRuntimeCatalog(context.Background(), source, "2026-09-30"); err == nil || !strings.Contains(err.Error(), "正式版本目录为空") {
		t.Fatalf("任一 kind 目录为空应拒绝覆盖，得到 %v", err)
	}
}
