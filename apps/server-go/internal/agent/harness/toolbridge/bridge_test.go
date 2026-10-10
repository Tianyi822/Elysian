package toolbridge

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"elysian/server/internal/agent/tools/docker"
	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

type fakeViews struct {
	list func(context.Context) ([]contract.Container, error)
}

func (f *fakeViews) ListContainers(ctx context.Context) ([]contract.Container, error) {
	if f.list != nil {
		return f.list(ctx)
	}
	return []contract.Container{}, nil
}
func (*fakeViews) ListImages(context.Context) ([]contract.ContainerImage, error) {
	return []contract.ContainerImage{}, nil
}
func (*fakeViews) Policy() seam.DockerPolicy {
	return seam.DockerPolicy{MountRoot: "/srv", ReservedPorts: []int{48100}}
}
func (*fakeViews) SelfContainerID() string { return "panel-id" }

func newBridge(t *testing.T, views seam.DockerViews) *Bridge {
	t.Helper()
	b, err := New(views)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if err := b.Close(ctx); err != nil {
			t.Errorf("关闭接缝：%v", err)
		}
	})
	return b
}

func TestUnavailableBridgeHasNoExecutableTools(t *testing.T) {
	for _, views := range []seam.DockerViews{nil, (*fakeViews)(nil)} {
		b := newBridge(t, views)
		if b.Available() || len(b.Schemas()) != 0 {
			t.Fatal("nil 视图不可暴露可用工具")
		}
		if _, err := b.Execute(context.Background(), "docker_images_list", nil); err == nil {
			t.Fatal("缺少视图必须拒绝执行")
		}
	}
}

func TestBridgeEnforcesAllowlistAndSchema(t *testing.T) {
	b := newBridge(t, &fakeViews{})
	if len(b.Schemas()) != 4 {
		t.Fatalf("只允许四条工具：%v", b.Schemas())
	}
	if _, err := b.Execute(context.Background(), "registry_host_check", map[string]any{"host": "example.com"}); err == nil {
		t.Fatal("非允许工具必须在 DNS 前被拒绝")
	}
	if _, err := b.Execute(context.Background(), "docker_containers_list", map[string]any{"unexpected": true}); err == nil {
		t.Fatal("未声明参数必须拒绝")
	}
	value, err := b.Execute(context.Background(), "docker_self_container", nil)
	if err != nil || value.(map[string]any)["id"] != "panel-id" {
		t.Fatalf("工具结果：%v %v", value, err)
	}
	if err := b.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if b.Available() {
		t.Fatal("关闭后不得可用")
	}
	if _, err := b.Execute(context.Background(), "docker_self_container", nil); err == nil {
		t.Fatal("关闭后不得新建调用")
	}
}

func TestBridgePreservesBoundedSafeProjection(t *testing.T) {
	secret := "SECRET_NEVER_EXPOSE"
	b := newBridge(t, &fakeViews{list: func(context.Context) ([]contract.Container, error) {
		rows := make([]contract.Container, 250)
		for i := range rows {
			rows[i] = contract.Container{ID: "id", Command: secret, Env: []contract.EnvPair{{Key: "PASSWORD", Value: &secret}}, Volumes: []contract.VolumeMount{{HostPath: secret}}}
		}
		return rows, nil
	}})
	value, err := b.Execute(context.Background(), "docker_containers_list", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(value.([]docker.ContainerSummary)) != 201 {
		t.Fatal("应只多取一条供内核判定截断")
	}
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), secret) {
		t.Fatal("工具接缝泄漏秘密")
	}
}

func TestCancellationWaitsForActualToolReturn(t *testing.T) {
	started := make(chan struct{})
	observedCancellation := make(chan struct{})
	release := make(chan struct{})
	b := newBridge(t, &fakeViews{list: func(ctx context.Context) ([]contract.Container, error) {
		close(started)
		<-ctx.Done()
		close(observedCancellation)
		<-release
		return []contract.Container{{ID: "completed-after-cancel"}}, nil
	}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan callResult, 1)
	go func() { value, err := b.Execute(ctx, "docker_containers_list", nil); done <- callResult{value, err} }()
	<-started
	cancel()
	select {
	case <-observedCancellation:
	case <-time.After(time.Second):
		t.Fatal("外部取消未抵达工具 scope")
	}
	select {
	case <-done:
		t.Fatal("不协作工具仍在执行时不得报告已退出")
	default:
	}
	close(release)
	select {
	case outcome := <-done:
		if outcome.err != nil || outcome.value.([]docker.ContainerSummary)[0].ID != "completed-after-cancel" {
			t.Fatalf("应保留真实完成结果：%v %v", outcome.value, outcome.err)
		}
	case <-time.After(time.Second):
		t.Fatal("工具返回后接缝未结束")
	}
}

func TestCloseCancelsActiveCall(t *testing.T) {
	started := make(chan struct{})
	b := newBridge(t, &fakeViews{list: func(ctx context.Context) ([]contract.Container, error) {
		close(started)
		<-ctx.Done()
		return nil, ctx.Err()
	}})
	done := make(chan error, 1)
	go func() { _, err := b.Execute(context.Background(), "docker_containers_list", nil); done <- err }()
	<-started
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := b.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("关闭必须取消调用：%v", err)
	}
}

func TestCloseDeadlineDoesNotClaimUnresponsiveCallStopped(t *testing.T) {
	started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	b := newBridge(t, &fakeViews{list: func(ctx context.Context) ([]contract.Container, error) {
		close(started)
		<-ctx.Done()
		close(cancelled)
		<-release
		return nil, ctx.Err()
	}})
	done := make(chan struct{})
	go func() { _, _ = b.Execute(context.Background(), "docker_containers_list", nil); close(done) }()
	<-started
	wait, stop := context.WithCancel(context.Background())
	stop()
	if err := b.Close(wait); !errors.Is(err, context.Canceled) {
		t.Fatalf("不协作工具关闭不能越过等待期限：%v", err)
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("关闭未取消工具")
	}
	if b.Available() {
		t.Fatal("开始关闭后必须停止新调用")
	}
	select {
	case <-done:
		t.Fatal("工具尚未退出却报告执行已结束")
	default:
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("工具退出后未回收调用")
	}
	if err := b.Close(context.Background()); err != nil {
		t.Fatalf("应能继续等待资源收尾：%v", err)
	}
}

func TestDomainErrorAndPanicDoNotLeakRawDetail(t *testing.T) {
	for _, panicTool := range []bool{false, true} {
		b := newBridge(t, &fakeViews{list: func(context.Context) ([]contract.Container, error) {
			if panicTool {
				panic("SECRET_PANIC")
			}
			return nil, errors.New("SECRET_ENGINE_BODY")
		}})
		_, err := b.Execute(context.Background(), "docker_containers_list", nil)
		if err == nil || strings.Contains(err.Error(), "SECRET") {
			t.Fatalf("原始域错误或 panic 不得外泄：%v", err)
		}
	}
}
