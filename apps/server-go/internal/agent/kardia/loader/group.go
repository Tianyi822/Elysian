package loader

import (
	"context"
	"elysian/server/internal/agent/kardia"
	"errors"
	"fmt"
	"sync/atomic"
)

// EntryGroup 的 Ctx/Tree 是固定引用，成员列表通过 Data 返回深复制快照。
type EntryGroup struct {
	Ctx  *kardia.Context
	tree atomic.Pointer[EntryTree]
	data []*EntryOptions
}

func newEntryGroup(ctx *kardia.Context, tree *EntryTree) *EntryGroup {
	g := &EntryGroup{Ctx: ctx}
	g.tree.Store(tree)
	return g
}
func (g *EntryGroup) Tree() *EntryTree { return g.tree.Load() }
func (g *EntryGroup) Data() []*EntryOptions {
	g.Tree().state.mu.RLock()
	defer g.Tree().state.mu.RUnlock()
	return cloneEntries(g.data)
}
func cloneEntries(list []*EntryOptions) []*EntryOptions {
	out := make([]*EntryOptions, len(list))
	for i, o := range list {
		out[i] = CloneOptions(o)
	}
	return out
}
func (g *EntryGroup) syncOwnerConfigLocked() {
	e := EntryOf(g.Ctx)
	if e == nil || e.options.Group == nil || !*e.options.Group {
		return
	}
	e.options = CloneOptions(e.options)
	e.options.Config = cloneEntries(g.data)
	if e.parent != nil {
		e.parent.replaceOptionsLocked(e)
	}
}
func (g *EntryGroup) replaceOptionsLocked(e *Entry) {
	for i, o := range g.data {
		if o.ID == e.options.ID {
			g.data[i] = CloneOptions(e.options)
			break
		}
	}
	g.syncOwnerConfigLocked()
}
func (g *EntryGroup) unlinkLocked(id string) {
	for i, o := range g.data {
		if o.ID == id {
			g.data = append(g.data[:i], g.data[i+1:]...)
			break
		}
	}
}
func (g *EntryGroup) removeLocked(e *Entry, keep bool) {
	e.removed = true
	e.revision = g.Tree().state.revision
	e.ensureTaskLocked()
	delete(g.Tree().store, e.options.ID)
	g.Tree().removeOrderLocked(e.options.ID)
	for _, key := range e.realms {
		g.Tree().state.releaseRealmLocked(key)
	}
	e.realms = nil
	if !keep {
		g.unlinkLocked(e.options.ID)
		g.syncOwnerConfigLocked()
	}
}

// Update 完整替换期望配置，并等待每个受影响条目的运行时调和完成。
func (g *EntryGroup) Update(ctx context.Context, config []*EntryOptions) error {
	return g.update(ctx, config, nil, false)
}

