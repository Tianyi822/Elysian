// loader_test.go 是自建测试（无一一对应的 TS spec）：EntryTree/Entry/Group/
// Loader 子集行为——注册表 Import、id 复合解析、commit 报告、update 三步、
// internal/plugin 七案例的自销毁路径、Reparent/PatchContext 与失败条目的
// fiber 状态。场景取自 loader/tests/{index,group,commit} 的可移植部分反推
// （Node 模块加载与 intercept 配置用例不在移植范围，见 localGaps）。
package loader

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/agent/kardia"
)

// —— 测试插件与计数 ——

var (
	countsMu   sync.Mutex
	applied    = map[string]int{}
	disposals  = map[string]int{}
	pluginsOne sync.Once
)

func noteApplied(name string) {
	countsMu.Lock()
	applied[name]++
	countsMu.Unlock()
}

func noteDisposed(name string) {
	countsMu.Lock()
	disposals[name]++
	countsMu.Unlock()
}

func resetCounts() {
	countsMu.Lock()
	applied = map[string]int{}
	disposals = map[string]int{}
	countsMu.Unlock()
}

// snapshotCounts 返回计数快照。返回值不得命名为 applied/disposals——
// 会遮蔽同名包级计数表，使快照恒为空（曾致组生命周期用例误报装载 0 次）。
func snapshotCounts() (appliedNow, disposedNow map[string]int) {
	countsMu.Lock()
	defer countsMu.Unlock()
	a := make(map[string]int, len(applied))
	for k, v := range applied {
		a[k] = v
	}
	d := make(map[string]int, len(disposals))
	for k, v := range disposals {
		d[k] = v
	}
	return a, d
}

func registerLoaderTestPlugins() {
	pluginsOne.Do(func() {
		RegisterFunc("foo", func(ctx *kardia.Context, config any) (kardia.Disposable, error) {
			noteApplied("foo")
			return func(context.Context) error {
				noteDisposed("foo")
				return nil
			}, nil
		})
		RegisterFunc("bad", func(ctx *kardia.Context, config any) (kardia.Disposable, error) {
			return nil, errors.New("boom")
		})
		// 对应 commit.spec #19：插件内创建子 fiber 并立即销毁，不应误判为
		// 条目自销毁
		RegisterFunc("parent", func(ctx *kardia.Context, config any) (kardia.Disposable, error) {
			child, err := ctx.Plugin(&kardia.Plugin{Name: "child", Apply: func(*kardia.Context, any) (kardia.Disposable, error) {
				return nil, nil
			}}, nil)
			if err == nil {
				_ = child.Dispose(context.Background())
			}
			return nil, nil
		})
		Register("@cordisjs/plugin-group", Group)
	})
}

// bootLoader 起根 ctx 并装载 loader（MockLoader 的最小等价）。
func bootLoader(t *testing.T) (*kardia.Context, *Loader, *kardia.Fiber) {
	t.Helper()
	registerLoaderTestPlugins()
	ctx := kardia.NewContext()
	fiber, err := ctx.Plugin(Plugin, nil)
	if err != nil {
		t.Fatalf("装载 loader 插件失败：%v", err)
	}
	// fiber 的加载在 goroutine 中异步执行，Provide 尚未落盘时 Get 走
	// loose 路径静默返回 nil；先等惯性排空再取服务（timer 测试同法）。
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatalf("等待 loader 插件激活失败：%v", err)
	}
	lv, err := ctx.Get("loader")
	if err != nil {
		t.Fatalf("解析 loader 服务失败：%v", err)
	}
	l, ok := lv.(*Loader)
	if !ok {
		t.Fatalf("loader 服务类型异常：%T", lv)
	}
	t.Cleanup(func() { _ = fiber.Dispose(context.Background()) })
	return ctx, l, fiber
}

func settleTree(t *testing.T, ctx *kardia.Context, l *Loader) {
	t.Helper()
	if err := l.Await(context.Background()); err != nil {
		t.Fatalf("等待树任务失败：%v", err)
	}
	if err := ctx.Tasks().Wait(context.Background()); err != nil {
		t.Fatalf("等待框架任务失败：%v", err)
	}
}

