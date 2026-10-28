package docker

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/shared"
)

func TestPullErrorCancelsOpenEngineStreamAndReleasesSlot(t *testing.T) {
	transport := streamTransportFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, "[]")
			return
		}
		_, _ = io.WriteString(w, "{\"errorDetail\":{\"message\":\"仓库拒绝访问\"}}\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done() // 错误后不关闭流，必须由面板取消。
	})
	service := newService(transport, nil)
	for attempt := 0; attempt < 2; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		_, err := service.Pull(ctx, mustDecode(t, `{"name":"redis","tag":"latest"}`), nil)
		cancel()
		var invalid *shared.InvalidRequestError
		if !errors.As(err, &invalid) || invalid.Message != "仓库拒绝访问" {
			t.Fatalf("第 %d 次应立即返回原始错误：%v", attempt+1, err)
		}
		if service.pullInFlight.Load() {
			t.Fatal("错误后仍占用镜像拉取槽位")
		}
	}
}

func TestPullIdleTimeoutBeforeAndAfterData(t *testing.T) {
	for _, stage := range []string{"before-headers", "before-data", "after-progress"} {
		t.Run(stage, func(t *testing.T) {
			transport := streamTransportFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if stage != "before-headers" {
					w.WriteHeader(http.StatusOK)
					if stage == "after-progress" {
						_, _ = io.WriteString(w, "{\"status\":\"Pulling fs layer\"}\n")
					}
					w.(http.Flusher).Flush()
				}
				<-r.Context().Done()
			})
			service := newService(transport, func(deps *serviceDeps) { deps.pullIdleTimeout = 40 * time.Millisecond })
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := service.pullStream(ctx, "redis:latest", nil)
			if !errors.Is(err, pullIdleError) {
				t.Fatalf("应返回无数据超时，不能伪装成用户取消：%v", err)
			}
		})
	}
}

func TestPullRepeatedRawProgressKeepsStreamAlive(t *testing.T) {
	transport := streamTransportFixture(t, func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i < 8; i++ {
			_, _ = io.WriteString(w, "{\"status\":\"Pulling fs layer\",\"id\":\"layer\"}\n")
			w.(http.Flusher).Flush()
			time.Sleep(20 * time.Millisecond)
		}
	})
	service := newService(transport, func(deps *serviceDeps) { deps.pullIdleTimeout = 100 * time.Millisecond })
	updates := 0
	if err := service.pullStream(context.Background(), "redis:latest", func(imagePullProgress) { updates++ }); err != nil {
		t.Fatalf("重复帧仍说明上游活跃：%v", err)
	}
	if updates != 1 {
		t.Fatalf("进度去重应保留：%d", updates)
	}
}

func TestPullPresetReferencesReachEngine(t *testing.T) {
	for _, host := range []string{"dockerproxy.net", "docker.1panel.live", "docker.1ms.run"} {
		t.Run(host, func(t *testing.T) {
			transport := streamTransportFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					_, _ = io.WriteString(w, "[]")
					return
				}
				if got := r.URL.Query().Get("fromImage"); got != host+"/library/redis:7-alpine" {
					t.Errorf("拉取目标未使用所选源：%s", got)
				}
				_, _ = io.WriteString(w, "{\"error\":\"测试在下载前结束\"}\n")
			})
			service := newService(transport, func(deps *serviceDeps) { deps.resolveRegistry = resolvePublicAlways })
			_, err := service.Pull(context.Background(), mustDecode(t, `{"name":"redis","tag":"7-alpine","registry":"https://`+host+`"}`), nil)
			if err == nil || !strings.Contains(err.Error(), "测试在下载前结束") {
				t.Fatalf("未走到 Engine 拉取：%v", err)
			}
		})
	}
}