// UpdateRevision 仅在树仍为 expected 时接受配置，供持久化调和器避免旧快照回写。
func (g *EntryGroup) UpdateRevision(ctx context.Context, config []*EntryOptions, expected uint64) error {
	return g.update(ctx, config, &expected, false)
}
func (g *EntryGroup) update(ctx context.Context, config []*EntryOptions, expected *uint64, internal bool) error {
	if expected != nil {
		if err := g.Tree().waitCommits(ctx); err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	l, err := g.Tree().resolveLoader()
	if err != nil {
		return err
	}
	parsed, err := ParseEntries(config)
	if err != nil {
		return err
	}
	next := cloneEntries(parsed)
	state := g.Tree().state
	state.mu.Lock()
	if g.Tree().closed || g.Tree().sealed && !internal {
		state.mu.Unlock()
		return ErrTreeClosed
	}
	// 组插件的输入可能来自较早的运行时激活；始终以该条目的最新期望配置调和。
	if owner := EntryOf(g.Ctx); owner != nil && owner.subgroup == g && owner.parent != nil && owner.parent.Tree() == g.Tree() {
		if owner.removed {
			state.mu.Unlock()
			return nil
		}
		latest, ok := AsEntries(owner.options.Config)
		if !ok {
			state.mu.Unlock()
			return fmt.Errorf("组配置必须是条目数组")
		}
		next = cloneEntries(latest)
	}
	if expected != nil && (state.revision != *expected || state.dispatching || len(state.commits) > 0) {
		state.mu.Unlock()
		return ErrStaleRevision
	}
	seen := map[string]bool{}
	for _, o := range next {
		if o == nil {
			state.mu.Unlock()
			return fmt.Errorf("组配置不能包含空条目")
		}
		g.Tree().ensureIDLocked(o)
		if seen[o.ID] {
			state.mu.Unlock()
			return fmt.Errorf("组配置包含重复条目 ID %s", o.ID)
		}
		seen[o.ID] = true
	}
	state.revision++
	var work []*Entry
	for _, o := range g.data {
		if !seen[o.ID] {
			if e := g.Tree().store[o.ID]; e != nil && e.parent == g {
				g.removeLocked(e, true)
				work = append(work, e)
			}
		}
	}
	g.data = next
	for _, o := range next {
		e := g.Tree().store[o.ID]
		if e == nil {
			e = g.Tree().newEntryLocked(l, g, o)
		} else {
			if e.parent != g {
				e.parent.unlinkLocked(o.ID)
				e.parent.syncOwnerConfigLocked()
				e.parent = g
			}
			e.options = CloneOptions(o)
			e.revision = state.revision
			e.ensureTaskLocked()
		}
		work = append(work, e)
	}
	g.syncOwnerConfigLocked()
	state.mu.Unlock()
	var errs []error
	for _, e := range work {
		var err error
		if e.Disabled() || e.isRemoved() {
			err = e.stopAndReconcile(ctx)
		} else {
			err = e.reconcile(ctx)
		}
		if err != nil {
			errs = append(errs, err)
		}
	}
	// 所有条目稳定后刷新 loader.await 的等待者，调用方视角由服务检查器决定。
	if _, err := g.Ctx.Reflect().Notify(g.Ctx, []string{"loader"}); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
func (g *EntryGroup) Stop(ctx context.Context) error {
	state := g.Tree().state
	state.mu.Lock()
	state.revision++
	var work []*Entry
	for _, o := range g.data {
		if e := g.Tree().store[o.ID]; e != nil && e.parent == g {
			g.removeLocked(e, true)
			work = append(work, e)
		}
	}
	state.mu.Unlock()
	var errs []error
	for _, e := range work {
		var err error
		if e.Disabled() || e.isRemoved() {
			err = e.stopAndReconcile(ctx)
		} else {
			err = e.reconcile(ctx)
		}
		if err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

var Group = &kardia.Plugin{Name: "@cordisjs/plugin-group", Apply: newGroup}

func newGroup(ctx *kardia.Context, config any) (kardia.Disposable, error) {
	e := EntryOf(ctx)
	if e == nil || e.Parent() == nil {
		return nil, fmt.Errorf("group 插件必须在条目上下文中装载")
	}
	list, ok := AsEntries(config)
	if !ok {
		return nil, fmt.Errorf("组配置必须是条目数组")
	}
	g := newEntryGroup(ctx, e.Parent().Tree())
	e.state.mu.Lock()
	e.subgroup = g
	e.state.mu.Unlock()
	if _, err := ctx.On(kardia.StringEvent("internal/update"), func(ev *kardia.EventCtx) (any, error) {
		if len(ev.Args) == 0 {
			return nil, nil
		}
		next, ok := AsEntries(ev.Args[0])
		if !ok {
			return nil, fmt.Errorf("组配置必须是条目数组")
		}
		if err := g.update(ctx.Lifetime(), next, nil, true); err != nil {
			return nil, err
		}
		return true, nil
	}); err != nil {
		return nil, err
	}
	if err := g.update(ctx.Lifetime(), list, nil, true); err != nil {
		_ = g.Stop(context.Background())
		return nil, err
	}
	return func(dctx context.Context) error { return g.Stop(dctx) }, nil
}
