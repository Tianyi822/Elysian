// 泛型取值与失败闭合的测试。
package tools

import (
	"context"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
)

func TestUseReturnsTypedService(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	got, err := Use[*Registry](root, ServiceName)
	if err != nil {
		t.Fatalf("取值失败：%v", err)
	}
	if got != registry {
		t.Fatal("取到的应是同一个注册表实例")
	}
}

func TestUseFailsClosedOnMissingService(t *testing.T) {
	root := kardia.NewContext()
	t.Cleanup(func() { _ = root.Fiber().Dispose(context.Background()) })

	_, err := Use[*Registry](root, ServiceName)
	if err == nil || !strings.Contains(err.Error(), "未提供") {
		t.Fatalf("未提供时应失败闭合，实际：%v", err)
	}
	if _, err := RegistryFrom(root); err == nil {
		t.Fatal("RegistryFrom 同样应失败")
	}
}

func TestUseFailsClosedOnTypeMismatch(t *testing.T) {
	root, _, _ := newRegistryCtx(t)

	_, err := Use[*deniedProbe](root, ServiceName)
	if err == nil || !strings.Contains(err.Error(), "类型不符") {
		t.Fatalf("类型不符应失败闭合，实际：%v", err)
	}
}

// deniedProbe 只是另一种类型，用于触发类型不符分支。
type deniedProbe struct{}
