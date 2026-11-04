package docker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/seam"
)

type pullDeadlineTransport struct {
	seam.DockerTransport
	t    *testing.T
	want time.Duration
}

func (d pullDeadlineTransport) Stream(ctx context.Context, request seam.EngineRequest, onChunk func([]byte)) (seam.EngineResponse, error) {
	if request.Timeout != d.want {
		d.t.Errorf("Engine 传输时限为 %s，期望 %s", request.Timeout, d.want)
	}
	return d.DockerTransport.Stream(ctx, request, onChunk)
}

func progressEngine(installed *atomic.Bool) *fakeEngine {
	return newFakeEngine(func(call engineCall) (int, string, bool) {
		if call.Path == "/images/json" {
			if installed.Load() {
				return 200, `[{"Id":"sha256:` + imageIDConst + `"}]`, true
			}
			return 200, "[]", true
		}
		if strings.HasPrefix(call.Path, "/images/") {
			return 200, imageInspectJSON(imageIDConst), true
		}
		return 0, "", false
	})
}

func TestAgentPullProgressPersistsAtMostOncePerSecondAndRestores(t *testing.T) {
	var installed atomic.Bool
	var clock atomic.Int64
	clock.Store(time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC).UnixMilli())
	engine := progressEngine(&installed)
	frames, observed := make(chan string), make(chan struct{}, 1)
	engine.streamFn = func(ctx context.Context, _ engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) < 119*time.Minute {
			t.Error("Agent 拉取仍受到十五或二十分钟的内部期限限制")
		}
		for {
			select {
			case <-ctx.Done():
				return seam.EngineResponse{}, ctx.Err()
			case frame := <-frames:
				if frame == "done" {
					installed.Store(true)
					return seam.EngineResponse{Status: 200}, nil
				}
				onChunk([]byte(frame + "\n"))
				observed <- struct{}{}
			}
		}
	}
	root := t.TempDir()
	facade := &AgentFacade{service: newService(pullDeadlineTransport{engine, t, 2 * time.Hour}, func(d *serviceDeps) { d.now = func() time.Time { return time.UnixMilli(clock.Load()) } }), taskRoot: root, authorize: func(context.Context) error { return nil }}
	t.Cleanup(func() { _ = facade.Close(context.Background()) })
	request, cancel := context.WithCancel(context.Background())
	task, err := facade.Pull(request, "nginx:1.27", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	cancel() // 提交请求断开不能取消已接受的域任务。
	send := func(frame string) {
		t.Helper()
		select {
		case frames <- frame:
		case <-time.After(5 * time.Second):
			t.Fatal("流未接收进度")
		}
		select {
		case <-observed:
		case <-time.After(5 * time.Second):
			t.Fatal("进度回调未完成")
		}
	}
	send(`{"status":"Pulling fs layer","id":"first"}`)
	clock.Add(1000)
	send(`{"status":"Downloading","id":"first","progressDetail":{"current":0,"total":100}}`)
	file := filepath.Join(root, task.ID+".json")
	persisted, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var saved AgentPullTask
	if err := json.Unmarshal(persisted, &saved); err != nil || saved.Progress == nil || saved.Progress.CurrentBytes == nil || *saved.Progress.CurrentBytes != 0 {
		t.Fatalf("零字节进度未保存：%s %v", persisted, err)
	}
	clock.Add(100)
	send(`{"status":"Downloading","id":"first","progressDetail":{"current":50,"total":100}}`)
	latest, err := facade.InspectPull(context.Background(), task.ID)
	if err != nil || latest.Progress == nil || *latest.Progress.CurrentBytes != 50 {
		t.Fatalf("最新进度不可见：%+v %v", latest, err)
	}
	*latest.Progress.CurrentBytes = 99
	latest, _ = facade.InspectPull(context.Background(), task.ID)
	if *latest.Progress.CurrentBytes != 50 {
		t.Fatal("读取者修改了域任务进度")
	}
	throttled, _ := os.ReadFile(file)
	if string(throttled) != string(persisted) {
		t.Fatal("一秒内重复落盘进度")
	}
	// 用持久记录模拟进程重启；不能根据进度恢复成功或重投。
	recoveryRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(recoveryRoot, task.ID+".json"), persisted, 0600); err != nil {
		t.Fatal(err)
	}
	restarted := &AgentFacade{service: facade.service, taskRoot: recoveryRoot}
	recovered, err := restarted.InspectPull(context.Background(), task.ID)
	if err != nil || recovered.State != "unknown" || recovered.Progress == nil || recovered.Progress.LayerID != "first" || recovered.ErrorCode != "docker-pull-interrupted" {
		t.Fatalf("重启未保留进度和未知结果：%+v %v", recovered, err)
	}
	clock.Add(1000)
	send(`{"status":"Pulling fs layer","id":"second"}`)
	latest, _ = facade.InspectPull(context.Background(), task.ID)
	if latest.Progress.LayerID != "second" || latest.Progress.CurrentBytes != nil || latest.Progress.TotalBytes != nil {
		t.Fatal("切换镜像层继承了上一层百分比")
	}
	frames <- "done"
	facade.taskWG.Wait()
	latest, _ = facade.InspectPull(context.Background(), task.ID)
	if latest.State != "succeeded" || latest.Image == nil {
		t.Fatalf("拉取未正常完成：%+v", latest)
	}
}

