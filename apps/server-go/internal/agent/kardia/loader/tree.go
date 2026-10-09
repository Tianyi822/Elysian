// Package loader 将声明式插件配置调和到 Kardia 运行时。
package loader

import (
	"context"
	"crypto/rand"
	"elysian/server/internal/agent/kardia"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
)

var EntryKey = kardia.NewSymbol("cordis.entry")

const TreeSep = ":"

var ErrStaleRevision = errors.New("配置树已更新，请重新调和")
var ErrTreeClosed = errors.New("配置树已关闭")
var registryMu sync.RWMutex
var registry = map[string]*kardia.Plugin{}

func Register(name string, p *kardia.Plugin) {
	registryMu.Lock()
	registry[name] = p
	registryMu.Unlock()
}
func RegisterFunc(name string, apply kardia.PluginCallback) {
	Register(name, &kardia.Plugin{Name: name, Apply: apply})
}
func Lookup(name string) (*kardia.Plugin, bool) {
	registryMu.RLock()
	defer registryMu.RUnlock()
	p, ok := registry[name]
	return p, ok
}
func RandomID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(fmt.Errorf("生成条目 ID 失败：%w", err))
	}
	return hex.EncodeToString(b[:4])
}

// EntryChange 是提交时冻结的事实，不依赖之后变化的组数据或条目指针。
type EntryChange struct {
	ID       string
	Group    *EntryGroup
	From     *EntryGroup
	Options  *EntryOptions
	Legacy   *EntryOptions
	Parent   *string
	Position int
	Revision uint64
}
type realmRef struct {
	symbol *kardia.Symbol
	refs   int
}
type commitRecord struct {
	tree   *EntryTree
	change EntryChange
}
type treeState struct {
	mu          sync.RWMutex
	revision    uint64
	realms      map[string]*realmRef
	commits     []commitRecord
	dispatching bool
	commitIdle  chan struct{}
}

func (s *treeState) releaseRealmLocked(key string) {
	if r := s.realms[key]; r != nil {
		r.refs--
		if r.refs == 0 {
			delete(s.realms, key)
		}
	}
}

// EntryTree 的树族共享一把状态锁；回调、插件执行、等待与文件 I/O 均在锁外。
type EntryTree struct {
	Ctx        *kardia.Context
	Root       *EntryGroup
	state      *treeState
	store      map[string]*Entry
	order      []string
	enableLogs bool
	commitFn   func(EntryChange)
	closed     bool
	sealed     bool
}

func NewTree(ctx *kardia.Context) *EntryTree {
	state := &treeState{realms: map[string]*realmRef{}}
	if e := EntryOf(ctx); e != nil {
		state = e.state
	}
	t := &EntryTree{Ctx: ctx, state: state, store: map[string]*Entry{}}
	t.Root = newEntryGroup(ctx, t)
	if e := EntryOf(ctx); e != nil {
		state.mu.Lock()
		e.subtree = t
		state.mu.Unlock()
	}
	return t
}
func (t *EntryTree) SetCommit(fn func(EntryChange)) {
	t.state.mu.Lock()
	t.commitFn = fn
	t.state.mu.Unlock()
}
func (t *EntryTree) SetEnableLogs(v bool) { t.state.mu.Lock(); t.enableLogs = v; t.state.mu.Unlock() }
func (t *EntryTree) EnableLogs() bool {
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	return t.enableLogs
}
func (t *EntryTree) Revision() uint64 {
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	return t.state.revision
}
func (t *EntryTree) Entry(id string) *Entry {
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	return t.store[id]
}
func (t *EntryTree) StoreSnapshot() map[string]*Entry {
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	out := map[string]*Entry{}
	for k, v := range t.store {
		out[k] = v
	}
	return out
}

