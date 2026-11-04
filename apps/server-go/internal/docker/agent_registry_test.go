package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/seam"
)

func TestRegistryDirectoryAndMirrorRepository(t *testing.T) {
	presets := RegistryPresets()
	if len(presets) != 4 {
		t.Fatal(presets)
	}
	presets[0].URL = "changed"
	if RegistryPresets()[0].URL == "changed" {
		t.Fatal("目录可被调用者修改")
	}
	for _, registry := range []string{"", "https://registry-1.docker.io", "https://dockerproxy.net", "https://docker.1panel.live", "https://docker.1ms.run", "https://custom.example.com"} {
		t.Run(registry, func(t *testing.T) {
			var path string
			s := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true }), func(d *serviceDeps) {
				d.resolveRegistry = resolvePublicAlways
				d.fetchHubToken = func(context.Context, string) (string, error) { return "anonymous", nil }
				d.fetchTags = func(_ context.Context, _ registryRequestTarget, p, _ string) (catalogResponse, error) {
					path = p
					return catalogResponse{status: 200, json: mustDecode(t, `{"tags":["8.4"]}`)}, nil
				}
			})
			result, err := s.ImageTags(context.Background(), "mysql", registry)
			want := "/v2/library/mysql/tags/list"
			if strings.Contains(registry, "custom") {
				want = "/v2/mysql/tags/list"
			}
			if err != nil || !result.Searchable || path != want {
				t.Fatalf("%+v %v %s", result, err, path)
			}
		})
	}
	s := newService(newFakeEngine(func(engineCall) (int, string, bool) { t.Fatal("目录读取不得访问 Engine"); return 0, "", false }), nil)
	r := newRouter(routerDeps{available: true, socketReady: true, service: s})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/registry-presets", nil))
	var decoded []RegistryPreset
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &decoded) != nil || len(decoded) != 4 {
		t.Fatal(w.Body.String())
	}
}

func TestAgentQueryFailureIsSafeAndCancellationPreserved(t *testing.T) {
	s := newService(newFakeEngine(func(engineCall) (int, string, bool) { return 500, `{"message":"SECRET_REMOTE"}`, true }), nil)
	a := &AgentFacade{service: s, authorize: func(context.Context) error { return nil }}
	_, err := a.Search(context.Background(), "mysql", "")
	if failure, ok := err.(*AgentError); !ok || failure.Code != "docker-registry-query-failed" || strings.Contains(failure.Message, "SECRET") {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if agentQueryError(ctx, errors.New("remote")) != context.Canceled {
		t.Fatal("取消被掩盖")
	}
}

func TestAgentPullFailureEvidence(t *testing.T) {
	for _, tc := range []struct{ name, mode, want string }{
		{"完整错误帧", "error", "failed"}, {"完整HTTP拒绝", "http", "failed"},
		{"错误帧后断线", "disconnect", "unknown"}, {"错误帧后悬挂", "hang", "unknown"},
		{"错误帧后取消", "cancel", "unknown"}, {"进度超限", "overflow", "unknown"},
		{"回读失败", "finalize", "unknown"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
			engine.streamFn = func(ctx context.Context, _ engineCall, chunk func([]byte)) (seam.EngineResponse, error) {
				if tc.mode == "http" {
					return seam.EngineResponse{Status: 500, Body: []byte(`{"message":"SECRET"}`)}, nil
				}
				if tc.mode == "finalize" {
					return seam.EngineResponse{Status: 200, Body: []byte("{\"status\":\"Download complete\"}\n")}, nil
				}
				if tc.mode == "overflow" {
					chunk([]byte(strings.Repeat("x", maxPullLineLength+1)))
					return seam.EngineResponse{}, ctx.Err()
				}
				chunk([]byte("{\"error\":\"SECRET_REMOTE\"}\n"))
				switch tc.mode {
				case "disconnect":
					return seam.EngineResponse{}, errors.New("broken stream")
				case "hang":
					<-ctx.Done()
					return seam.EngineResponse{}, ctx.Err()
				case "cancel":
					return seam.EngineResponse{}, context.Canceled
				}
				return seam.EngineResponse{Status: 200}, nil
			}
			a := &AgentFacade{service: newService(engine, func(d *serviceDeps) { d.resolveRegistry = resolvePublicAlways }), taskRoot: t.TempDir(), authorize: func(context.Context) error { return nil }}
			task, err := a.Pull(context.Background(), "mysql:8.4", strings.Repeat("a", 64))
			if err != nil {
				t.Fatal(err)
			}
			a.taskWG.Wait()
			got, err := a.InspectPull(context.Background(), task.ID)
			if err != nil || got.State != tc.want || strings.Contains(got.ErrorMessage, "SECRET") {
				t.Fatalf("%+v %v", got, err)
			}
			_, err = a.PullFromRegistry(context.Background(), "mysql:8.4", strings.Repeat("b", 64), "https://dockerproxy.net")
			if (err == nil) != (tc.want == "failed") {
				t.Fatalf("错误地放行或阻止换源：%v", err)
			}
			_ = a.Close(context.Background())
		})
	}
}