// —— 注册表与 id ——

func TestRegistryLookupAndImport(t *testing.T) {
	registerLoaderTestPlugins()
	if _, ok := Lookup("foo"); !ok {
		t.Fatal("已注册插件应可查到")
	}
	ctx := kardia.NewContext()
	l := NewTree(ctx.Extend(kardia.ExtendMeta{}))
	if _, err := l.Import("nonexistent-plugin"); err == nil || !strings.Contains(err.Error(), "尚未注册") {
		t.Fatalf("未注册插件应报中文错误，实际 %v", err)
	}
	if p, err := l.Import("foo"); err != nil || p == nil {
		t.Fatalf("已注册插件应可导入，实际 (%v, %v)", p, err)
	}
}

func TestEnsureID(t *testing.T) {
	_, l, _ := bootLoader(t)
	hex8 := regexp.MustCompile(`^[0-9a-f]{8}$`)
	seen := map[string]bool{}
	for i := 0; i < 64; i++ {
		id := l.EnsureID(&EntryOptions{})
		if !hex8.MatchString(id) {
			t.Fatalf("id 应为 8 位 hex，实际 %q", id)
		}
		if seen[id] {
			t.Fatalf("id %q 重复", id)
		}
		seen[id] = true
	}
	if got := l.EnsureID(&EntryOptions{ID: "keep"}); got != "keep" {
		t.Fatalf("既有 id 应保留，实际 %q", got)
	}
}

// —— 复合 id 解析 ——

func TestResolveCompositeAndResolveGroup(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	gID, err := l.Create(context.Background(), EntryOptions{
		Name: "@cordisjs/plugin-group", Group: boolPtr(true), Config: []*EntryOptions{},
	}, nil, 0)
	if err != nil {
		t.Fatalf("创建组失败：%v", err)
	}
	settleTree(t, ctx, l)
	g, err := l.Resolve(gID)
	if err != nil {
		t.Fatalf("解析组失败：%v", err)
	}
	if g.Subgroup() == nil {
		t.Fatal("组条目应有成员组")
	}

	// 手工挂子树（include 交付后由其建树；此处直接验证复合解析）。子树的
	// ctx 须挂在组条目的 ctx 链下（include 的真实挂法）：Entry.ID 的父前缀
	// 经树 ctx 沿链查 EntryKey（entry.ts:56-62 的 ctx.fiber.entry 同构），
	// 挂在 root 链上取不到前缀。
	sub := NewTree(g.Ctx.Extend(kardia.ExtendMeta{}))
	subID, err := sub.Create(context.Background(), EntryOptions{Name: "foo"}, nil, 0)
	if err != nil {
		t.Fatalf("创建子树条目失败：%v", err)
	}
	// NewTree 已登记子树

	// sub.Create 返回的已是复合 id（entry.id 的父前缀语义，TS 的
	// tree.create → group.create → entry.id 同构）；直接以其解析与断言，
	// 再拼一层 gID 会造成双前缀。
	got, err := l.Resolve(subID)
	if err != nil {
		t.Fatalf("复合 id 应可解析：%v", err)
	}
	if got.ID() != subID {
		t.Fatalf("复合 id 应带父前缀，实际 %q", got.ID())
	}
	if _, err := l.Resolve(gID + ":nope"); err == nil || !strings.Contains(err.Error(), "无法解析条目") {
		t.Fatalf("缺失条目应报中文错误，实际 %v", err)
	}
	if _, err := l.ResolveGroup(sptrLocal(subID)); err == nil || !strings.Contains(err.Error(), "不是组") {
		t.Fatalf("非组条目应报中文错误，实际 %v", err)
	}
	if group, err := l.ResolveGroup(sptrLocal(gID)); err != nil || group != g.Subgroup() {
		t.Fatalf("组 id 应解析到其成员组，实际 (%v, %v)", group, err)
	}
	if group, err := l.ResolveGroup(nil); err != nil || group != l.Root {
		t.Fatalf("nil 应解析到根组，实际 (%v, %v)", group, err)
	}
}

