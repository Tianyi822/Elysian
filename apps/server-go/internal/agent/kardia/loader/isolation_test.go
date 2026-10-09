package loader

import (
	"context"
	"elysian/server/internal/agent/kardia"
	"sync/atomic"
	"testing"
)

func TestLoaderIsolationAndProviderRelocation(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	var applied, disposed atomic.Int32
	RegisterFunc("isolation-provider", func(c *kardia.Context, cfg any) (kardia.Disposable, error) {
		return c.Provide("isolated-dep", cfg, nil)
	})
	Register("isolation-consumer", &kardia.Plugin{Name: "isolation-consumer", Inject: kardia.InjectMap{"isolated-dep": nil}, Apply: func(*kardia.Context, any) (kardia.Disposable, error) {
		applied.Add(1)
		return func(context.Context) error { disposed.Add(1); return nil }, nil
	}})
	create := func(o EntryOptions, parent *string) string {
		t.Helper()
		id, err := l.Create(context.Background(), o, parent, -1)
		if err != nil {
			t.Fatal(err)
		}
		settleTree(t, ctx, l)
		return id
	}
	update := func(id string, p EntryPatch, parent *string) {
		t.Helper()
		if err := l.Update(context.Background(), id, p, parent, nil); err != nil {
			t.Fatal(err)
		}
		settleTree(t, ctx, l)
	}
	provider := create(EntryOptions{Name: "isolation-provider", Config: "root"}, nil)
	consumer := create(EntryOptions{Name: "isolation-consumer"}, nil)
	original := l.Entry(provider).Fiber()
	update(consumer, EntryPatch{Set: map[string]any{"isolate": map[string]any{"isolated-dep": true}}}, nil)
	if l.Entry(consumer).Fiber().State() != kardia.FiberPending || disposed.Load() != 1 {
		t.Fatal("消费者局部隔离应卸载并等待依赖")
	}
	update(consumer, EntryPatch{Unset: []string{"isolate"}}, nil)
	if l.Entry(consumer).Fiber().State() != kardia.FiberActive || applied.Load() != 2 {
		t.Fatal("取消消费者隔离应恢复")
	}
	update(provider, EntryPatch{Set: map[string]any{"isolate": map[string]any{"isolated-dep": "shared"}}}, nil)
	if l.Entry(provider).Fiber() != original || l.Entry(consumer).Fiber().State() != kardia.FiberPending {
		t.Fatal("提供者隔离应迁移现有服务并刷新消费者")
	}
	update(consumer, EntryPatch{Set: map[string]any{"isolate": map[string]any{"isolated-dep": "shared"}}}, nil)
	if l.Entry(consumer).Fiber().State() != kardia.FiberActive {
		t.Fatal("同名隔离域应共享服务")
	}
	value, err := l.Entry(consumer).Fiber().Ctx().Get("isolated-dep")
	if err != nil || value != "root" {
		t.Fatalf("共享服务值异常：%v/%v", value, err)
	}
	if err := l.Remove(context.Background(), consumer); err != nil {
		t.Fatal(err)
	}
	if err := l.Remove(context.Background(), provider); err != nil {
		t.Fatal(err)
	}
	l.state.mu.RLock()
	realms := len(l.state.realms)
	l.state.mu.RUnlock()
	if realms != 0 {
		t.Fatalf("已移除条目的隔离域未回收：%d", realms)
	}
}
func TestLoaderGroupTransferRelocatesProvider(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	RegisterFunc("move-provider", func(c *kardia.Context, _ any) (kardia.Disposable, error) { return c.Provide("move-dep", true, nil) })
	Register("move-consumer", &kardia.Plugin{Name: "move-consumer", Inject: kardia.InjectMap{"move-dep": nil}, Apply: func(*kardia.Context, any) (kardia.Disposable, error) { return nil, nil }})
	group, err := l.Create(context.Background(), EntryOptions{Name: Group.Name, Group: boolPtr(true), Config: []*EntryOptions{}, Isolate: map[string]any{"move-dep": true}}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	provider, err := l.Create(context.Background(), EntryOptions{Name: "move-provider"}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	consumer, err := l.Create(context.Background(), EntryOptions{Name: "move-consumer"}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	original := l.Entry(provider).Fiber()
	if err := l.Update(context.Background(), consumer, EntryPatch{}, &group, nil); err != nil {
		t.Fatal(err)
	}
	settleTree(t, ctx, l)
	if l.Entry(consumer).Fiber().State() != kardia.FiberPending {
		t.Fatal("迁入隔离组后应等待提供者")
	}
	if err := l.Update(context.Background(), provider, EntryPatch{}, &group, nil); err != nil {
		t.Fatal(err)
	}
	settleTree(t, ctx, l)
	if l.Entry(provider).Fiber() != original || l.Entry(consumer).Fiber().State() != kardia.FiberActive {
		t.Fatal("提供者应原位重定位并激活消费者")
	}
	root := ""
	if err := l.Update(context.Background(), consumer, EntryPatch{}, &root, nil); err != nil {
		t.Fatal(err)
	}
	settleTree(t, ctx, l)
	if l.Entry(consumer).Fiber().State() != kardia.FiberPending {
		t.Fatal("迁出后不能读到组内服务")
	}
	if err := l.Update(context.Background(), provider, EntryPatch{}, &root, nil); err != nil {
		t.Fatal(err)
	}
	settleTree(t, ctx, l)
	if l.Entry(consumer).Fiber().State() != kardia.FiberActive {
		t.Fatal("提供者迁出后应激活根消费者")
	}
}
func TestLoaderInterceptionInheritance(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	group, err := l.Create(context.Background(), EntryOptions{Name: Group.Name, Group: boolPtr(true), Config: []*EntryOptions{}, Intercept: map[string]any{"probe": map[string]any{"outer": 1}}}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo", Intercept: map[string]any{"probe": map[string]any{"inner": 2}}}, &group, 0)
	if err != nil {
		t.Fatal(err)
	}
	all := l.Entry(id).Fiber().Ctx().InterceptAll("probe")
	if len(all) != 2 {
		t.Fatalf("应继承内外两层拦截：%v", all)
	}
	root := ""
	if err := l.Update(context.Background(), id, EntryPatch{}, &root, nil); err != nil {
		t.Fatal(err)
	}
	settleTree(t, ctx, l)
	all = l.Entry(id).Fiber().Ctx().InterceptAll("probe")
	if len(all) != 1 {
		t.Fatalf("迁出后不应保留旧祖先拦截：%v", all)
	}
}

func TestMovedEntrySurvivesFormerGroupDisposal(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	var applied, disposed atomic.Int32
	RegisterFunc("moving-lifetime", func(*kardia.Context, any) (kardia.Disposable, error) {
		applied.Add(1)
		return func(context.Context) error { disposed.Add(1); return nil }, nil
	})
	group, err := l.Create(context.Background(), EntryOptions{Name: Group.Name, Group: boolPtr(true), Config: []*EntryOptions{}}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	id, err := l.Create(context.Background(), EntryOptions{Name: "moving-lifetime"}, &group, 0)
	if err != nil {
		t.Fatal(err)
	}
	original := l.Entry(id).Fiber()
	root := ""
	if err := l.Update(context.Background(), id, EntryPatch{}, &root, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.Remove(context.Background(), group); err != nil {
		t.Fatal(err)
	}
	settleTree(t, ctx, l)
	if l.Entry(id).Fiber() != original || original.State() != kardia.FiberActive || applied.Load() != 1 || disposed.Load() != 0 {
		t.Fatalf("卸载原组不得影响已迁出插件：激活%d/清理%d/状态%s", applied.Load(), disposed.Load(), original.State())
	}
	if err := l.Remove(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	if disposed.Load() != 1 {
		t.Fatal("迁移后的插件仍应能独立清理一次")
	}
}
