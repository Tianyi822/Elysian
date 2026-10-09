// 装载生命周期的测试：注入就绪、配置更新、销毁回收与事件钩子不泄漏。
package tools

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/kardia"
)

// demoCapability 是一个假能力插件：注入注册表、登记一条描述符、挂一个清理 effect。
type demoCapability struct {
	name       string
	registered atomic.Int32
	cleaned    atomic.Int32
	failApply  error
}

func (d *demoCapability) plugin() *kardia.Plugin {
	return &kardia.Plugin{
		Name:   "demo-capability",
		Inject: kardia.InjectMap{ServiceName: nil},
		Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
			if d.failApply != nil {
				return nil, d.failApply
			}
			registry, err := RegistryFrom(c)
			if err != nil {
				return nil, err
			}
			dispose, err := registry.Register(Descriptor{
				Name:        d.name,
				Description: "演示能力提供的工具",
				Parameters:  Schema{Type: SchemaObject},
				Handler:     func(*kardia.Context, Arguments) (any, error) { return "demo", nil },
			})
			if err != nil {
				return nil, err
			}
			if _, err := c.Effect("demo.cleanup", func() (kardia.Disposable, error) {
				return func(context.Context) error {
					d.cleaned.Add(1)
					return nil
				}, nil
			}); err != nil {
				return nil, err
			}
			d.registered.Add(1)
			return dispose, nil
		},
	}
}

func TestInstallWaitsForInjectReadiness(t *testing.T) {
	root := kardia.NewContext()
	demo := &demoCapability{name: "demo_tool"}

	fibers, err := Install(context.Background(), root, Plugin, demo.plugin())
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	if len(fibers) != 2 {
		t.Fatalf("应返回两条 fiber：%d", len(fibers))
	}
	if demo.registered.Load() != 1 {
		t.Fatalf("能力应在注入就绪后完成注册：%d", demo.registered.Load())
	}
	registry, err := RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}
	if list := registry.List(); len(list) != 1 || list[0].Name != "demo_tool" {
		t.Fatalf("描述符未登记：%v", list)
	}
	if _, err := registry.Execute(root, "demo_tool", nil); err != nil {
		t.Fatalf("执行演示工具失败：%v", err)
	}
}

func TestInstallRollsBackOnApplyError(t *testing.T) {
	root := kardia.NewContext()
	demo := &demoCapability{name: "demo_tool"}
	sentinel := errors.New("能力构造失败")
	failing := &kardia.Plugin{
		Name:  "failing-capability",
		Apply: func(*kardia.Context, any) (kardia.Disposable, error) { return nil, sentinel },
	}

	fibers, err := Install(context.Background(), root, Plugin, demo.plugin(), failing)
	if err == nil {
		t.Fatal("Apply 失败应经 Await 穿透给调用方")
	}
	if !strings.Contains(err.Error(), sentinel.Error()) {
		t.Fatalf("错误应包含原始原因：%v", err)
	}
	if len(fibers) != 0 {
		t.Fatalf("失败时不应留下已装载的 fiber：%d", len(fibers))
	}
	if demo.cleaned.Load() != 1 {
		t.Fatalf("回滚应清理已成功的能力：%d", demo.cleaned.Load())
	}
	if root.Registry().Size() != 0 {
		t.Fatalf("回滚后注册表应清空：%d", root.Registry().Size())
	}
}

func TestDisposeUnregistersCapabilityAndEffects(t *testing.T) {
	root := kardia.NewContext()
	demo := &demoCapability{name: "demo_tool"}
	fibers, err := Install(context.Background(), root, Plugin, demo.plugin())
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	registry, err := RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}

	if err := fibers[1].Dispose(context.Background()); err != nil {
		t.Fatalf("销毁能力失败：%v", err)
	}
	if len(registry.List()) != 0 {
		t.Fatalf("能力销毁后描述符应撤销：%v", registry.List())
	}
	if demo.cleaned.Load() != 1 {
		t.Fatalf("effect 清理应被执行：%d", demo.cleaned.Load())
	}
	if _, err := RegistryFrom(root); err != nil {
		t.Fatalf("注册表应仍然可用：%v", err)
	}

	if err := fibers[0].Dispose(context.Background()); err != nil {
		t.Fatalf("销毁注册表失败：%v", err)
	}
	if _, err := RegistryFrom(root); err == nil {
		t.Fatal("注册表销毁后应取不到服务")
	}
	if size := root.Registry().Size(); size != 0 {
		t.Fatalf("全部销毁后 kardia 注册表应清空，实际 %d", size)
	}
}

func TestUpdateRerunsApplyWithoutDuplicating(t *testing.T) {
	root := kardia.NewContext()
	demo := &demoCapability{name: "demo_tool"}
	fibers, err := Install(context.Background(), root, Plugin, demo.plugin())
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	registry, err := RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}

	if err := fibers[1].Update(context.Background(), nil, false); err != nil {
		t.Fatalf("更新配置失败：%v", err)
	}
	if demo.registered.Load() != 2 {
		t.Fatalf("更新应重跑一次 Apply：%d", demo.registered.Load())
	}
	if demo.cleaned.Load() != 1 {
		t.Fatalf("更新应先清理上一代：%d", demo.cleaned.Load())
	}
	if list := registry.List(); len(list) != 1 {
		t.Fatalf("更新后描述符不得重复：%v", list)
	}
}

func TestHookSnapshotHasNoLeak(t *testing.T) {
	root := kardia.NewContext()
	baseline := root.Events().HookSnapshot()
	demo := &demoCapability{name: "demo_tool"}
	fibers, err := Install(context.Background(), root, Plugin, demo.plugin())
	if err != nil {
		t.Fatalf("装载失败：%v", err)
	}
	unsubscribe, err := root.On(EventChange, func(*kardia.EventCtx) (any, error) { return nil, nil })
	if err != nil {
		t.Fatalf("登记监听器失败：%v", err)
	}
	if _, err := registryOf(t, root).Execute(root, "demo_tool", nil); err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	unsubscribe()

	for _, fiber := range fibers {
		if err := fiber.Dispose(context.Background()); err != nil {
			t.Fatalf("销毁失败：%v", err)
		}
	}
	if got := root.Events().HookSnapshot(); len(got) != len(baseline) {
		t.Fatalf("销毁后事件钩子应回到基线：基线 %v，实际 %v", baseline, got)
	}
}

// registryOf 从根 ctx 取注册表，失败即终止用例。
func registryOf(t *testing.T, root *kardia.Context) *Registry {
	t.Helper()
	registry, err := RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}
	return registry
}