// —— commit 报告（commit.spec 的可移植核心）——

type changeLog struct {
	mu      sync.Mutex
	changes []EntryChange
}

func (c *changeLog) record(change EntryChange) {
	c.mu.Lock()
	c.changes = append(c.changes, change)
	c.mu.Unlock()
}

func (c *changeLog) take() []EntryChange {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := append([]EntryChange(nil), c.changes...)
	c.changes = nil
	return out
}

func TestCommitReportsCreateUpdateMoveRemove(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	log := &changeLog{}
	l.SetCommit(log.record)

	id, err := l.Create(context.Background(), EntryOptions{Name: "foo", Config: map[string]any{"a": 1}}, nil, 0)
	if err != nil {
		t.Fatalf("创建条目失败：%v", err)
	}
	settleTree(t, ctx, l)

	// 创建：报告 created（legacy 缺失、options 是不可变快照）
	changes := log.take()
	if len(changes) != 1 {
		t.Fatalf("创建应报告一条变更，实际 %d 条", len(changes))
	}
	create := changes[0]
	if create.ID != id || create.Group != l.Root || create.Legacy != nil {
		t.Fatalf("创建报告字段异常：%+v", create)
	}
	if !OptionsEqual(create.Options, l.Entry(id).Options()) {
		t.Fatal("创建报告的 options 应与 store 内条目内容一致且为快照")
	}
	if len(l.Root.Data()) != 1 || !OptionsEqual(l.Root.Data()[0], create.Options) {
		t.Fatal("根组数据应包含创建的条目")
	}

	// 更新：报告新旧配置
	if err := l.Update(context.Background(), id, PatchOptions(EntryOptions{Config: map[string]any{"a": 2}}), nil, nil); err != nil {
		t.Fatalf("更新条目失败：%v", err)
	}
	settleTree(t, ctx, l)
	changes = log.take()
	if len(changes) != 1 {
		t.Fatalf("更新应报告一条变更，实际 %d 条", len(changes))
	}
	update := changes[0]
	if update.From != nil {
		t.Fatal("原地更新不应报告迁移")
	}
	if av, _ := GetKey(update.Legacy, "config"); !deepValueEqual(av, map[string]any{"a": 1}) {
		t.Fatalf("legacy 应持旧配置，实际 %v", av)
	}
	if av, _ := GetKey(update.Options, "config"); !deepValueEqual(av, map[string]any{"a": 2}) {
		t.Fatalf("options 应持新配置，实际 %v", av)
	}

	// 组内迁移：报告目标组与来源组
	gID, err := l.Create(context.Background(), EntryOptions{Name: "@cordisjs/plugin-group", Group: boolPtr(true), Config: []*EntryOptions{}}, nil, 0)
	if err != nil {
		t.Fatalf("创建组失败：%v", err)
	}
	settleTree(t, ctx, l)
	log.take()
	if err := l.Update(context.Background(), id, PatchOptions(EntryOptions{}), sptrLocal(gID), nil); err != nil {
		t.Fatalf("迁移条目失败：%v", err)
	}
	settleTree(t, ctx, l)
	changes = log.take()
	if len(changes) != 1 {
		t.Fatalf("迁移应报告一条变更，实际 %d 条", len(changes))
	}
	move := changes[0]
	gEntry := l.Entry(gID)
	if move.Group != gEntry.Subgroup() || move.From != l.Root {
		t.Fatalf("迁移应报告目标成员组与来源根组，实际 (%v, %v)", move.Group, move.From)
	}

	// 插件内部更新 fiber 配置：经钩子 1 报告配置变更
	if err := l.Entry(id).Fiber().Update(context.Background(), map[string]any{"a": 5}, false); err != nil {
		t.Fatalf("fiber 更新失败：%v", err)
	}
	settleTree(t, ctx, l)
	changes = log.take()
	if len(changes) != 1 {
		t.Fatalf("fiber 配置更新应报告一条变更，实际 %d 条", len(changes))
	}
	if av, _ := GetKey(changes[0].Legacy, "config"); !deepValueEqual(av, map[string]any{"a": 2}) {
		t.Fatalf("fiber 更新的 legacy 应持旧配置，实际 %v", av)
	}
	if av, _ := GetKey(changes[0].Options, "config"); !deepValueEqual(av, map[string]any{"a": 5}) {
		t.Fatalf("fiber 更新的 options 应持新配置，实际 %v", av)
	}

	// 移除：报告 legacy、无 options、store 除名
	l.Remove(context.Background(), id)
	settleTree(t, ctx, l)
	changes = log.take()
	if len(changes) != 1 {
		t.Fatalf("移除应报告一条变更，实际 %d 条", len(changes))
	}
	remove := changes[0]
	if remove.Options != nil || remove.Legacy == nil || remove.Legacy.Name != "foo" {
		t.Fatalf("移除报告字段异常：%+v", remove)
	}
	if l.Entry(id) != nil {
		t.Fatal("移除后条目应出 store")
	}
}

