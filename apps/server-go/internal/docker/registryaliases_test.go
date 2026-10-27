package docker

import (
	"context"
	"net/url"
	"strings"
	"testing"
)

func officialImageRegistryInputs() []string {
	inputs := []string{"", " \t ", " https://REGISTRY-1.DOCKER.IO:443/// "}
	for _, host := range []string{"registry-1.docker.io", "docker.io", "index.docker.io"} {
		for _, scheme := range []string{"", "https://"} {
			for _, suffix := range []string{"", "/", ":443", ":443/"} {
				inputs = append(inputs, scheme+host+suffix)
			}
		}
	}
	return inputs
}

func TestOfficialImageRegistryQueries(t *testing.T) {
	for _, registry := range officialImageRegistryInputs() {
		t.Run(registry, func(t *testing.T) {
			engine := newFakeEngine(func(call engineCall) (int, string, bool) {
				if call.Method == "GET" && call.Path == "/images/search" && call.Query.Get("term") == "redis" && call.Query.Get("limit") == "10" {
					return 200, `[{"name":"redis"}]`, true
				}
				return 0, "", false
			})
			var tokenRepository string
			var tagCalls int
			service := newService(engine, func(deps *serviceDeps) {
				deps.resolveRegistry = func(context.Context, string) ([]string, error) {
					t.Fatal("官方源不应走自定义源 DNS 校验")
					return nil, nil
				}
				deps.fetchCatalog = func(context.Context, registryRequestTarget, string) (catalogResponse, error) {
					t.Fatal("官方源不应查询目录接口")
					return catalogResponse{}, nil
				}
				deps.fetchHubToken = func(_ context.Context, repository string) (string, error) {
					tokenRepository = repository
					return "hub-token", nil
				}
				deps.fetchTags = func(_ context.Context, target registryRequestTarget, path, token string) (catalogResponse, error) {
					tagCalls++
					if target.host != "registry-1.docker.io" || token != "hub-token" || path != "/v2/"+tokenRepository+"/tags/list" {
						t.Fatalf("官方标签查询目标或令牌有误：%+v %q %q", target, path, token)
					}
					return catalogResponse{status: 200, json: mustDecode(t, `{"tags":["latest","8-alpine"]}`)}, nil
				}
			})
			result, err := service.SearchImages(context.Background(), "redis", registry)
			if err != nil || !result.Searchable || len(result.Names) != 1 || result.Names[0] != "redis" {
				t.Fatalf("官方搜索失败：%+v %v", result, err)
			}
			for _, repository := range []string{"redis", "team/redis"} {
				result, err := service.ImageTags(context.Background(), repository, registry)
				wantRepository := repository
				if repository == "redis" {
					wantRepository = "library/redis"
				}
				if err != nil || !result.Searchable || len(result.Tags) != 2 || tokenRepository != wantRepository {
					t.Fatalf("官方标签查询失败：%+v %v，仓库 %q", result, err, tokenRepository)
				}
			}
			if len(engine.Requests()) != 1 || tagCalls != 2 {
				t.Fatalf("应执行一次 Engine 搜索和两次标签查询：%d %d", len(engine.Requests()), tagCalls)
			}
		})
	}
}

