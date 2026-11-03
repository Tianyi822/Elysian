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
	state      catalogState
	users      int
	cleanups   []kardia.Disposable
	ready      chan struct{}
	done       chan struct{}
	installErr error
	releaseErr error
}

type catalogState uint8

const (
	catalogRegistering catalogState = iota
	catalogReady
	catalogReleasing
)

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
	closing   chan struct{}
	registers sync.WaitGroup
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
	return &Runtime{root: root, registry: registry, closing: make(chan struct{}), closeDone: make(chan struct{}), catalogs: map[string]*catalogRegistration{}}, nil
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
	return r.RegisterCatalogContext(context.Background(), catalog, descriptors)
}

// RegisterCatalogContext 的等待可取消。目录在注册和回收完成前保留占位，
// 同摘要的新使用者不能看到半套描述符；事件回调始终在运行时锁外执行。
func (r *Runtime) RegisterCatalogContext(ctx context.Context, catalog string, descriptors []Descriptor) error {
	if r == nil {
		return errors.New("工具运行时不可用")
	}
	if ctx == nil {
		return errors.New("登记能力目录必须提供 ctx")
	}
	if catalog == "" {
		return errors.New("能力目录缺少固定摘要")
	}
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		r.mu.Lock()
		if r.closed {
			r.mu.Unlock()
			return errors.New("工具运行时不可用")
		}
		registration := r.catalogs[catalog]
		if registration == nil {
			registration = &catalogRegistration{state: catalogRegistering, ready: make(chan struct{}), done: make(chan struct{})}
			r.catalogs[catalog] = registration
			r.registers.Add(1) // 与 Close 的 closed 检查共用锁，关闭后不会新增注册。
			r.mu.Unlock()
			defer r.registers.Done()
			return r.installCatalog(ctx, catalog, registration, descriptors)
		}
		state := registration.state
		if state == catalogReady {
			registration.users++
			r.mu.Unlock()
			return nil
		}
		wait := registration.ready
		if state == catalogReleasing {
			wait = registration.done
		}
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-r.closing:
			return errors.New("工具运行时不可用")
		case <-wait:
		}
		// 对应通道关闭后该代的结果不可变，所有等待者共享失败。
		if state == catalogRegistering && registration.installErr != nil {
			return registration.installErr
		}
		if state == catalogReleasing && registration.releaseErr != nil {
			return registration.releaseErr
		}
	}
}

func (r *Runtime) installCatalog(ctx context.Context, catalog string, registration *catalogRegistration, descriptors []Descriptor) error {
	cleanups := []kardia.Disposable{}
	var err error
	for _, d := range descriptors {
		if err = ctx.Err(); err != nil {
			break
		}
		d.Catalog = catalog
		var cleanup kardia.Disposable
		cleanup, err = r.registry.register(r.root, d)
		if err != nil {
			break
		}
		cleanups = append(cleanups, cleanup)
	}
	r.mu.Lock()
	if err == nil {
		err = ctx.Err()
		if r.closed {
			err = errors.Join(err, errors.New("工具运行时不可用"))
		}
	}
	if err == nil {
		registration.state, registration.users, registration.cleanups = catalogReady, 1, cleanups
		close(registration.ready)
		r.mu.Unlock()
		return nil
	}
	r.mu.Unlock()
	// 回滚完成前仍保持 registering，防止失败后的新注册撞上残留条目。
	cleanupErr := disposeCatalog(cleanups)
	err = errors.Join(err, cleanupErr)
	r.mu.Lock()
	registration.installErr = err
	registration.releaseErr = cleanupErr
	delete(r.catalogs, catalog)
	close(registration.ready)
	close(registration.done)
	r.mu.Unlock()
	return err
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
	if registration.state == catalogRegistering {
		r.mu.Unlock()
		<-registration.ready
		if registration.installErr != nil {
			return registration.installErr
		}
		return r.ReleaseCatalog(catalog)
	}
	if registration.state == catalogReleasing {
		r.mu.Unlock()
		<-registration.done
		return registration.releaseErr
	}
	registration.users--
	if registration.users > 0 {
		r.mu.Unlock()
		return nil
	}
	registration.state = catalogReleasing
	r.mu.Unlock()
	return r.releaseCatalog(catalog, registration)
}

func disposeCatalog(cleanups []kardia.Disposable) error {
	var err error
	for i := len(cleanups) - 1; i >= 0; i-- {
		err = errors.Join(err, cleanups[i](context.Background()))
	}
	return err
}

func (r *Runtime) releaseCatalog(catalog string, registration *catalogRegistration) error {
	err := disposeCatalog(registration.cleanups)
	r.mu.Lock()
	registration.releaseErr = err
	delete(r.catalogs, catalog)
	close(registration.done)
	r.mu.Unlock()
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
		close(r.closing)
		pending := make(map[string]*catalogRegistration, len(r.catalogs))
		for catalog, registration := range r.catalogs {
			pending[catalog] = registration
		}
		r.mu.Unlock()
		go func() {
			r.registers.Wait()
			r.mu.Lock()
			owned := map[string]bool{}
			for catalog, registration := range pending {
				if registration.state == catalogReady {
					registration.state = catalogReleasing
					owned[catalog] = true
				}
			}
			r.mu.Unlock()
			for catalog, registration := range pending {
				if owned[catalog] {
					_ = r.releaseCatalog(catalog, registration)
				} else {
					<-registration.done
				}
				r.closeErr = errors.Join(r.closeErr, registration.releaseErr)
			}
			if r.root != nil {
				r.closeErr = errors.Join(r.closeErr, r.root.Fiber().Dispose(context.Background()))
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