// —— internal/plugin 自销毁检测 ——

func TestSelfDisposeMarksDisabled(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	log := &changeLog{}
	l.SetCommit(log.record)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo"}, nil, 0)
	if err != nil {
		t.Fatalf("创建条目失败：%v", err)
	}
	settleTree(t, ctx, l)
	log.take()

	// 自销毁：ctx.fiber.dispose() → internal/plugin → 标记 disabled 并报告
	if err := l.Entry(id).Fiber().Dispose(context.Background()); err != nil {
		t.Fatalf("自销毁失败：%v", err)
	}
	settleTree(t, ctx, l)
	changes := log.take()
	if len(changes) != 1 {
		t.Fatalf("自销毁应报告一条变更，实际 %d 条", len(changes))
	}
	if changes[0].Options == nil || changes[0].Options.Disabled == nil || !*changes[0].Options.Disabled {
		t.Fatalf("自销毁应把条目标记为 disabled，实际 %+v", changes[0].Options)
	}
}

func TestChildFiberDisposeIgnored(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	log := &changeLog{}
	l.SetCommit(log.record)
	id, err := l.Create(context.Background(), EntryOptions{Name: "parent"}, nil, 0)
	if err != nil {
		t.Fatalf("创建条目失败：%v", err)
	}
	// Create 自身会报告一条变更（tree.ts:98 的 create commit），先清零，
	// 后面只统计子 fiber 销毁是否引发变更。
	log.take()
	settleTree(t, ctx, l)
	if l.Entry(id).Fiber() == nil {
		t.Fatal("条目应有 fiber")
	}
	if changes := log.take(); len(changes) != 0 {
		t.Fatalf("子 fiber 销毁不应触发条目变更，实际 %d 条", len(changes))
	}
	if l.Entry(id).Options().Disabled != nil {
		t.Fatal("子 fiber 销毁不应禁用条目")
	}
	l.Remove(context.Background(), id)
	settleTree(t, ctx, l)
}

func TestLoaderRemoveDoesNotMarkDisabled(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	log := &changeLog{}
	l.SetCommit(log.record)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo"}, nil, 0)
	if err != nil {
		t.Fatalf("创建条目失败：%v", err)
	}
	settleTree(t, ctx, l)
	log.take()

	l.Remove(context.Background(), id)
	settleTree(t, ctx, l)
	// loader 主动移除：只有树侧的移除报告，没有 disabled 标记
	for _, change := range log.take() {
		if change.Options != nil && change.Options.Disabled != nil {
			t.Fatalf("loader 移除不应标记 disabled：%+v", change)
		}
	}
}

// —— 组生命周期（group.spec basic/transfer 的可移植部分）——

