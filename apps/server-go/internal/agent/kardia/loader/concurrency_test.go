package loader

import (
	"context"
	"elysian/server/internal/agent/kardia"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestNumericConfigEqualityAndDeepSnapshot(t *testing.T) {
	if !deepValueEqual(map[string]any{"n": int64(7)}, map[string]any{"n": float64(7)}) {
		t.Fatal("JSON 数值应与整数配置相等")
	}
	if deepValueEqual(uint64(9007199254740993), float64(9007199254740992)) {
		t.Fatal("大整数不得因浮点舍入误判相等")
	}
	if deepValueEqual(7, 7.5) {
		t.Fatal("不同数值不能相等")
	}
	original := &EntryOptions{Config: map[string]any{"nested": []any{map[string]any{"n": 1}}}, Inject: kardia.InjectMap{"dep": map[string]any{"a": 1}}}
	copied := CloneOptions(original)
	copied.Config.(map[string]any)["nested"].([]any)[0].(map[string]any)["n"] = 2
	copied.Inject["dep"].(map[string]any)["a"] = 2
	if original.Config.(map[string]any)["nested"].([]any)[0].(map[string]any)["n"] != 1 || original.Inject["dep"].(map[string]any)["a"] != 1 {
		t.Fatal("快照不得共享可变的接口嵌套值")
	}
}
func TestEntryPatchDistinguishesUnsetAndEmpty(t *testing.T) {
	_, l, _ := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo", Config: map[string]any{"a": 1}, Extras: map[string]any{"comment": "旧值"}}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"config": map[string]any{}, "comment": ""}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	o := l.Entry(id).Options()
	if len(o.Config.(map[string]any)) != 0 || o.Extras["comment"] != "" {
		t.Fatal("显式空配置应覆盖旧值")
	}
	if err := l.Update(context.Background(), id, EntryPatch{Unset: []string{"config", "comment"}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	o = l.Entry(id).Options()
	if o.Config != nil || len(o.Extras) != 0 {
		t.Fatal("Unset 应删除键")
	}
}
func TestArrayAndObjectInjectConfig(t *testing.T) {
	list, ok := AsEntries([]any{map[string]any{"name": "foo", "inject": []any{"alpha", "beta"}}, map[string]any{"name": "foo", "inject": map[string]any{"alpha": map[string]any{"await": true}}}})
	if !ok || len(list) != 2 || len(list[0].Inject) != 2 || !reflect.DeepEqual(list[1].Inject["alpha"], map[string]any{"await": true}) {
		t.Fatalf("inject 解析错误：%+v", list)
	}
}
func TestConcurrentUpdatesKeepNewestConfigAndCommitOrder(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	entered, release := make(chan struct{}), make(chan struct{})
	RegisterFunc("blocked-config", func(c *kardia.Context, v any) (kardia.Disposable, error) {
		if v == 1 {
			close(entered)
			<-release
		}
		return nil, nil
	})
	id, err := l.Create(context.Background(), EntryOptions{Name: "blocked-config", Config: 0}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var revisions []uint64
	var configs []any
	l.SetCommit(func(c EntryChange) {
		mu.Lock()
		revisions = append(revisions, c.Revision)
		configs = append(configs, c.Options.Config)
		mu.Unlock()
	})
	first := make(chan error, 1)
	go func() {
		first <- l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"config": 1}}, nil, nil)
	}()
	<-entered
	second := make(chan error, 1)
	go func() {
		second <- l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"config": 2}}, nil, nil)
	}()
	// 等待第二个意向被接纳，不依赖调度延时；提交回调是状态写入后的屏障。
	barrier := make(chan struct{})
	l.SetCommit(func(c EntryChange) {
		mu.Lock()
		revisions = append(revisions, c.Revision)
		configs = append(configs, c.Options.Config)
		mu.Unlock()
		if c.Options.Config == 3 {
			close(barrier)
		}
	})
	third := make(chan error, 1)
	go func() {
		third <- l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"config": 3}}, nil, nil)
	}()
	<-barrier
	close(release)
	for _, ch := range []chan error{first, second, third} {
		if err := <-ch; err != nil {
			t.Fatal(err)
		}
	}
	settleTree(t, ctx, l)
	mu.Lock()
	defer mu.Unlock()
	for i := 1; i < len(revisions); i++ {
		if revisions[i] <= revisions[i-1] {
			t.Fatalf("提交乱序：%v", revisions)
		}
	}
	latest := configs[len(configs)-1]
	if l.Entry(id).Options().Config != latest || l.Entry(id).Fiber().Config() != latest {
		t.Fatalf("最新提交 %v 与配置/运行时不一致：%v/%v", latest, l.Entry(id).Options().Config, l.Entry(id).Fiber().Config())
	}
}
func TestStaleTreeSnapshotIsRejected(t *testing.T) {
	_, l, _ := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo", Config: 1}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	revision, old := l.Revision(), l.Root.Data()
	if err := l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"config": 2}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := l.Root.UpdateRevision(context.Background(), old, revision); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("应拒绝旧快照：%v", err)
	}
	if l.Entry(id).Options().Config != 2 {
		t.Fatal("旧快照覆盖了新配置")
	}
}
func TestLoadOwnsResourcesAtCallSite(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	var disposed atomic.Int32
	var child *kardia.Fiber
	parent, err := ctx.Plugin(&kardia.Plugin{Name: "调用方", Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		var err error
		child, err = l.Load(c, &kardia.Plugin{Name: "子插件", Apply: func(*kardia.Context, any) (kardia.Disposable, error) {
			return func(context.Context) error { disposed.Add(1); return nil }, nil
		}}, nil)
		if err != nil {
			return nil, err
		}
		_, err = child.Await(c.Lifetime())
		return nil, err
	}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = parent.Await(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err = parent.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	if disposed.Load() != 1 || child.UID() != nil {
		t.Fatal("调用方卸载后应释放 Loader.Load 创建的插件")
	}
}
func TestLoaderAwaitUsesAccessContext(t *testing.T) {
	_, l, _ := bootLoader(t)
	entered, release := make(chan struct{}), make(chan struct{})
	RegisterFunc("waiting-loader", func(*kardia.Context, any) (kardia.Disposable, error) { close(entered); <-release; return nil, nil })
	done := make(chan error, 1)
	go func() {
		_, err := l.Create(context.Background(), EntryOptions{Name: "waiting-loader"}, nil, 0)
		done <- err
	}()
	<-entered
	access := l.Ctx.Intercept("loader", map[string]any{"await": true})
	ready, err := l.checkReady(access, l)
	if err != nil || ready {
		t.Fatalf("调用方 await 应等待未决条目：%v/%v", ready, err)
	}
	ready, err = l.checkReady(l.Ctx, l)
	if err != nil || !ready {
		t.Fatalf("无 await 调用方可立即使用：%v/%v", ready, err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	ready, err = l.checkReady(access, l)
	if err != nil || !ready {
		t.Fatal("条目稳定后 await 应就绪")
	}
}
func TestSnapshotsDuringConcurrentUpdates(t *testing.T) {
	_, l, _ := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo", Config: 0}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				if err := l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"config": i*10 + j}}, nil, nil); err != nil {
					t.Error(err)
				}
				_ = l.Root.Data()
				_ = l.Entry(id).Options()
				_ = l.StoreSnapshot()
				_ = l.GetTasks()
			}
		}(i)
	}
	wg.Wait()
	if l.Entry(id).Options().Config != l.Entry(id).Fiber().Config() {
		t.Fatal("并发更新完成后状态应一致")
	}
}
func TestAwaitCancellation(t *testing.T) {
	_, l, _ := bootLoader(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if !errors.Is(l.Await(ctx), context.Canceled) {
		t.Fatal("等待必须尊重取消")
	}
}

func TestRemoveCancelsLoadingEntry(t *testing.T) {
	_, l, _ := bootLoader(t)
	entered := make(chan struct{})
	RegisterFunc("cancel-loading", func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		close(entered)
		<-c.Lifetime().Done()
		return nil, c.Lifetime().Err()
	})
	created := make(chan error, 1)
	go func() {
		_, err := l.Create(context.Background(), EntryOptions{ID: "pending", Name: "cancel-loading"}, nil, 0)
		created <- err
	}()
	<-entered
	wait, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := l.Remove(wait, "pending"); err != nil {
		t.Fatalf("移除必须取消正在加载的激活：%v", err)
	}
	select {
	case <-created:
	case <-wait.Done():
		t.Fatal("创建等待者未完成")
	}
	if l.Entry("pending") != nil {
		t.Fatal("已移除条目仍被登记")
	}
}
func TestSaveConfigRejectsStaleInternalWrite(t *testing.T) {
	_, l, _ := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo", Config: map[string]any{"path": "a"}}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	e := l.Entry(id)
	old := e.Options().Config
	if err := l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"config": map[string]any{"path": "b"}}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := e.SaveConfig(old, map[string]any{"path": "a", "patch": true}); !errors.Is(err, ErrStaleRevision) {
		t.Fatalf("应拒绝旧内部配置写回：%v", err)
	}
	current := e.Options().Config
	next := map[string]any{"path": "b", "patch": true}
	if err := e.SaveConfig(current, next); err != nil {
		t.Fatal(err)
	}
	if !deepValueEqual(e.Options().Config, next) {
		t.Fatal("内部配置应原子保存")
	}
}