// commit 派发已在状态锁内冻结并入队的变更，允许回调重入而不持锁。
func (t *EntryTree) commit(_ EntryChange) {
	s := t.state
	s.mu.Lock()
	if s.dispatching {
		s.mu.Unlock()
		return
	}
	s.dispatching = true
	s.commitIdle = make(chan struct{})
	s.mu.Unlock()
	for {
		s.mu.Lock()
		if len(s.commits) == 0 {
			s.dispatching = false
			close(s.commitIdle)
			s.commitIdle = nil
			s.mu.Unlock()
			return
		}
		item := s.commits[0]
		s.commits[0] = commitRecord{}
		s.commits = s.commits[1:]
		fn := item.tree.commitFn
		s.mu.Unlock()
		if fn != nil {
			fn(item.change)
		}
	}
}
func (t *EntryTree) Entries() []*Entry {
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	return t.entriesLocked()
}
func (t *EntryTree) entriesLocked() []*Entry {
	var out []*Entry
	for _, id := range t.order {
		e := t.store[id]
		if e == nil {
			continue
		}
		out = append(out, e)
		if e.subtree != nil {
			out = append(out, e.subtree.entriesLocked()...)
		}
	}
	return out
}
func (t *EntryTree) GetTasks() []kardia.Task {
	var out []kardia.Task
	for _, e := range t.Entries() {
		if task := e.pendingTask(); task != nil {
			out = append(out, task)
			continue
		}
		if f := e.Fiber(); f != nil {
			if task := f.Inertia(); task != nil {
				out = append(out, task)
			}
		}
	}
	return out
}
func (t *EntryTree) Await(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		tasks := t.GetTasks()
		if len(tasks) == 0 {
			return nil
		}
		for _, task := range tasks {
			if err := task.Wait(ctx); err != nil {
				return err
			}
		}
	}
}
func (t *EntryTree) EnsureID(o *EntryOptions) string {
	t.state.mu.Lock()
	defer t.state.mu.Unlock()
	return t.ensureIDLocked(o)
}
func (t *EntryTree) ensureIDLocked(o *EntryOptions) string {
	if o.ID != "" {
		return o.ID
	}
	for {
		id := RandomID()
		if t.store[id] == nil {
			o.ID = id
			return id
		}
	}
}
func splitID(id string) []string {
	var parts []string
	start := 0
	for i := 0; i < len(id); i++ {
		if id[i] == ':' {
			parts = append(parts, id[start:i])
			start = i + 1
		}
	}
	return append(parts, id[start:])
}
func (t *EntryTree) Resolve(id string) (*Entry, error) {
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	return t.resolveLocked(id)
}
func (t *EntryTree) resolveLocked(id string) (*Entry, error) {
	parts := splitID(id)
	tree := t
	for _, part := range parts[:len(parts)-1] {
		e := tree.store[part]
		if e == nil || e.subtree == nil {
			return nil, fmt.Errorf("无法解析条目 %s", id)
		}
		tree = e.subtree
	}
	e := tree.store[parts[len(parts)-1]]
	if e == nil {
		return nil, fmt.Errorf("无法解析条目 %s", id)
	}
	return e, nil
}
func (t *EntryTree) ResolveGroup(id *string) (*EntryGroup, error) {
	t.state.mu.RLock()
	defer t.state.mu.RUnlock()
	return t.resolveGroupLocked(id)
}
func (t *EntryTree) resolveGroupLocked(id *string) (*EntryGroup, error) {
	if id == nil || *id == "" {
		return t.Root, nil
	}
	e, err := t.resolveLocked(*id)
	if err != nil {
		return nil, err
	}
	if e.subgroup == nil {
		return nil, fmt.Errorf("条目 %s 不是组", *id)
	}
	return e.subgroup, nil
}
func (t *EntryTree) resolveLoader() (*Loader, error) {
	v, err := t.Ctx.Get("loader")
	if err != nil {
		return nil, err
	}
	l, ok := v.(*Loader)
	if !ok || l == nil {
		return nil, fmt.Errorf("loader 服务类型异常：%T", v)
	}
	return l, nil
}
func (t *EntryTree) newEntryLocked(l *Loader, g *EntryGroup, o *EntryOptions) *Entry {
	e := &Entry{Loader: l, state: t.state, parent: g, options: CloneOptions(o), revision: t.state.revision}
	e.ensureTaskLocked()
	e.Ctx = l.Ctx.Extend(kardia.ExtendMeta{Props: map[any]any{EntryKey: e}})
	t.store[o.ID] = e
	t.order = append(t.order, o.ID)
	return e
}
func (t *EntryTree) changeLocked(e *Entry, legacy *EntryOptions, from *EntryGroup, removed bool) EntryChange {
	change := EntryChange{ID: e.options.ID, Group: e.parent, From: from, Legacy: CloneOptions(legacy), Revision: t.state.revision, Position: -1}
	if !removed {
		change.Options = CloneOptions(e.options)
		for i, o := range e.parent.data {
			if o.ID == e.options.ID {
				change.Position = i
				break
			}
		}
	}
	if legacy == nil || from != nil {
		parent := ""
		if owner := EntryOf(e.parent.Ctx); owner != nil && owner.parent != nil && owner.parent.Tree() == e.parent.Tree() {
			parent = owner.options.ID
		}
		change.Parent = &parent
	}
	t.state.commits = append(t.state.commits, commitRecord{tree: t, change: change})
	return change
}
func (t *EntryTree) Create(ctx context.Context, o EntryOptions, parent *string, position int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	l, err := t.resolveLoader()
	if err != nil {
		return "", err
	}
	options := CloneOptions(&o)
	if err := validateEntryShape(options); err != nil {
		return "", err
	}
	t.state.mu.Lock()
	g, err := t.resolveGroupLocked(parent)
	if err == nil && (t.sealed || t.closed || g.Tree().sealed || g.Tree().closed) {
		err = ErrTreeClosed
	}
	if err != nil {
		t.state.mu.Unlock()
		return "", err
	}
	g.Tree().ensureIDLocked(options)
	if g.Tree().store[options.ID] != nil {
		t.state.mu.Unlock()
		return "", fmt.Errorf("条目 ID %s 已存在", options.ID)
	}
	t.state.revision++
	e := g.Tree().newEntryLocked(l, g, options)
	if position < 0 {
		position = len(g.data)
	}
	g.data = spliceInsertOptions(g.data, position, CloneOptions(options))
	g.syncOwnerConfigLocked()
	change := g.Tree().changeLocked(e, nil, nil, false)
	id := e.idLocked()
	t.state.mu.Unlock()
	g.Tree().commit(change)
	err = e.reconcile(ctx)
	return id, err
}
func (t *EntryTree) Remove(ctx context.Context, id string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	t.state.mu.Lock()
	e, err := t.resolveLocked(id)
	if err != nil {
		t.state.mu.Unlock()
		return err
	}
	g := e.parent
	if t.sealed || t.closed || g.Tree().sealed || g.Tree().closed {
		t.state.mu.Unlock()
		return ErrTreeClosed
	}
	legacy := CloneOptions(e.options)
	t.state.revision++
	g.removeLocked(e, false)
	change := g.Tree().changeLocked(e, legacy, nil, true)
	t.state.mu.Unlock()
	g.Tree().commit(change)
	return e.stopAndReconcile(ctx)
}
func (t *EntryTree) Update(ctx context.Context, id string, patch EntryPatch, parent *string, position *int) error {
	e, err := t.prepareUpdate(ctx, id, patch, parent, position)
	if err != nil {
		return err
	}
	if e.Disabled() {
		return e.stopAndReconcile(ctx)
	}
	return e.reconcile(ctx)
}
func (t *EntryTree) prepareUpdate(ctx context.Context, id string, patch EntryPatch, parent *string, position *int) (*Entry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	t.state.mu.Lock()
	e, err := t.resolveLocked(id)
	if err != nil {
		t.state.mu.Unlock()
		return nil, err
	}
	source, target := e.parent, e.parent
	if t.sealed || t.closed || source.Tree().sealed || source.Tree().closed {
		t.state.mu.Unlock()
		return nil, ErrTreeClosed
	}
	legacy := CloneOptions(e.options)
	next := CloneOptions(e.options)
	if err = patch.apply(next); err != nil {
		t.state.mu.Unlock()
		return nil, err
	}
	if parent != nil {
		target, err = t.resolveGroupLocked(parent)
		if err == nil && (target.Tree().sealed || target.Tree().closed) {
			err = ErrTreeClosed
		}
		if err != nil {
			t.state.mu.Unlock()
			return nil, err
		}
		for owner := EntryOf(target.Ctx); owner != nil; {
			if owner == e {
				t.state.mu.Unlock()
				return nil, fmt.Errorf("不能把条目移入自身或后代组")
			}
			if owner.parent == nil {
				break
			}
			owner = EntryOf(owner.parent.Ctx)
		}
		if source.Tree() != target.Tree() {
			for _, moving := range source.Tree().moveMembersLocked(e) {
				if target.Tree().store[moving.options.ID] != nil {
					t.state.mu.Unlock()
					return nil, fmt.Errorf("目标树已有条目 %s", moving.options.ID)
				}
			}
		}
	}
	t.state.revision++
	e.revision = t.state.revision
	e.ensureTaskLocked()
	e.options = next
	var from *EntryGroup
	if parent != nil {
		source.unlinkLocked(legacy.ID)
		if source != target {
			from = source
		}
		if source.Tree() != target.Tree() {
			for _, moving := range source.Tree().moveMembersLocked(e) {
				delete(source.Tree().store, moving.options.ID)
				source.Tree().removeOrderLocked(moving.options.ID)
				target.Tree().store[moving.options.ID] = moving
				target.Tree().order = append(target.Tree().order, moving.options.ID)
				if moving.subgroup != nil && moving.subgroup.Tree() == source.Tree() {
					moving.subgroup.tree.Store(target.Tree())
				}
			}
		}
		pos := len(target.data)
		if position != nil {
			pos = *position
		}
		target.data = spliceInsertOptions(target.data, pos, CloneOptions(next))
		e.parent = target
		source.syncOwnerConfigLocked()
		target.syncOwnerConfigLocked()
	} else {
		target.replaceOptionsLocked(e)
	}
	change := target.Tree().changeLocked(e, legacy, from, false)
	var removal EntryChange
	if source.Tree() != target.Tree() {
		removal = EntryChange{ID: legacy.ID, Group: source, Legacy: legacy, Position: -1, Revision: t.state.revision}
		t.state.commits = append(t.state.commits, commitRecord{tree: source.Tree(), change: removal})
	}
	t.state.mu.Unlock()
	if source.Tree() != target.Tree() {
		source.Tree().commit(removal)
	}
	target.Tree().commit(change)
	return e, nil
}
func (t *EntryTree) Import(name string) (*kardia.Plugin, error) {
	if p, ok := Lookup(name); ok && p != nil {
		return p, nil
	}
	return nil, fmt.Errorf("无法导入插件 %q：尚未注册", name)
}
func (t *EntryTree) removeOrderLocked(id string) {
	for i, k := range t.order {
		if k == id {
			t.order = append(t.order[:i], t.order[i+1:]...)
			return
		}
	}
}
func spliceInsertOptions(list []*EntryOptions, pos int, o *EntryOptions) []*EntryOptions {
	if pos > len(list) {
		pos = len(list)
	}
	if pos < 0 {
		pos = 0
	}
	list = append(list, nil)
	copy(list[pos+1:], list[pos:])
	list[pos] = o
	return list
}
func EntryOf(ctx *kardia.Context) *Entry {
	if ctx == nil {
		return nil
	}
	if v, ok := ctx.Prop(EntryKey); ok {
		e, _ := v.(*Entry)
		return e
	}
	return nil
}
func EntryOfFiber(f *kardia.Fiber) *Entry {
	if f == nil {
		return nil
	}
	return EntryOf(f.Ctx())
}