func TestGroupBasicLifecycle(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	// 计数是跨用例的全局表，先清零再统计本用例的装载
	resetCounts()
	outer, err := l.Create(context.Background(), EntryOptions{
		Name: "@cordisjs/plugin-group", Group: boolPtr(true),
		Config: []*EntryOptions{{Name: "foo"}},
	}, nil, 0)
	if err != nil {
		t.Fatalf("创建外层组失败：%v", err)
	}
	inner, err := l.Create(context.Background(), EntryOptions{
		Name: "@cordisjs/plugin-group", Group: boolPtr(true),
		Config: []*EntryOptions{{Name: "foo"}},
	}, sptrLocal(outer), 0)
	if err != nil {
		t.Fatalf("创建内层组失败：%v", err)
	}
	settleTree(t, ctx, l)
	if got := len(l.Entries()); got != 4 {
		t.Fatalf("嵌套组应有 4 个条目，实际 %d", got)
	}
	appliedCount, disposedCount := func() (int, int) {
		a, d := snapshotCounts()
		return a["foo"], d["foo"]
	}()
	if appliedCount != 2 || disposedCount != 0 {
		t.Fatalf("初始化应装载 foo 两次，实际 (applied=%d, disposed=%d)", appliedCount, disposedCount)
	}

	// 禁用内层：其成员随之卸载
	resetCounts()
	if err := l.Update(context.Background(), inner, PatchOptions(EntryOptions{Disabled: boolPtr(true)}), nil, nil); err != nil {
		t.Fatalf("禁用内层组失败：%v", err)
	}
	settleTree(t, ctx, l)
	a, d := snapshotCounts()
	if a["foo"] != 0 || d["foo"] != 1 {
		t.Fatalf("禁用内层应卸载一个 foo，实际 (applied=%d, disposed=%d)", a["foo"], d["foo"])
	}

	// 禁用外层：外层成员卸载，内层成员保持已卸载
	resetCounts()
	if err := l.Update(context.Background(), outer, PatchOptions(EntryOptions{Disabled: boolPtr(true)}), nil, nil); err != nil {
		t.Fatalf("禁用外层组失败：%v", err)
	}
	settleTree(t, ctx, l)
	a, d = snapshotCounts()
	if a["foo"] != 0 || d["foo"] != 1 {
		t.Fatalf("禁用外层应卸载一个 foo，实际 (applied=%d, disposed=%d)", a["foo"], d["foo"])
	}

	// 恢复内层：外层仍禁用，成员保持已卸载
	resetCounts()
	if err := l.Update(context.Background(), inner, PatchOptions(EntryOptions{Extras: map[string]any{"disabled": nil}}), nil, nil); err != nil {
		t.Fatalf("恢复内层组失败：%v", err)
	}
	settleTree(t, ctx, l)
	a, d = snapshotCounts()
	if a["foo"] != 0 || d["foo"] != 0 {
		t.Fatalf("外层禁用时恢复内层不应装载，实际 (applied=%d, disposed=%d)", a["foo"], d["foo"])
	}

	// 恢复外层：两级成员一起回来
	resetCounts()
	if err := l.Update(context.Background(), outer, PatchOptions(EntryOptions{Extras: map[string]any{"disabled": nil}}), nil, nil); err != nil {
		t.Fatalf("恢复外层组失败：%v", err)
	}
	settleTree(t, ctx, l)
	a, d = snapshotCounts()
	if a["foo"] != 2 || d["foo"] != 0 {
		t.Fatalf("恢复外层应重新装载两个 foo，实际 (applied=%d, disposed=%d)", a["foo"], d["foo"])
	}
	if got := len(l.Entries()); got != 4 {
		t.Fatalf("条目数应保持 4，实际 %d", got)
	}
}