func TestAgentPullRepeatedRawDataUsesIndependentIdleLimit(t *testing.T) {
	var installed atomic.Bool
	engine := progressEngine(&installed)
	engine.streamFn = func(ctx context.Context, _ engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
		for i := 0; i < 8; i++ {
			onChunk([]byte("{\"status\":\"Pulling fs layer\",\"id\":\"layer\"}\n"))
			select {
			case <-time.After(25 * time.Millisecond):
			case <-ctx.Done():
				return seam.EngineResponse{}, ctx.Err()
			}
		}
		installed.Store(true)
		return seam.EngineResponse{Status: 200}, nil
	}
	facade := &AgentFacade{service: newService(engine, func(d *serviceDeps) {
		d.pullIdleTimeout, d.agentPullIdleTimeout, d.agentPullTimeout = 5*time.Millisecond, 100*time.Millisecond, 5*time.Second
	}), taskRoot: t.TempDir(), authorize: func(context.Context) error { return nil }}
	task, err := facade.Pull(context.Background(), "nginx:1.27", strings.Repeat("a", 64))
	if err != nil {
		t.Fatal(err)
	}
	facade.taskWG.Wait()
	final, _ := facade.InspectPull(context.Background(), task.ID)
	if final.State != "succeeded" {
		t.Fatalf("重复原始数据未续期或错误复用了 Web 时限：%+v", final)
	}
}

func TestAgentPullTimeoutsPreserveReasonAndBarrier(t *testing.T) {
	for _, kind := range []string{"idle", "total"} {
		t.Run(kind, func(t *testing.T) {
			var installed atomic.Bool
			engine := progressEngine(&installed)
			engine.streamFn = func(ctx context.Context, _ engineCall, onChunk func([]byte)) (seam.EngineResponse, error) {
				if kind == "idle" {
					<-ctx.Done()
					return seam.EngineResponse{}, ctx.Err()
				}
				tick := time.NewTicker(5 * time.Millisecond)
				defer tick.Stop()
				for {
					select {
					case <-ctx.Done():
						return seam.EngineResponse{}, ctx.Err()
					case <-tick.C:
						onChunk([]byte("{\"status\":\"Pulling fs layer\"}\n"))
					}
				}
			}
			root := t.TempDir()
			facade := &AgentFacade{service: newService(engine, func(d *serviceDeps) {
				d.agentPullIdleTimeout, d.agentPullTimeout = 30*time.Millisecond, time.Second
				if kind == "total" {
					d.agentPullIdleTimeout, d.agentPullTimeout = time.Second, 80*time.Millisecond
				}
			}), taskRoot: root, authorize: func(context.Context) error { return nil }}
			task, err := facade.Pull(context.Background(), "nginx:1.27", strings.Repeat("a", 64))
			if err != nil {
				t.Fatal(err)
			}
			facade.taskWG.Wait()
			final, err := facade.InspectPull(context.Background(), task.ID)
			want := "docker-pull-idle-timeout"
			if kind == "total" {
				want = "docker-pull-timeout"
			}
			if err != nil || final.State != "unknown" || final.ErrorCode != want || !strings.Contains(final.ErrorMessage, "结果未确认") {
				t.Fatalf("超时原因丢失：%+v %v", final, err)
			}
			if _, err := facade.Pull(context.Background(), "redis:7", strings.Repeat("b", 64)); err == nil {
				t.Fatal("超时解除未知屏障")
			}
			restarted := &AgentFacade{service: facade.service, taskRoot: root}
			final, err = restarted.InspectPull(context.Background(), task.ID)
			if err != nil || final.State != "unknown" || final.ErrorCode != want {
				t.Fatalf("重启丢失超时原因：%+v %v", final, err)
			}
		})
	}
}