// SubmitUpdate 异步接纳配置更新，返回明确的完成任务。Wait 的取消只影响等待者。
func (t *EntryTree) SubmitUpdate(id string, patch EntryPatch, parent *string, position *int) kardia.Task {
	e, err := t.prepareUpdate(context.Background(), id, patch, parent, position)
	if err != nil {
		task := &entryTask{done: make(chan struct{}), err: err}
		close(task.done)
		return task
	}
	if e.Disabled() {
		if f := e.Fiber(); f != nil {
			f.CancelActivation()
		}
	}
	return e.submitReconcile()
}

// Close 永久关闭此配置树，拒绝新写入并清理所有已接纳的条目。
func (t *EntryTree) Close(ctx context.Context) error {
	if err := t.Seal(ctx); err != nil {
		return err
	}
	t.state.mu.Lock()
	t.closed = true
	t.state.revision++
	t.state.mu.Unlock()
	err := t.Root.Stop(ctx)
	if err == nil {
		t.state.mu.Lock()
		if owner := EntryOf(t.Ctx); owner != nil && owner.subtree == t {
			owner.subtree = nil
		}
		t.state.mu.Unlock()
	}
	return err
}

// moveMembersLocked 包含条目和同树的组后代；include 子树保留自己的文件边界。
func (t *EntryTree) moveMembersLocked(e *Entry) []*Entry {
	out := []*Entry{e}
	if e.subgroup != nil && e.subgroup.Tree() == t {
		for _, o := range e.subgroup.data {
			if child := t.store[o.ID]; child != nil && child.parent == e.subgroup {
				out = append(out, t.moveMembersLocked(child)...)
			}
		}
	}
	return out
}