func TestGroupTransfer(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	// 计数是跨用例的全局表，先清零再统计本用例的装载
	resetCounts()
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo"}, nil, 0)
	if err != nil {
		t.Fatalf("创建条目失败：%v", err)
	}
	groupOpts := func() EntryOptions {
		return EntryOptions{Name: "@cordisjs/plugin-group", Group: boolPtr(true), Config: []*EntryOptions{}}
	}
	alpha, err := l.Create(context.Background(), groupOpts(), nil, 0)
	if err != nil {
		t.Fatalf("创建 alpha 失败：%v", err)
	}
	betaOpts := groupOpts()
	betaOpts.Disabled = boolPtr(true)
	beta, err := l.Create(context.Background(), betaOpts, sptrLocal(alpha), 0)
	if err != nil {
		t.Fatalf("创建 beta 失败：%v", err)
	}
	gamma, err := l.Create(context.Background(), groupOpts(), sptrLocal(beta), 0)
	if err != nil {
		t.Fatalf("创建 gamma 失败：%v", err)
	}
	settleTree(t, ctx, l)
	if a, _ := snapshotCounts(); a["foo"] != 1 {
		t.Fatalf("初始化应装载 foo 一次，实际 %d", a["foo"])
	}

	// enabled → enabled：不重启不卸载
	resetCounts()
	if err := l.Update(context.Background(), id, PatchOptions(EntryOptions{}), sptrLocal(alpha), nil); err != nil {
		t.Fatalf("迁移到 alpha 失败：%v", err)
	}
	settleTree(t, ctx, l)
	if a, d := snapshotCounts(); a["foo"] != 0 || d["foo"] != 0 {
		t.Fatalf("enabled→enabled 不应影响插件，实际 (applied=%d, disposed=%d)", a["foo"], d["foo"])
	}

	// enabled → disabled：卸载
	resetCounts()
	if err := l.Update(context.Background(), id, PatchOptions(EntryOptions{}), sptrLocal(beta), nil); err != nil {
		t.Fatalf("迁移到 beta 失败：%v", err)
	}
	settleTree(t, ctx, l)
	if a, d := snapshotCounts(); a["foo"] != 0 || d["foo"] != 1 {
		t.Fatalf("enabled→disabled 应卸载，实际 (applied=%d, disposed=%d)", a["foo"], d["foo"])
	}

	// disabled → disabled（外层仍禁用）：无事发生
	resetCounts()
	if err := l.Update(context.Background(), id, PatchOptions(EntryOptions{}), sptrLocal(gamma), nil); err != nil {
		t.Fatalf("迁移到 gamma 失败：%v", err)
	}
	settleTree(t, ctx, l)
	if a, d := snapshotCounts(); a["foo"] != 0 || d["foo"] != 0 {
		t.Fatalf("disabled→disabled 不应装载，实际 (applied=%d, disposed=%d)", a["foo"], d["foo"])
	}

	// disabled → enabled：重新装载
	resetCounts()
	root := ""
	if err := l.Update(context.Background(), id, PatchOptions(EntryOptions{}), &root, nil); err != nil {
		t.Fatalf("迁回根失败：%v", err)
	}
	settleTree(t, ctx, l)
	if a, d := snapshotCounts(); a["foo"] != 1 || d["foo"] != 0 {
		t.Fatalf("disabled→enabled 应重新装载，实际 (applied=%d, disposed=%d)", a["foo"], d["foo"])
	}
}

// —— Reparent / PatchContext ——

func TestPatchContextReparentsEntryCtx(t *testing.T) {
	ctx, l, loaderFiber := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo"}, nil, 0)
	if err != nil {
		t.Fatalf("创建条目失败：%v", err)
	}
	settleTree(t, ctx, l)
	if got := l.Entry(id).Ctx.Fiber(); got != loaderFiber {
		t.Fatalf("初始条目 ctx 应挂在 loader fiber 下，实际 %v", got)
	}

	gID, err := l.Create(context.Background(), EntryOptions{Name: "@cordisjs/plugin-group", Group: boolPtr(true), Config: []*EntryOptions{}}, nil, 0)
	if err != nil {
		t.Fatalf("创建组失败：%v", err)
	}
	settleTree(t, ctx, l)
	if err := l.Update(context.Background(), id, PatchOptions(EntryOptions{}), sptrLocal(gID), nil); err != nil {
		t.Fatalf("迁移条目失败：%v", err)
	}
	settleTree(t, ctx, l)
	gFiber := l.Entry(gID).Fiber()
	if gFiber == nil {
		t.Fatal("组条目应有 fiber")
	}
	if got := l.Entry(id).Ctx.Fiber(); got != gFiber {
		t.Fatalf("迁移后条目 ctx 应挂在组 fiber 下，实际 %v", got)
	}
}

