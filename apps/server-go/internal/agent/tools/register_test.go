// 批量登记的测试：成功路径挂 effect、失败路径回滚。
package tools

import (
	"context"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
)

func TestRegisterAllHooksDisposalOnFiber(t *testing.T) {
	root := kardia.NewContext()
	var registered *Registry
	capability := &kardia.Plugin{
		Name:   "register-all-demo",
		Inject: kardia.InjectMap{ServiceName: nil},
		Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
			registry, err := RegistryFrom(c)
			if err != nil {
				return nil, err
			}
			registered = registry
			return nil, RegisterAll(c,
				echoDescriptor("first_tool", 1),
				echoDescriptor("second_tool", 2),
			)
		},
	}

	fibers, err := Install(context.Background(), root, Plugin, capability)
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	if got := registered.Size(); got != 2 {
		t.Fatalf("应登记两条，实际 %d", got)
	}

	if err := fibers[1].Dispose(context.Background()); err != nil {
		t.Fatalf("销毁能力失败：%v", err)
	}
	if got := registered.Size(); got != 0 {
		t.Fatalf("能力销毁后应清空，实际 %d", got)
	}
}

func TestRegisterAllRollsBackOnFailure(t *testing.T) {
	root := kardia.NewContext()
	var registered *Registry
	capability := &kardia.Plugin{
		Name:   "rollback-demo",
		Inject: kardia.InjectMap{ServiceName: nil},
		Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
			registry, err := RegistryFrom(c)
			if err != nil {
				return nil, err
			}
			registered = registry
			return nil, RegisterAll(c,
				echoDescriptor("kept_tool", 1),
				echoDescriptor("kept_tool", 2), // 重名，触发回滚
			)
		},
	}

	_, err := Install(context.Background(), root, Plugin, capability)
	if err == nil {
		t.Fatal("重名登记应让装载失败")
	}
	if !strings.Contains(err.Error(), "已注册") {
		t.Fatalf("错误应说明重名：%v", err)
	}
	if got := registered.Size(); got != 0 {
		t.Fatalf("回滚后不应留下半张表，实际 %d", got)
	}
}

func TestRegisterAllFailsWithoutRegistry(t *testing.T) {
	root := kardia.NewContext()
	t.Cleanup(func() { _ = root.Fiber().Dispose(context.Background()) })

	err := RegisterAll(root, echoDescriptor("orphan_tool", 1))
	if err == nil || !strings.Contains(err.Error(), "未提供") {
		t.Fatalf("注册表缺失时应失败闭合，实际：%v", err)
	}
	if err := RegisterAll(nil); err == nil {
		t.Fatal("空 Context 应失败闭合")
	}
}
