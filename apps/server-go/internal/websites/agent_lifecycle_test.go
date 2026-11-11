package websites

import (
	"context"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

func TestWebsiteContainerBridgeLifecycle(t *testing.T) {
	registry := NewMemoryWebsiteRegistry()
	f := fixture(t, registry, nil, nil, nil)
	facade := &AgentFacade{service: f.service, authorize: func(context.Context) error { return nil }}
	bridge := facade.WebsiteContainerBridge(func(context.Context) error { return nil })
	ctx := context.Background()

	// 未登记容器不接管，交回 docker 侧常规目标判定。
	handled, err := bridge.Lifecycle(ctx, strings.Repeat("a", 64), "start")
	if handled || err != nil {
		t.Fatalf("未登记容器不应接管：%v %v", handled, err)
	}

	container := strings.Repeat("b", 64)
	if err := registry.Put(ctx, WebsiteRecord{ID: "site-1", Name: "www", ContainerID: &container}); err != nil {
		t.Fatal(err)
	}
	handled, err = bridge.Lifecycle(ctx, container, "start")
	if !handled || err != nil {
		t.Fatalf("登记容器应接管：%v %v", handled, err)
	}
	handled, err = bridge.Lifecycle(ctx, container, "restart")
	if !handled || err != nil {
		t.Fatalf("restart 应拆成 stop+start：%v %v", handled, err)
	}
	handled, err = bridge.Lifecycle(ctx, container, "stop")
	if !handled || err != nil {
		t.Fatalf("stop 应停止登记容器：%v %v", handled, err)
	}
	calls := f.docker.snapshotCalls()
	want := []string{"start:" + container, "stop:" + container, "start:" + container, "stop:" + container}
	if strings.Join(calls, ",") != strings.Join(want, ",") {
		t.Fatalf("引擎调用不符：%v", calls)
	}

	// remove 保持 website_remove 专属入口，不由此接缝承接。
	if handled, err = bridge.Lifecycle(ctx, container, "remove"); handled || err != nil {
		t.Fatalf("remove 不应由此接缝承接：%v %v", handled, err)
	}

	// 多个网站登记引用同一容器时拒绝容器级操作。
	if err := registry.Put(ctx, WebsiteRecord{ID: "site-2", Name: "www2", ContainerID: &container}); err != nil {
		t.Fatal(err)
	}
	if _, err = bridge.Lifecycle(ctx, container, "stop"); err == nil || !strings.Contains(err.Error(), "多个网站登记") {
		t.Fatalf("兄弟登记应拒绝：%v", err)
	}
	var rejected *seam.AgentContainerError
	if !errors.As(err, &rejected) || !rejected.NotDispatched || rejected.NoBusinessEffect {
		t.Fatalf("兄弟登记应声明未派发：%v", err)
	}

	// 授权票据核验失败直接拒绝。
	denied := facade.WebsiteContainerBridge(func(context.Context) error { return errors.New("票据失效") })
	other := strings.Repeat("c", 64)
	if err := registry.Put(ctx, WebsiteRecord{ID: "site-3", Name: "www3", ContainerID: &other}); err != nil {
		t.Fatal(err)
	}
	if _, err = denied.Lifecycle(ctx, other, "start"); err == nil || !strings.Contains(err.Error(), "票据失效") {
		t.Fatalf("核验失败应拒绝：%v", err)
	}
}

type lifecycleRegistry struct {
	Registry
	list func(context.Context) ([]WebsiteRecord, error)
}

func (r *lifecycleRegistry) List(ctx context.Context) ([]WebsiteRecord, error) {
	return r.list(ctx)
}

func TestWebsiteContainerBridgeRejectsChangedContainer(t *testing.T) {
	ctx := context.Background()
	registry := NewMemoryWebsiteRegistry()
	oldID, newID := strings.Repeat("a", 64), strings.Repeat("b", 64)
	row := WebsiteRecord{ID: "site", Name: "www", ContainerID: &oldID}
	if err := registry.Put(ctx, row); err != nil {
		t.Fatal(err)
	}
	reads := 0
	routedRegistry := &lifecycleRegistry{Registry: registry}
	routedRegistry.list = func(ctx context.Context) ([]WebsiteRecord, error) {
		rows, err := registry.List(ctx)
		reads++
		if reads == 1 {
			row.ContainerID = &newID
			err = registry.Put(ctx, row)
		}
		return rows, err
	}
	f := fixture(t, routedRegistry, nil, nil, nil)
	bridge := (&AgentFacade{service: f.service}).WebsiteContainerBridge(func(context.Context) error { return nil })
	handled, err := bridge.Lifecycle(ctx, oldID, "start")
	var rejected *seam.AgentContainerError
	if !handled || !errors.As(err, &rejected) || !rejected.NotDispatched || !strings.Contains(rejected.Message, "容器已变化") {
		t.Fatalf("陈旧容器目标未在锁内拒绝：%v %v", handled, err)
	}
	if calls := f.docker.snapshotCalls(); len(calls) != 0 {
		t.Fatalf("不得对替换容器执行：%v", calls)
	}
}

type lifecycleDocker struct {
	dockerOps
	start func(context.Context, string) error
	stop  func(context.Context, string) error
}

func (d *lifecycleDocker) Start(ctx context.Context, id string) error { return d.start(ctx, id) }
func (d *lifecycleDocker) Stop(ctx context.Context, id string) error  { return d.stop(ctx, id) }

func TestWebsiteContainerBridgeRestartHoldsProjectMutex(t *testing.T) {
	ctx := context.Background()
	registry := NewMemoryWebsiteRegistry()
	container := strings.Repeat("a", 64)
	if err := registry.Put(ctx, WebsiteRecord{ID: "site", Name: "www", ContainerID: &container}); err != nil {
		t.Fatal(err)
	}
	f := fixture(t, registry, nil, nil, nil)
	stage, release := make(chan string), make(chan struct{})
	defer close(release)
	f.service.deps.docker = &lifecycleDocker{dockerOps: f.docker,
		stop: func(ctx context.Context, id string) error {
			stage <- "stop"
			<-release
			return f.docker.Stop(ctx, id)
		},
		start: func(ctx context.Context, id string) error {
			stage <- "start"
			<-release
			return f.docker.Start(ctx, id)
		},
	}
	bridge := (&AgentFacade{service: f.service}).WebsiteContainerBridge(func(context.Context) error { return nil })
	done := make(chan error, 1)
	go func() {
		_, err := bridge.Lifecycle(ctx, container, "restart")
		done <- err
	}()
	for _, want := range []string{"stop", "start"} {
		if got := <-stage; got != want {
			t.Fatalf("重启步骤顺序：得到 %s，期望 %s", got, want)
		}
		if _, err := f.service.SetRunning(ctx, "site", false); err == nil {
			t.Fatalf("%s 阶段允许了网站页并发启停", want)
		}
		if _, err := f.service.Update(ctx, "site", updateRequest{}); err == nil {
			t.Fatalf("%s 阶段允许了并发修改", want)
		}
		if err := f.service.Remove(ctx, "site"); err == nil {
			t.Fatalf("%s 阶段允许了并发删除", want)
		}
		_, err := bridge.Lifecycle(ctx, container, "stop")
		var rejected *seam.AgentContainerError
		if !errors.As(err, &rejected) || !rejected.NotDispatched {
			t.Fatalf("%s 阶段的并发 Agent 操作未声明拒绝：%v", want, err)
		}
		release <- struct{}{}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if f.service.inProgress.has("site") {
		t.Fatal("重启完成后项目互斥未释放")
	}
	if calls := f.docker.snapshotCalls(); strings.Join(calls, ",") != "stop:"+container+",start:"+container {
		t.Fatalf("重启引擎调用不符：%v", calls)
	}
}

func TestWebsiteContainerBridgeExecutionFailureIsDispatched(t *testing.T) {
	for _, action := range []string{"start", "stop", "restart"} {
		t.Run(action, func(t *testing.T) {
			ctx := context.Background()
			registry := NewMemoryWebsiteRegistry()
			container := strings.Repeat("a", 64)
			if err := registry.Put(ctx, WebsiteRecord{ID: "site", Name: "www", ContainerID: &container}); err != nil {
				t.Fatal(err)
			}
			f := fixture(t, registry, nil, nil, nil)
			failed := func(context.Context, string) error {
				return &shared.InvalidRequestError{Status: 404, Message: "容器不存在"}
			}
			stop := failed
			if action == "restart" {
				stop = f.docker.Stop
			}
			f.service.deps.docker = &lifecycleDocker{dockerOps: f.docker, start: failed, stop: stop}
			bridge := (&AgentFacade{service: f.service}).WebsiteContainerBridge(func(context.Context) error { return nil })
			_, err := bridge.Lifecycle(ctx, container, action)
			var failedOperation *seam.AgentContainerError
			if !errors.As(err, &failedOperation) || failedOperation.NotDispatched || failedOperation.NoBusinessEffect || strings.Contains(err.Error(), "未执行") {
				t.Fatalf("执行后错误被误标为未派发：%v", err)
			}
		})
	}
}

type lifecycleProjectionFailure struct{ dockerOps }

func (d *lifecycleProjectionFailure) Inspect(context.Context, string) (map[string]any, error) {
	return nil, errors.New("状态读取失败")
}

func TestWebsiteContainerBridgeProjectionFailureIsDispatched(t *testing.T) {
	ctx := context.Background()
	registry := NewMemoryWebsiteRegistry()
	container := strings.Repeat("a", 64)
	if err := registry.Put(ctx, WebsiteRecord{ID: "site", Name: "www", ContainerID: &container}); err != nil {
		t.Fatal(err)
	}
	f := fixture(t, registry, nil, nil, nil)
	f.service.deps.docker = &lifecycleProjectionFailure{dockerOps: f.docker}
	bridge := (&AgentFacade{service: f.service}).WebsiteContainerBridge(func(context.Context) error { return nil })
	_, err := bridge.Lifecycle(ctx, container, "start")
	var failedOperation *seam.AgentContainerError
	if !errors.As(err, &failedOperation) || failedOperation.NotDispatched || failedOperation.NoBusinessEffect {
		t.Fatalf("变更后状态读取失败被误标为未派发：%v", err)
	}
	if calls := f.docker.snapshotCalls(); strings.Join(calls, ",") != "start:"+container {
		t.Fatalf("未保留已派发事实：%v", calls)
	}
}

func TestWebsiteContainerBridgePreflightStorageFailureStaysUnclassified(t *testing.T) {
	ctx := context.Background()
	registry := NewMemoryWebsiteRegistry()
	container := strings.Repeat("a", 64)
	if err := registry.Put(ctx, WebsiteRecord{ID: "site", Name: "www", ContainerID: &container}); err != nil {
		t.Fatal(err)
	}
	storageFailure := errors.New("登记读取失败")
	reads := 0
	routedRegistry := &lifecycleRegistry{Registry: registry}
	routedRegistry.list = func(ctx context.Context) ([]WebsiteRecord, error) {
		reads++
		if reads > 1 {
			return nil, storageFailure
		}
		return registry.List(ctx)
	}
	f := fixture(t, routedRegistry, nil, nil, nil)
	bridge := (&AgentFacade{service: f.service}).WebsiteContainerBridge(func(context.Context) error { return nil })
	_, err := bridge.Lifecycle(ctx, container, "start")
	if err != storageFailure {
		t.Fatalf("存储错误被改判为业务拒绝：%v", err)
	}
}
