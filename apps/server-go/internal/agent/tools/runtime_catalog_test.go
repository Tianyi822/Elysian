package tools

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
)

// Done 被求值说明注册者已进入等待分支，无需用 sleep 猜测 goroutine 进度。
type catalogWaitContext struct {
	context.Context
	entered chan struct{}
	once    sync.Once
}

func (c *catalogWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.entered) })
	return c.Context.Done()
}

func awaitCatalogSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatal("目录生命周期未推进")
	}
}

func awaitCatalogResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(3 * time.Second):
		t.Fatal("目录生命周期调用未结束")
		return nil
	}
}

func catalogTestRuntime(t *testing.T) *Runtime {
	t.Helper()
	r, err := NewRuntime(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := r.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	return r
}

func TestCatalogReregistrationWaitsForCompleteRelease(t *testing.T) {
	r := catalogTestRuntime(t)
	descriptors := []Descriptor{echoDescriptor("catalog_a", 1), echoDescriptor("catalog_b", 1)}
	entered, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := sync.OnceFunc(func() { close(resume) })
	defer unblock()
	_, err := r.root.On(EventChange, func(ev *kardia.EventCtx) (any, error) {
		// 注册、回收回调均可读取运行时，不能被全局锁堵住。
		_ = r.Available()
		_ = r.Schemas()
		change := ev.Args[0].(Change)
		if change.Kind == ChangeRemoved && change.Name == "catalog_b" {
			once.Do(func() { close(entered); <-resume })
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterCatalog("snapshot", descriptors); err != nil {
		t.Fatal(err)
	}
	released := make(chan error, 1)
	go func() { released <- r.ReleaseCatalog("snapshot") }()
	awaitCatalogSignal(t, entered)
	ctx := &catalogWaitContext{Context: context.Background(), entered: make(chan struct{})}
	registered := make(chan error, 1)
	go func() { registered <- r.RegisterCatalogContext(ctx, "snapshot", descriptors) }()
	awaitCatalogSignal(t, ctx.entered)
	select {
	case err := <-registered:
		t.Fatalf("清理结束前重注册已返回：%v", err)
	default:
	}
	unblock()
	if err := awaitCatalogResult(t, released); err != nil {
		t.Fatal(err)
	}
	if err := awaitCatalogResult(t, registered); err != nil {
		t.Fatal(err)
	}
	for _, d := range descriptors {
		if _, ok := r.registry.lookup("snapshot", d.Name); !ok {
			t.Fatalf("旧代清理误删新代工具：%s", d.Name)
		}
	}
	if err := r.ReleaseCatalog("snapshot"); err != nil || r.registry.Size() != 0 {
		t.Fatalf("重注册后的引用未清理：%v size=%d", err, r.registry.Size())
	}
}

func TestCatalogRegistrationWaitCancellationAndReferences(t *testing.T) {
	r := catalogTestRuntime(t)
	entered, resume := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(resume) })
	defer unblock()
	_, err := r.root.On(EventChange, func(ev *kardia.EventCtx) (any, error) {
		change := ev.Args[0].(Change)
		if change.Kind == ChangeRegistered && change.Name == "catalog_a" {
			close(entered)
			<-resume
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	descriptors := []Descriptor{echoDescriptor("catalog_a", 1)}
	first := make(chan error, 1)
	go func() { first <- r.RegisterCatalog("snapshot", descriptors) }()
	awaitCatalogSignal(t, entered)
	base, cancel := context.WithCancel(context.Background())
	defer cancel()
	ctx := &catalogWaitContext{Context: base, entered: make(chan struct{})}
	waiter := make(chan error, 1)
	go func() { waiter <- r.RegisterCatalogContext(ctx, "snapshot", descriptors) }()
	awaitCatalogSignal(t, ctx.entered)
	cancel()
	if err := awaitCatalogResult(t, waiter); !errors.Is(err, context.Canceled) {
		t.Fatalf("等待取消未传递：%v", err)
	}
	unblock()
	if err := awaitCatalogResult(t, first); err != nil {
		t.Fatal(err)
	}
	if err := r.RegisterCatalog("snapshot", descriptors); err != nil {
		t.Fatal(err)
	}
	if err := r.ReleaseCatalog("snapshot"); err != nil || r.registry.Size() != 1 {
		t.Fatalf("共享引用被提前释放：%v", err)
	}
	if err := r.ReleaseCatalog("snapshot"); err != nil || r.registry.Size() != 0 {
		t.Fatalf("被取消的等待者泄漏引用：%v", err)
	}
}

func TestCatalogRegistrationFailureWaitsForRollback(t *testing.T) {
	r := catalogTestRuntime(t)
	registrationErr, cleanupErr := errors.New("注册上报失败"), errors.New("回收上报失败")
	entered, resume := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(resume) })
	defer unblock()
	var failed atomic.Bool
	_, err := r.root.On(EventChange, func(ev *kardia.EventCtx) (any, error) {
		change := ev.Args[0].(Change)
		if change.Kind == ChangeRegistered && change.Name == "catalog_b" && failed.CompareAndSwap(false, true) {
			return nil, registrationErr
		}
		if change.Kind == ChangeRemoved && change.Name == "catalog_a" {
			close(entered)
			<-resume
			return nil, cleanupErr
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	descriptors := []Descriptor{echoDescriptor("catalog_a", 1), echoDescriptor("catalog_b", 1)}
	first := make(chan error, 1)
	go func() { first <- r.RegisterCatalog("snapshot", descriptors) }()
	awaitCatalogSignal(t, entered)
	ctx := &catalogWaitContext{Context: context.Background(), entered: make(chan struct{})}
	waiter := make(chan error, 1)
	go func() { waiter <- r.RegisterCatalogContext(ctx, "snapshot", descriptors) }()
	awaitCatalogSignal(t, ctx.entered)
	unblock()
	for _, result := range []<-chan error{first, waiter} {
		if err := awaitCatalogResult(t, result); !errors.Is(err, registrationErr) || !errors.Is(err, cleanupErr) {
			t.Fatalf("回滚错误未共享：%v", err)
		}
	}
	if r.registry.Size() != 0 || len(r.catalogs) != 0 {
		t.Fatal("注册失败留下半套目录")
	}
}

func TestCatalogCloseSharesReleaseAndRejectsWaiters(t *testing.T) {
	r, err := NewRuntime(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	cleanupErr := errors.New("回收上报失败")
	entered, resume := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(resume) })
	defer unblock()
	var removals atomic.Int32
	_, err = r.root.On(EventChange, func(ev *kardia.EventCtx) (any, error) {
		change := ev.Args[0].(Change)
		if change.Kind == ChangeRemoved {
			removals.Add(1)
			close(entered)
			<-resume
			return nil, cleanupErr
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	descriptors := []Descriptor{echoDescriptor("catalog_a", 1)}
	if err := r.RegisterCatalog("snapshot", descriptors); err != nil {
		t.Fatal(err)
	}
	released := make(chan error, 1)
	go func() { released <- r.ReleaseCatalog("snapshot") }()
	awaitCatalogSignal(t, entered)
	ctx := &catalogWaitContext{Context: context.Background(), entered: make(chan struct{})}
	waiter := make(chan error, 1)
	go func() { waiter <- r.RegisterCatalogContext(ctx, "snapshot", descriptors) }()
	awaitCatalogSignal(t, ctx.entered)
	closed := make(chan error, 1)
	go func() { closed <- r.Close(context.Background()) }()
	awaitCatalogSignal(t, r.closing)
	if err := awaitCatalogResult(t, waiter); err == nil {
		t.Fatal("关闭后仍接受等待注册")
	}
	unblock()
	for _, result := range []<-chan error{released, closed} {
		if err := awaitCatalogResult(t, result); !errors.Is(err, cleanupErr) {
			t.Fatalf("关闭与释放未共享清理错误：%v", err)
		}
	}
	if err := r.Close(context.Background()); !errors.Is(err, cleanupErr) || removals.Load() != 1 {
		t.Fatalf("重复关闭重放清理或丢失结果：%v removals=%d", err, removals.Load())
	}
}

func TestCatalogCloseWaitsForRegistrationRollback(t *testing.T) {
	r := catalogTestRuntime(t)
	entered, resume := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(resume) })
	defer unblock()
	_, err := r.root.On(EventChange, func(ev *kardia.EventCtx) (any, error) {
		if ev.Args[0].(Change).Kind == ChangeRegistered {
			close(entered)
			<-resume
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	registered := make(chan error, 1)
	go func() { registered <- r.RegisterCatalog("snapshot", []Descriptor{echoDescriptor("catalog_a", 1)}) }()
	awaitCatalogSignal(t, entered)
	closed := make(chan error, 1)
	go func() { closed <- r.Close(context.Background()) }()
	awaitCatalogSignal(t, r.closing)
	select {
	case err := <-closed:
		t.Fatalf("目录仍在安装时关闭提前完成：%v", err)
	default:
	}
	unblock()
	if err := awaitCatalogResult(t, registered); err == nil {
		t.Fatal("关闭后安装仍被接受")
	}
	if err := awaitCatalogResult(t, closed); err != nil {
		t.Fatal(err)
	}
	if len(r.catalogs) != 0 || r.registry.Size() != 0 {
		t.Fatal("关闭后留下目录或描述符")
	}
}

func TestCatalogConcurrentOwnersReleaseOnce(t *testing.T) {
	r := catalogTestRuntime(t)
	var added, removed atomic.Int32
	_, err := r.root.On(EventChange, func(ev *kardia.EventCtx) (any, error) {
		if ev.Args[0].(Change).Kind == ChangeRegistered {
			added.Add(1)
		} else {
			removed.Add(1)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	const owners = 16
	start, release := make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	defer unblock()
	registered, released := make(chan error, owners), make(chan error, owners)
	for i := 0; i < owners; i++ {
		go func() {
			<-start
			err := r.RegisterCatalog("snapshot", []Descriptor{echoDescriptor("catalog_a", 1)})
			registered <- err
			<-release
			if err == nil {
				err = r.ReleaseCatalog("snapshot")
			}
			released <- err
		}()
	}
	close(start)
	for i := 0; i < owners; i++ {
		if err := awaitCatalogResult(t, registered); err != nil {
			t.Fatal(err)
		}
	}
	unblock()
	for i := 0; i < owners; i++ {
		if err := awaitCatalogResult(t, released); err != nil {
			t.Fatal(err)
		}
	}
	if added.Load() != 1 || removed.Load() != 1 || r.registry.Size() != 0 {
		t.Fatalf("共享目录重复注册或释放：added=%d removed=%d size=%d", added.Load(), removed.Load(), r.registry.Size())
	}
}
