package docker

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

// dockerImageSearch 对等测试（dockerImageSearch.test.ts 锚点，fetcher 注入）。

func TestSearchCatalogPrefixDedupTopTen(t *testing.T) {
	requests := []string{}
	fetch := func(ctx context.Context, target registryRequestTarget, path string) (catalogResponse, error) {
		requests = append(requests, path)
		return catalogResponse{status: 200, json: mustDecode(t, `{"repositories":[
			"redis","redis-extra","redis","other","redisx","redisio","redis-a","redis-b",
			"redis-c","redis-d","redis-e","redis-f","redis-g","not-redis","red-is"]}`)}, nil
	}
	result := searchCatalog(context.Background(), validatedRegistryTarget{host: "mirror.example", addresses: []string{"93.184.216.34"}}, "redis", fetch)
	if !result.searchable {
		t.Fatalf("目录可用")
	}
	if len(result.names) != 10 {
		t.Fatalf("前十：%v", result.names)
	}
	for _, name := range result.names {
		if !strings.HasPrefix(name, "redis") {
			t.Fatalf("前缀过滤：%v", result.names)
		}
	}
	seen := map[string]bool{}
	for _, name := range result.names {
		if seen[name] {
			t.Fatalf("去重失败：%v", result.names)
		}
		seen[name] = true
	}
	if len(requests) != 1 || !strings.Contains(requests[0], "last=redir") {
		t.Fatalf("last 前驱定位（redis→redir）：%v", requests)
	}
	if !strings.Contains(requests[0], "n=100") {
		t.Fatalf("分页 n=100：%v", requests)
	}
}

func TestSearchCatalogFailures(t *testing.T) {
	cases := []struct {
		name  string
		fetch catalogFetcher
	}{
		{"401", func(context.Context, registryRequestTarget, string) (catalogResponse, error) {
			return catalogResponse{status: http.StatusUnauthorized}, nil
		}},
		{"坏格式", func(context.Context, registryRequestTarget, string) (catalogResponse, error) {
			return catalogResponse{status: 200, json: mustDecode(t, `{"unexpected":1}`)}, nil
		}},
		{"非对象", func(context.Context, registryRequestTarget, string) (catalogResponse, error) {
			return catalogResponse{status: 200, json: mustDecode(t, `[]`)}, nil
		}},
		{"超时", func(context.Context, registryRequestTarget, string) (catalogResponse, error) {
			return catalogResponse{}, errors.New("镜像源目录查询超时")
		}},
		{"超大小", func(context.Context, registryRequestTarget, string) (catalogResponse, error) {
			return catalogResponse{}, errors.New("镜像源目录响应超过大小上限")
		}},
	}
	for _, tc := range cases {
		result := searchCatalog(context.Background(), validatedRegistryTarget{host: "mirror.example"}, "redis", tc.fetch)
		if result.searchable || len(result.names) != 0 {
			t.Fatalf("%s → searchable:false 不回退 Hub：%+v", tc.name, result)
		}
	}
}

func TestListRegistryTagsSorting(t *testing.T) {
	tags := []string{"7", "10", "latest", "20240101", "3.5-alpine", "edge", "beta", "7-alpine"}
	body := `{"name":"redis","tags":[` + quoteJoin(tags) + `]}`
	fetch := func(context.Context, registryRequestTarget, string, string) (catalogResponse, error) {
		return catalogResponse{status: 200, json: mustDecode(t, body)}, nil
	}
	result := listRegistryTags(context.Background(), registryRequestTarget{host: "x"}, "library/redis", fetch, "")
	if !result.searchable {
		t.Fatalf("searchable")
	}
	if len(result.tags) == 0 || result.tags[0] != "latest" {
		t.Fatalf("latest 排最前：%v", result.tags)
	}
	// 数字版本形倒序：10 在 7 前。
	found10, found7 := -1, -1
	for i, tag := range result.tags {
		if tag == "10" {
			found10 = i
		}
		if tag == "7" {
			found7 = i
		}
	}
	if found10 == -1 || found7 == -1 || found10 > found7 {
		t.Fatalf("10 应排在 7 前：%v", result.tags)
	}
	// 日期快照排最后。
	if result.tags[len(result.tags)-1] != "20240101" {
		t.Fatalf("日期快照排最后：%v", result.tags)
	}
}

func TestListRegistryTagsLimitAndFilter(t *testing.T) {
	var tags []string
	for i := 0; i < 60; i++ {
		tags = append(tags, "tag"+itoa(i))
	}
	tags = append(tags, "bad tag", "bad/tag", "", strings.Repeat("x", 129))
	body := `{"tags":[` + quoteJoin(tags) + `]}`
	fetch := func(context.Context, registryRequestTarget, string, string) (catalogResponse, error) {
		return catalogResponse{status: 200, json: mustDecode(t, body)}, nil
	}
	result := listRegistryTags(context.Background(), registryRequestTarget{host: "x"}, "library/redis", fetch, "")
	if len(result.tags) != 40 {
		t.Fatalf("限量 40：%d", len(result.tags))
	}
	for _, tag := range result.tags {
		if !tagPattern.MatchString(tag) {
			t.Fatalf("非法 tag 应被过滤：%q", tag)
		}
	}
}

func TestListRegistryTagsUnauthorized(t *testing.T) {
	fetch := func(context.Context, registryRequestTarget, string, string) (catalogResponse, error) {
		return catalogResponse{status: http.StatusUnauthorized}, nil
	}
	result := listRegistryTags(context.Background(), registryRequestTarget{host: "x"}, "library/redis", fetch, "")
	if result.searchable || len(result.tags) != 0 {
		t.Fatalf("401 → 手动输入态：%+v", result)
	}
}

func TestListRegistryTagsError(t *testing.T) {
	fetch := func(context.Context, registryRequestTarget, string, string) (catalogResponse, error) {
		return catalogResponse{}, errors.New("镜像源标签查询超时")
	}
	result := listRegistryTags(context.Background(), registryRequestTarget{host: "x"}, "library/redis", fetch, "")
	if result.searchable || len(result.tags) != 0 {
		t.Fatalf("请求失败 → searchable:false：%+v", result)
	}
}

func TestListRegistryTagsTokenForwarded(t *testing.T) {
	var gotToken string
	var gotPath string
	fetch := func(_ context.Context, _ registryRequestTarget, path, token string) (catalogResponse, error) {
		gotToken = token
		gotPath = path
		return catalogResponse{status: 200, json: mustDecode(t, `{"tags":["latest"]}`)}, nil
	}
	listRegistryTags(context.Background(), registryRequestTarget{host: "registry-1.docker.io"}, "library/redis", fetch, "tok123")
	if gotToken != "tok123" {
		t.Fatalf("令牌应透传：%q", gotToken)
	}
	if gotPath != "/v2/library/redis/tags/list" {
		t.Fatalf("路径段应编码拼接：%q", gotPath)
	}
}

func TestCatalogStart(t *testing.T) {
	if got := catalogStart("redis"); got != "redir" {
		t.Fatalf("redis → redir：%q", got)
	}
	if got := catalogStart("a"); got != "`" {
		t.Fatalf("a 的前驱：got %q", got)
	}
}

func quoteJoin(items []string) string {
	quoted := make([]string, len(items))
	for i, item := range items {
		quoted[i] = `"` + item + `"`
	}
	return strings.Join(quoted, ",")
}
