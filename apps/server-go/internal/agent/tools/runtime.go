package tools

// Runtime 是工具插件的宿主。它把 kardia root、插件 fiber、调用作用域和
// 生命周期收敛到一个可注入的对象；领域接缝只负责提供插件，不再自行复制
// scope/取消/关闭编排。

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"elysian/server/internal/agent/kardia"
)

type runtimeResult struct {
	value any
	err   error
}

type catalogRegistration struct {
	users    int
	cleanups []kardia.Disposable
}

// Runtime 持有一个独立的 kardia root。所有插件必须在构造时装载，运行中不
// 接受隐式注册，保证对外 schema 与执行能力来自同一个生命周期快照。
type Runtime struct {
	mu        sync.Mutex
	root      *kardia.Context
	registry  *Registry
	closed    bool
	closeOnce sync.Once
	closeDone chan struct{}
	closeErr  error
	catalogs  map[string]*catalogRegistration
}

// NewRuntime 创建并装载工具运行时。tools.Plugin 会自动补到插件列表头部；
// 调用方重复传入它不会产生第二份注册表。
func NewRuntime(ctx context.Context, plugins ...*kardia.Plugin) (*Runtime, error) {
	if ctx == nil {
		return nil, errors.New("创建工具运行时必须提供 ctx")
	}
	root := kardia.NewContext()
	list := make([]*kardia.Plugin, 0, len(plugins)+1)
	list = append(list, Plugin)
	for _, plugin := range plugins {
		if plugin == nil {
			_ = root.Fiber().Dispose(context.Background())
			return nil, errors.New("创建工具运行时失败：插件为空")
		}
		if plugin == Plugin {
			continue
		}
		list = append(list, plugin)
	}
	if _, err := Install(ctx, root, list...); err != nil {
		_ = root.Fiber().Dispose(context.Background())
		return nil, fmt.Errorf("装载工具运行时失败：%w", err)
	}
	registry, err := RegistryFrom(root)
	if err != nil {
		_ = root.Fiber().Dispose(context.Background())
		return nil, fmt.Errorf("工具运行时注册表未就绪：%w", err)
	}
	return &Runtime{root: root, registry: registry, closeDone: make(chan struct{}), catalogs: map[string]*catalogRegistration{}}, nil
}

// NewManagedRuntime requires harness-issued authorization even for a Handler
// obtained directly from Lookup; optional lifecycle events cannot bypass it.
func NewManagedRuntime(ctx context.Context, plugins ...*kardia.Plugin) (*Runtime, error) {
	r, err := NewRuntime(ctx, plugins...)
	if err == nil {
		r.registry.managed = true
	}
	return r, err
}

func (r *Runtime) SetAuthority(authority *Authority) error {
	if r == nil || authority == nil {
		return errors.New("工具授权服务不可用")
	}
	r.registry.mu.Lock()
	defer r.registry.mu.Unlock()
	if r.registry.authority != nil && r.registry.authority != authority {
		return errors.New("工具授权服务已绑定")
	}
	r.registry.managed = true
	r.registry.authority = authority
	return nil
}

// RegisterCatalog installs immutable run-scoped descriptors in the same kardia
// registry as domain plugins. Different revisions may retain the same alias.
func (r *Runtime) RegisterCatalog(catalog string, descriptors []Descriptor) error {
	if catalog == "" {
		return errors.New("能力目录缺少固定摘要")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("工具运行时不可用")
	}
	if registration := r.catalogs[catalog]; registration != nil {
		registration.users++
		return nil
	}
	cleanups := []kardia.Disposable{}
	for _, d := range descriptors {
		d.Catalog = catalog
		cleanup, err := r.registry.register(r.root, d)
		if err != nil {
			for _, dispose := range cleanups {
				_ = dispose(context.Background())
			}
			return err
		}
		cleanups = append(cleanups, cleanup)
	}
	r.catalogs[catalog] = &catalogRegistration{users: 1, cleanups: cleanups}
	return nil
}

func (r *Runtime) ReleaseCatalog(catalog string) error {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	registration := r.catalogs[catalog]
	if registration == nil {
		r.mu.Unlock()
		return nil
	}
	registration.users--
	if registration.users > 0 {
		r.mu.Unlock()
		return nil
	}
	delete(r.catalogs, catalog)
	r.mu.Unlock()
	var err error
	for i := len(registration.cleanups) - 1; i >= 0; i-- {
		err = errors.Join(err, registration.cleanups[i](context.Background()))
	}
	return err
}

// Available 报告运行时仍可接受新调用。
func (r *Runtime) Available() bool {
	if r == nil {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return !r.closed && r.registry != nil
}

// Schemas 返回注册表的独立公开快照。
func (r *Runtime) Schemas() []PublicSchema {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.registry == nil {
		return []PublicSchema{}
	}
	schemas := []PublicSchema{}
	for _, d := range r.registry.List() {
		if d.Catalog == "" {
			schemas = append(schemas, d.Public())
		}
	}
	return schemas
}

// Execute 在独立的 kardia effect scope 中调用工具。scope 的生命周期绑定到
// ctx；取消只会向工具协作传递信号，并等待 handler 真正返回。
func (r *Runtime) Execute(ctx context.Context, name string, args map[string]any) (any, error) {
	if r == nil {
		return nil, errors.New("工具运行时不可用")
	}
	if ctx == nil {
		return nil, errors.New("工具调用必须提供上下文")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	r.mu.Lock()
	if r.closed || r.registry == nil {
		r.mu.Unlock()
		return nil, errors.New("工具运行时不可用")
	}
	completed := make(chan runtimeResult, 1)
	handle, err := r.root.Scope().Iter("tools.runtime-call", func(_ context.Context, scope *kardia.EffectScope) error {
		outcome := runtimeResult{}
		defer func() {
			if recover() != nil {
				outcome = runtimeResult{err: errors.New("工具执行发生内部错误")}
			}
			completed <- outcome
		}()
		access, bindErr := scope.Bind(r.root)
		if bindErr != nil {
			outcome.err = errors.New("工具调用作用域不可用")
			return nil
		}
		access = access.Extend(kardia.ExtendMeta{Props: map[any]any{invocationContextKey{}: ctx}})
		outcome.value, outcome.err = r.registry.Execute(access, name, args)
		return nil
	})
	r.mu.Unlock()
	if err != nil {
		return nil, errors.New("无法创建工具调用作用域")
	}
	stopCancellation := context.AfterFunc(ctx, func() {
		cancelled, cancel := context.WithCancel(context.Background())
		cancel()
		_ = handle.Dispose(cancelled)
	})
	defer stopCancellation()
	outcome := <-completed
	if disposeErr := handle.Dispose(context.Background()); disposeErr != nil {
		outcome.err = errors.Join(outcome.err, errors.New("回收工具调用作用域失败"))
	}
	return outcome.value, outcome.err
}

// Close 停止新调用并回收 root 下的全部插件与作用域。重复关闭只等待同一
// 次回收结果；ctx 只限制调用方等待，不中断实际清理。
func (r *Runtime) Close(ctx context.Context) error {
	if r == nil {
		return nil
	}
	if ctx == nil {
		return errors.New("关闭工具运行时必须提供上下文")
	}
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		go func() {
			if r.root != nil {
				r.closeErr = r.root.Fiber().Dispose(context.Background())
			}
			close(r.closeDone)
		}()
	})
	select {
	case <-r.closeDone:
		return r.closeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