// —— 失败条目由 fiber 状态上报 ——

func TestFailingEntryReportedByFiber(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	err := l.Root.Update(context.Background(), []*EntryOptions{
		{ID: "1", Name: "bad"},
		{ID: "2", Name: "foo"},
	})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("失败插件应经返回错误报告：%v", err)
	}
	if err := l.Await(context.Background()); err != nil {
		t.Fatalf("失败条目不应让树等待出错：%v", err)
	}
	settleTree(t, ctx, l)
	if state := l.Entry("1").Fiber().State(); state != kardia.FiberFailed {
		t.Fatalf("失败条目应为 FAILED，实际 %s", state)
	}
	if state := l.Entry("2").Fiber().State(); state != kardia.FiberActive {
		t.Fatalf("正常条目应为 ACTIVE，实际 %s", state)
	}

	// 配置更新失败同时通过返回值与 fiber 状态报告。
	if err := l.Root.Update(context.Background(), []*EntryOptions{
		{ID: "1", Name: "bad", Config: map[string]any{"a": 1}},
		{ID: "2", Name: "foo"},
	}); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("更新失败应经返回错误报告：%v", err)
	}
	settleTree(t, ctx, l)
	if state := l.Entry("1").Fiber().State(); state != kardia.FiberFailed {
		t.Fatalf("更新后失败条目应保持 FAILED，实际 %s", state)
	}
}

// TestEntryInjectMerge 对应 index.ts:90-96 的 Inject.resolve 合并：条目
// 配置里的 inject 声明并入条目 fiber 的注入表——依赖未提供时 fiber 保持
// pending（合并不生效则 foo 插件无静态注入、直接激活），提供后经
// reflect.Notify 刷新激活。
func TestEntryInjectMerge(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{
		Name:   "foo",
		Inject: kardia.InjectMap{"dep": nil},
	}, nil, 0)
	if err != nil {
		t.Fatalf("创建条目失败：%v", err)
	}
	settleTree(t, ctx, l)
	entry, err := l.Resolve(id)
	if err != nil {
		t.Fatalf("解析条目失败：%v", err)
	}
	if _, ok := entry.Fiber().Inject()["dep"]; !ok {
		t.Fatal("条目声明的注入键应并入 fiber 的注入表")
	}
	if state := entry.Fiber().State(); state != kardia.FiberPending {
		t.Fatalf("依赖未提供时条目 fiber 应保持 pending，实际 %s", state)
	}
	// 注入等待的是「dep 服务被提供」（插件名不等于服务名）：dep 插件的
	// Apply 内 provide "dep"；其加载在 goroutine 中，先等 dep fiber 惯性
	// 排空（provide 与 Notify 随之完成），再等树收敛。
	depFiber, err := ctx.Plugin(&kardia.Plugin{Name: "dep", Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		d, perr := c.Provide("dep", true, nil)
		if perr != nil {
			return nil, perr
		}
		return d, nil
	}}, nil)
	if err != nil {
		t.Fatalf("提供依赖失败：%v", err)
	}
	if _, err := depFiber.Await(context.Background()); err != nil {
		t.Fatalf("等待 dep 插件激活失败：%v", err)
	}
	settleTree(t, ctx, l)
	if state := entry.Fiber().State(); state != kardia.FiberActive {
		t.Fatalf("依赖提供后条目 fiber 应激活，实际 %s", state)
	}
}

// —— 测试辅助 ——

func sptrLocal(s string) *string { return &s }

func boolPtr(b bool) *bool { return &b }
