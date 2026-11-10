package websites

import (
	"context"
	"errors"
	"strings"
	"testing"
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
	calls := f.docker.snapshotCalls()
	want := []string{"start:" + container, "stop:" + container, "start:" + container}
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