func TestCustomImageRegistryAliasesDoNotFallback(t *testing.T) {
	for _, host := range []string{"docker.io:5000", "index.docker.io:444", "registry-1.docker.io.evil.example", "notdocker.io"} {
		t.Run(host, func(t *testing.T) {
			var catalogCalls, tagCalls, resolveCalls int
			service := newService(newFakeEngine(func(engineCall) (int, string, bool) {
				t.Fatal("自定义源不得回退官方搜索")
				return 0, "", false
			}), func(deps *serviceDeps) {
				deps.resolveRegistry = func(_ context.Context, hostname string) ([]string, error) {
					resolveCalls++
					wantHostname, _ := splitHostPort(host)
					if hostname != wantHostname {
						t.Fatalf("解析主机有误：%q", hostname)
					}
					return []string{"93.184.216.34"}, nil
				}
				deps.fetchCatalog = func(_ context.Context, target registryRequestTarget, path string) (catalogResponse, error) {
					catalogCalls++
					if target.host != host || len(target.addresses) != 1 || !strings.HasPrefix(path, "/v2/_catalog?") {
						t.Fatalf("自定义目录目标有误：%+v %q", target, path)
					}
					return catalogResponse{status: 401}, nil
				}
				deps.fetchHubToken = func(context.Context, string) (string, error) {
					t.Fatal("自定义源不得使用 Hub 令牌")
					return "", nil
				}
				deps.fetchTags = func(_ context.Context, target registryRequestTarget, path, token string) (catalogResponse, error) {
					tagCalls++
					if target.host != host || len(target.addresses) != 1 || path != "/v2/redis/tags/list" || token != "" {
						t.Fatalf("自定义标签目标有误：%+v %q %q", target, path, token)
					}
					return catalogResponse{status: 401}, nil
				}
			})
			registry := "https://" + host + "/"
			names, err := service.SearchImages(context.Background(), "redis", registry)
			if err != nil || names.Searchable || len(names.Names) != 0 {
				t.Fatalf("自定义目录不可用：%+v %v", names, err)
			}
			tags, err := service.ImageTags(context.Background(), "redis", registry)
			if err != nil || tags.Searchable || len(tags.Tags) != 0 {
				t.Fatalf("自定义标签不可用：%+v %v", tags, err)
			}
			if catalogCalls != 1 || tagCalls != 1 || resolveCalls != 2 {
				t.Fatalf("自定义源必须校验公网并分别查询：%d %d %d", catalogCalls, tagCalls, resolveCalls)
			}
		})
	}
}

func TestImageRegistryAliasValidation(t *testing.T) {
	cases := map[string]string{
		"docKer.io":                                 disallowedHost,
		"http://docker.io":                          httpNotAllowed,
		"https://docker.io/v2/":                     disallowedHost,
		"docker.io?query=1":                         disallowedHost,
		"docker.io#fragment":                        disallowedHost,
		"https://user:password@docker.io":           disallowedHost,
		"docker.io:0":                               disallowedHost,
		"docker.io:65536":                           disallowedHost,
		"https://registry-1.docker.io@evil.example": disallowedHost,
	}
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) {
		t.Fatal("非法地址不得请求 Engine")
		return 0, "", false
	}), func(deps *serviceDeps) {
		deps.resolveRegistry = func(context.Context, string) ([]string, error) {
			t.Fatal("非法地址不得发起 DNS 解析")
			return nil, nil
		}
	})
	for raw, message := range cases {
		t.Run(raw, func(t *testing.T) {
			if isOfficialImageRegistry(raw) {
				t.Fatal("非法地址不得识别为官方源")
			}
			_, err := service.SearchImages(context.Background(), "redis", raw)
			wantInvalidRequest(t, err, 400, message)
			_, err = service.ImageTags(context.Background(), "redis", raw)
			wantInvalidRequest(t, err, 400, message)
		})
	}
}

func TestImageRegistryAliasCustomPrivateAddressRejected(t *testing.T) {
	service := newService(newFakeEngine(func(engineCall) (int, string, bool) {
		t.Fatal("私网镜像源不得请求 Engine")
		return 0, "", false
	}), func(deps *serviceDeps) {
		deps.resolveRegistry = func(context.Context, string) ([]string, error) {
			return []string{"10.0.0.1"}, nil
		}
	})
	_, err := service.SearchImages(context.Background(), "redis", "docker.io:5000")
	wantInvalidRequest(t, err, 400, resolvePublicError)
	_, err = service.ImageTags(context.Background(), "redis", "docker.io:5000")
	wantInvalidRequest(t, err, 400, resolvePublicError)
}

func TestRoutesOfficialImageRegistryAliases(t *testing.T) {
	for _, registry := range []string{"registry-1.docker.io", " https://INDEX.DOCKER.IO:443/ "} {
		t.Run(registry, func(t *testing.T) {
			router, _ := readyRouter()
			query := "&registry=" + url.QueryEscape(registry)
			search := doGet(router, "/images/search?term=nginx"+query, nil)
			if search.Code != 200 || search.Body.String() != `{"names":["nginx","redis"],"searchable":true}` {
				t.Fatalf("官方搜索 API：%d %s", search.Code, search.Body.String())
			}
			tags := doGet(router, "/images/tags?name=nginx"+query, nil)
			if tags.Code != 200 || tags.Body.String() != `{"tags":["latest"],"searchable":true}` {
				t.Fatalf("官方标签 API：%d %s", tags.Code, tags.Body.String())
			}
		})
	}
}