// Seal 关闭写入准入并等待已接纳的提交派发完毕，不卸载插件。
func (t *EntryTree) Seal(ctx context.Context) error {
	t.state.mu.Lock()
	t.sealed = true
	t.state.revision++
	t.state.mu.Unlock()
	return t.waitCommits(ctx)
}
func (t *EntryTree) waitCommits(ctx context.Context) error {
	for {
		t.state.mu.RLock()
		busy, pending, ch := t.state.dispatching, len(t.state.commits) > 0, t.state.commitIdle
		t.state.mu.RUnlock()
		if !busy {
			if !pending {
				return nil
			}
			t.commit(EntryChange{})
			continue
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// SnapshotRevision 等待此前接纳的变更进入提交回调后再返回版本；持久化端必须用
// 此版本配合自己的配置/账本快照，避免把新版本号与尚未提交的旧账本配对。
func (t *EntryTree) SnapshotRevision(ctx context.Context) (uint64, error) {
	for {
		if err := t.waitCommits(ctx); err != nil {
			return 0, err
		}
		t.state.mu.RLock()
		if !t.state.dispatching && len(t.state.commits) == 0 {
			revision := t.state.revision
			t.state.mu.RUnlock()
			return revision, nil
		}
		t.state.mu.RUnlock()
	}
}