func TestAgentPullSwitchRegistryRetagsAndPersists(t *testing.T) {
	var installed atomic.Bool
	var pulls atomic.Int32
	engine := newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Path == "/images/json" {
			if installed.Load() {
				return 200, `[{"Id":"sha256:` + imageIDConst + `"}]`, true
			}
			return 200, "[]", true
		}
		if call.Method == "POST" && strings.HasSuffix(call.Path, "/tag") {
			installed.Store(true)
			return 201, "", true
		}
		if call.Method == "DELETE" {
			return 200, "[]", true
		}
		if strings.HasPrefix(call.Path, "/images/") {
			return 200, strings.ReplaceAll(imageInspectJSON(imageIDConst), "nginx:1.27", "mysql:8.4"), true
		}
		return 0, "", false
	})
	engine.streamFn = func(_ context.Context, call engineCall, _ func([]byte)) (seam.EngineResponse, error) {
		if pulls.Add(1) == 1 {
			return seam.EngineResponse{Status: 500}, nil
		}
		if call.Query.Get("fromImage") != "dockerproxy.net/library/mysql:8.4" {
			t.Errorf("换源路径：%s", call.Query.Get("fromImage"))
		}
		return seam.EngineResponse{Status: 200, Body: []byte("{\"status\":\"Download complete\"}\n")}, nil
	}
	root := t.TempDir()
	a := &AgentFacade{service: newService(engine, func(d *serviceDeps) {
		d.resolveRegistry = resolvePublicAlways
		d.fetchTags = func(_ context.Context, _ registryRequestTarget, path, _ string) (catalogResponse, error) {
			if path != "/v2/library/mysql/tags/list" {
				t.Error(path)
			}
			return catalogResponse{status: 200, json: mustDecode(t, `{"tags":["8.4"]}`)}, nil
		}
	}), taskRoot: root, authorize: func(context.Context) error { return nil }}
	if _, err := a.Search(context.Background(), "mysql", ""); err == nil {
		t.Fatal("官方搜索失败未返回")
	}
	presets, err := a.Registries(context.Background())
	if err != nil || len(presets) != 4 {
		t.Fatal(presets, err)
	}
	tags, err := a.Tags(context.Background(), "mysql", presets[1].URL)
	if err != nil || !tags.(tagsResult).Searchable {
		t.Fatal(tags, err)
	}
	first, err := a.Pull(context.Background(), "mysql:8.4", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	a.taskWG.Wait()
	second, err := a.PullFromRegistry(context.Background(), "mysql:8.4", strings.Repeat("b", 64), "https://dockerproxy.net:443/")
	if err != nil {
		t.Fatal(err)
	}
	a.taskWG.Wait()
	got, _ := a.InspectPull(context.Background(), second.ID)
	if got.State != "succeeded" || got.Registry != "https://dockerproxy.net" || got.Image == nil || got.Image.Name != "mysql" {
		t.Fatalf("%+v", got)
	}
	if _, err = a.PullFromRegistry(context.Background(), "mysql:8.4", strings.Repeat("b", 64), "dockerproxy.net"); err != nil {
		t.Fatal(err)
	}
	if _, err = a.PullFromRegistry(context.Background(), "mysql:8.4", strings.Repeat("b", 64), "docker.1ms.run"); err == nil {
		t.Fatal("同请求改变源")
	}
	restarted := &AgentFacade{service: a.service, taskRoot: root}
	old, err := restarted.InspectPull(context.Background(), first.ID)
	if err != nil || old.State != "failed" {
		t.Fatalf("%+v %v", old, err)
	}
	if pulls.Load() != 2 {
		t.Fatal(pulls.Load())
	}
}

func TestAgentPullStorageFailureKeepsBarrier(t *testing.T) {
	root := t.TempDir()
	engine := newFakeEngine(func(engineCall) (int, string, bool) { return 200, "[]", true })
	engine.streamFn = func(context.Context, engineCall, func([]byte)) (seam.EngineResponse, error) {
		files, _ := filepath.Glob(filepath.Join(root, "*.json"))
		if len(files) != 1 {
			t.Error(files)
		} else {
			_ = os.Remove(files[0])
			_ = os.Mkdir(files[0], 0700)
		}
		return seam.EngineResponse{Status: 500}, nil
	}
	a := &AgentFacade{service: newService(engine, nil), taskRoot: root, authorize: func(context.Context) error { return nil }}
	task, err := a.Pull(context.Background(), "mysql:8.4", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	a.taskWG.Wait()
	got, _ := a.InspectPull(context.Background(), task.ID)
	if got.State != "running" {
		t.Fatalf("未落盘终态释放了屏障：%+v", got)
	}
	if _, err = a.Pull(context.Background(), "mysql:8.4", strings.Repeat("b", 64)); err == nil {
		t.Fatal("存储故障后重复拉取")
	}
}