func TestUpdateCancelsLoadingGeneration(t *testing.T) {
	_, l, _ := bootLoader(t)
	entered := make(chan struct{})
	var cleanups atomic.Int32
	RegisterFunc("replace-loading", func(c *kardia.Context, cfg any) (kardia.Disposable, error) {
		if cfg == 1 {
			if _, err := c.Effect("临时资源", func() (kardia.Disposable, error) {
				return func(context.Context) error { cleanups.Add(1); return nil }, nil
			}); err != nil {
				return nil, err
			}
			close(entered)
			<-c.Lifetime().Done()
			return nil, c.Lifetime().Err()
		}
		return nil, nil
	})
	created := make(chan error, 1)
	go func() {
		_, err := l.Create(context.Background(), EntryOptions{ID: "loading-update", Name: "replace-loading", Config: 1}, nil, 0)
		created <- err
	}()
	<-entered
	e := l.Entry("loading-update")
	original := e.Fiber()
	wait, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := l.Update(wait, "loading-update", EntryPatch{Set: map[string]any{"config": 2}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if err := <-created; err != nil {
		t.Fatal(err)
	}
	if e.Fiber() != original || e.Fiber().Config() != 2 || cleanups.Load() != 1 {
		t.Fatal("更新应取消并清理旧代，再在同一 fiber 激活新配置")
	}
}

type expressionConfig string

func (expressionConfig) RuntimeConfigError() error { return errors.New("不支持执行 JS 表达式") }
func TestConfigParsingRejectsInvalidShapesAndPreservesExpressions(t *testing.T) {
	for _, raw := range []any{[]any{map[string]any{"name": 17}}, []any{map[string]any{"inject": []any{"foo", 1}}}, []any{map[string]any{"disabled": "false"}}, []any{map[string]any{"isolate": []any{"foo"}}}} {
		if _, err := ParseEntries(raw); err == nil {
			t.Fatalf("无效配置不得静默丢弃：%v", raw)
		}
	}
	raw := []any{map[string]any{"id": "expression", "name": "foo", "disabled": true, "inject": expressionConfig("foo")}}
	list, err := ParseEntries(raw)
	if err != nil {
		t.Fatal(err)
	}
	value, ok := GetKey(list[0], "inject")
	if !ok || value != expressionConfig("foo") {
		t.Fatal("表达式节点必须保真")
	}
	_, l, _ := bootLoader(t)
	if err := l.Root.Update(context.Background(), list); err != nil {
		t.Fatal(err)
	}
	if err := l.Update(context.Background(), "expression", EntryPatch{Unset: []string{"disabled"}}, nil, nil); err == nil {
		t.Fatal("启用表达式配置时应明确拒绝执行")
	}
}

func TestClosedTreeRejectsWrites(t *testing.T) {
	_, l, _ := bootLoader(t)
	if err := l.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Create(context.Background(), EntryOptions{Name: "foo"}, nil, 0); err == nil {
		t.Fatal("关闭的树不能创建新条目")
	}
	if err := l.Root.Update(context.Background(), []*EntryOptions{{ID: "new", Name: "foo"}}); err == nil {
		t.Fatal("关闭的树不能重新调和条目")
	}
	if len(l.Entries()) != 0 {
		t.Fatal("关闭后不能复活条目")
	}
}

func TestUpdateBeforeFiberPublicationCancelsStaleActivation(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var blocked atomic.Bool
	RegisterFunc("publish-gap", func(c *kardia.Context, cfg any) (kardia.Disposable, error) {
		if cfg == 1 {
			<-c.Lifetime().Done()
			return nil, c.Lifetime().Err()
		}
		return nil, nil
	})
	off, err := ctx.On(kardia.StringEvent("internal/plugin"), func(ev *kardia.EventCtx) (any, error) {
		if len(ev.Args) > 0 {
			if f, ok := ev.Args[0].(*kardia.Fiber); ok && f.UID() != nil && f.Runtime() != nil && f.Runtime().Name == "publish-gap" && blocked.CompareAndSwap(false, true) {
				close(entered)
				<-release
			}
		}
		return nil, nil
	}, kardia.EventOptions{Global: true})
	if err != nil {
		t.Fatal(err)
	}
	defer off()
	created := make(chan error, 1)
	go func() {
		_, err := l.Create(context.Background(), EntryOptions{ID: "publication", Name: "publish-gap", Config: 1}, nil, 0)
		created <- err
	}()
	<-entered
	if l.Entry("publication").Fiber() != nil {
		t.Fatal("屏障必须位于 fiber 发布前")
	}
	task := l.SubmitUpdate("publication", EntryPatch{Set: map[string]any{"config": 2}}, nil, nil)
	close(release)
	wait, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := task.Wait(wait); err != nil {
		t.Fatal(err)
	}
	if err := <-created; err != nil {
		t.Fatal(err)
	}
	if l.Entry("publication").Fiber().Config() != 2 {
		t.Fatal("发布窗口的新配置应取消过时的首次激活")
	}
}
func TestSubmitUpdateAcceptsInCallOrder(t *testing.T) {
	_, l, _ := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo", Config: 0}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var tasks []kardia.Task
	for i := 1; i <= 20; i++ {
		tasks = append(tasks, l.SubmitUpdate(id, EntryPatch{Set: map[string]any{"config": i}}, nil, nil))
		if l.Entry(id).Options().Config != i {
			t.Fatal("SubmitUpdate返回前必须同步接纳该次意向")
		}
	}
	for _, task := range tasks {
		if err := task.Wait(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if l.Entry(id).Fiber().Config() != 20 {
		t.Fatal("最后一次异步提交必须成为最终运行配置")
	}
}

func TestUnchangedReconcileDoesNotCancelLoading(t *testing.T) {
	_, l, _ := bootLoader(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var canceled atomic.Bool
	RegisterFunc("unchanged-loading", func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		close(entered)
		select {
		case <-release:
		case <-c.Lifetime().Done():
			canceled.Store(true)
		}
		return nil, nil
	})
	created := make(chan error, 1)
	go func() {
		_, err := l.Create(context.Background(), EntryOptions{ID: "unchanged", Name: "unchanged-loading", Config: 1}, nil, 0)
		created <- err
	}()
	<-entered
	task := l.SubmitUpdate("unchanged", EntryPatch{Set: map[string]any{"config": 1}}, nil, nil)
	close(release)
	if err := task.Wait(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := <-created; err != nil {
		t.Fatal(err)
	}
	if canceled.Load() || l.Entry("unchanged").Fiber().State() != kardia.FiberActive {
		t.Fatal("未改变运行配置的调和不得取消初始化")
	}
}
func TestCanceledUpdateReturningToAppliedConfigRestarts(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	entered := make(chan struct{})
	RegisterFunc("return-config", func(c *kardia.Context, cfg any) (kardia.Disposable, error) {
		if cfg == 2 {
			close(entered)
			<-c.Lifetime().Done()
			return nil, c.Lifetime().Err()
		}
		return c.Provide("return-value", cfg, nil)
	})
	id, err := l.Create(context.Background(), EntryOptions{Name: "return-config", Config: 1}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	changing := l.SubmitUpdate(id, EntryPatch{Set: map[string]any{"config": 2}}, nil, nil)
	<-entered
	restore := l.SubmitUpdate(id, EntryPatch{Set: map[string]any{"config": 1}}, nil, nil)
	wait, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := restore.Wait(wait); err != nil {
		t.Fatal(err)
	}
	if err := changing.Wait(wait); err != nil {
		t.Fatal(err)
	}
	v, err := ctx.Get("return-value")
	if err != nil || v != 1 || l.Entry(id).Fiber().State() != kardia.FiberActive {
		t.Fatalf("回到旧配置也必须重新激活被取消的提供者：%v/%v", v, err)
	}
}

func TestNewRevisionBeforeLoadingStartsCancelsStaleUpdate(t *testing.T) {
	ctx, l, _ := bootLoader(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var block atomic.Bool
	RegisterFunc("activation-gap", func(c *kardia.Context, cfg any) (kardia.Disposable, error) {
		if cfg == 1 {
			<-c.Lifetime().Done()
			return nil, c.Lifetime().Err()
		}
		return c.Provide("activation-gap-value", cfg, nil)
	})
	id, err := l.Create(context.Background(), EntryOptions{Name: "activation-gap", Config: 0}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	f := l.Entry(id).Fiber()
	off, err := ctx.On(kardia.StringEvent("internal/update"), func(ev *kardia.EventCtx) (any, error) {
		if ev.This == f && len(ev.Args) > 0 && ev.Args[0] == 1 && block.CompareAndSwap(false, true) {
			close(entered)
			<-release
		}
		return ev.Next()
	}, kardia.EventOptions{Global: true, Prepend: true})
	if err != nil {
		t.Fatal(err)
	}
	defer off()
	first := l.SubmitUpdate(id, EntryPatch{Set: map[string]any{"config": 1}}, nil, nil)
	<-entered
	if f.State() != kardia.FiberActive {
		t.Fatal("屏障应位于进入Loading之前")
	}
	second := l.SubmitUpdate(id, EntryPatch{Set: map[string]any{"config": 2}}, nil, nil)
	close(release)
	wait, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := second.Wait(wait); err != nil {
		t.Fatal(err)
	}
	if err := first.Wait(wait); err != nil {
		t.Fatal(err)
	}
	v, err := ctx.Get("activation-gap-value")
	if err != nil || v != 2 {
		t.Fatalf("旧加载必须被取消，最新配置应生效：%v/%v", v, err)
	}
}

func TestReplacingGroupClearsRetiredGroupReference(t *testing.T) {
	_, l, _ := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{Name: Group.Name, Group: boolPtr(true), Config: []*EntryOptions{}}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"name": "foo"}, Unset: []string{"group", "config"}}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if l.Entry(id).Subgroup() != nil {
		t.Fatal("替换组插件后不能保留已停止的组引用")
	}
	if _, err := l.ResolveGroup(&id); err == nil {
		t.Fatal("普通插件不能再解析为旧组")
	}
}

func TestSealedTreeAcceptsInternalConfigBeforeClose(t *testing.T) {
	_, l, _ := bootLoader(t)
	id, err := l.Create(context.Background(), EntryOptions{Name: "foo", Config: 0}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	e := l.Entry(id)
	if err := l.Seal(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := l.Update(context.Background(), id, EntryPatch{Set: map[string]any{"config": 1}}, nil, nil); !errors.Is(err, ErrTreeClosed) {
		t.Fatalf("seal应阻止外部更新：%v", err)
	}
	if err := l.Remove(context.Background(), id); !errors.Is(err, ErrTreeClosed) {
		t.Fatalf("seal应阻止外部删除：%v", err)
	}
	if err := e.SaveConfig(0, 2); err != nil {
		t.Fatalf("已接受插件的内部配置应能在seal后保存：%v", err)
	}
	if e.Options().Config != 2 {
		t.Fatal("内部最终配置丢失")
	}
	if err := l.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := e.SaveConfig(2, 3); err == nil {
		t.Fatal("最终关闭后不能再次保存")
	}
}
