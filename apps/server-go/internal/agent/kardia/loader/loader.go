package loader

import (
	"context"
	"elysian/server/internal/agent/kardia"
	"fmt"
	"net/url"
	"path/filepath"
)

// Loader 是插件树管理服务。资源归属始终取显式调用方 Context。
type Loader struct{ *EntryTree }

var Plugin = &kardia.Plugin{Name: "loader", Apply: newLoader}

func newLoader(ctx *kardia.Context, config any) (kardia.Disposable, error) {
	base := ctx.BaseURL()
	if m, ok := config.(map[string]any); ok {
		if b, ok := m["baseUrl"].(string); ok && b != "" {
			base = b
		}
	}
	if u, err := url.Parse(base); err == nil && u.Scheme == "file" {
		if u.Host != "" && u.Host != "localhost" {
			return nil, fmt.Errorf("不支持远程 file URL")
		}
		base = u.Path
	}
	base, err := filepath.Abs(base)
	if err != nil {
		return nil, fmt.Errorf("解析插件目录失败：%w", err)
	}
	l := &Loader{EntryTree: NewTree(ctx.Extend(kardia.ExtendMeta{BaseURL: base, HasBaseURL: true}))}
	if _, err := ctx.Reflect().Provide(ctx, "loader", l, l.checkReady); err != nil {
		return nil, err
	}
	if err := l.registerHooks(); err != nil {
		return nil, err
	}
	return func(dctx context.Context) error { return l.Close(dctx) }, nil
}
func (l *Loader) checkReady(access *kardia.Context, _ any) (bool, error) {
	merged := map[string]any{}
	configs := access.InterceptAll("loader")
	for i := len(configs) - 1; i >= 0; i-- {
		if m, ok := configs[i].(map[string]any); ok {
			for k, v := range m {
				merged[k] = v
			}
		}
	}
	if await, _ := merged["await"].(bool); await {
		for _, e := range l.Entries() {
			f := e.Fiber()
			if f == access.Fiber() {
				continue
			}
			if e.readinessPending() {
				return false, nil
			}
			if f != nil && f.Inertia() != nil {
				return false, nil
			}
		}
	}

	return true, nil
}
func (l *Loader) Load(access *kardia.Context, p *kardia.Plugin, config any) (*kardia.Fiber, error) {
	if access == nil {
		return nil, fmt.Errorf("装载插件必须提供调用方上下文")
	}
	if access.Root() != l.Ctx.Root() {
		return nil, fmt.Errorf("调用方不属于此插件运行时")
	}
	return access.Plugin(p, config)
}
func (l *Loader) registerHooks() error {
	ctx := l.Ctx
	// 加载开始时再核对最新意向，封住提交发生于快照读取和启动加载之间的窗口。
	if _, err := ctx.On(kardia.StringEvent("internal/status"), func(ev *kardia.EventCtx) (any, error) {
		if len(ev.Args) == 0 {
			return nil, nil
		}
		f, ok := ev.Args[0].(*kardia.Fiber)
		if !ok {
			return nil, nil
		}
		e := EntryOfFiber(f)
		if e == nil {
			return nil, nil
		}
		e.state.mu.Lock()
		if e.fiber == f && e.running && runtimeChanged(e.runningOptions, e.options, e.runningParent, e.parent) && f.CancelLoading() {
			e.restartRequired = true
		}
		e.state.mu.Unlock()
		return nil, nil
	}, kardia.EventOptions{Global: true}); err != nil {
		return err
	}
	if _, err := ctx.On(kardia.StringEvent("internal/update"), func(ev *kardia.EventCtx) (any, error) {
		f, ok := ev.This.(*kardia.Fiber)
		if !ok || ev.Next == nil {
			return nil, fmt.Errorf("internal/update 的调用方必须是插件 fiber")
		}
		e := EntryOfFiber(f)
		noSave := false
		if len(ev.Args) > 1 {
			noSave, _ = ev.Args[1].(bool)
		}
		if e == nil || noSave || e.Fiber() != f {
			return ev.Next()
		}
		var cfg any
		if len(ev.Args) > 0 {
			cfg = ev.Args[0]
		}
		if rt := f.Runtime(); rt != nil && rt.Simplify != nil {
			cfg = rt.Simplify(cfg)
		}
		e.state.mu.Lock()
		legacy := CloneOptions(e.options)
		e.options = CloneOptions(e.options)
		e.options.Config = deepCopyValue(cfg)
		e.state.revision++
		e.revision = e.state.revision
		e.parent.replaceOptionsLocked(e)
		tree := e.parent.Tree()
		change := tree.changeLocked(e, legacy, nil, false)
		e.state.mu.Unlock()
		tree.commit(change)
		return ev.Next()
	}, kardia.EventOptions{Global: true, Prepend: true}); err != nil {
		return err
	}
	if _, err := ctx.On(kardia.StringEvent("internal/update"), func(ev *kardia.EventCtx) (any, error) {
		if ev.Next == nil {
			return nil, fmt.Errorf("更新监听缺少后续处理器")
		}
		if f, ok := ev.This.(*kardia.Fiber); ok {
			if e := EntryOfFiber(f); e != nil && e.Fiber() == f {
				l.ShowLog(e, "重新加载")
			}
		}
		return ev.Next()
	}, kardia.EventOptions{Global: true}); err != nil {
		return err
	}
	_, err := ctx.On(kardia.StringEvent("internal/plugin"), func(ev *kardia.EventCtx) (any, error) {
		if len(ev.Args) == 0 {
			return nil, nil
		}
		fiber, ok := ev.Args[0].(*kardia.Fiber)
		if !ok {
			return nil, nil
		}
		e := EntryOfFiber(fiber)
		if e == nil {
			return nil, nil
		}
		if fiber.UID() != nil {
			fiber.MergeInject(e.Options().Inject)
			return nil, nil
		}
		if e.Fiber() != fiber {
			return nil, nil
		}
		rt := fiber.Runtime()
		if rt == nil || !ctx.Registry().Has(rt.Callback) {
			return nil, nil
		}
		parent := e.Parent()
		if parent == nil {
			return nil, nil
		}
		if owner := parent.Tree().Ctx.Fiber(); owner != nil && owner.UID() == nil {
			return nil, nil
		}
		e.state.mu.Lock()
		tree := e.parent.Tree()
		if e.removed || tree.store[e.options.ID] != e || e.disabledLocked() {
			e.state.mu.Unlock()
			return nil, nil
		}
		legacy := CloneOptions(e.options)
		e.options = CloneOptions(e.options)
		disabled := true
		e.options.Disabled = &disabled
		e.state.revision++
		e.revision = e.state.revision
		e.parent.replaceOptionsLocked(e)
		change := tree.changeLocked(e, legacy, nil, false)
		e.state.mu.Unlock()
		tree.commit(change)
		return nil, nil
	})
	return err
}
func (l *Loader) ShowLog(e *Entry, typ string) {
	if e == nil {
		return
	}
	o := e.Options()
	parent := e.Parent()
	if parent == nil || o.Group != nil && *o.Group || !parent.Tree().EnableLogs() {
		return
	}
	l.Ctx.Root().Logger("loader").Info(fmt.Sprintf("%s插件 %s", typ, o.Name))
}
