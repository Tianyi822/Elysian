package kardia

import (
	"context"
	"errors"
	"fmt"
)

// EffectScope 明确资源的所有者和激活代，不依赖 goroutine 的执行时机。
type EffectScope struct {
	fiber      *Fiber
	generation uint64
	parent     *effectState
	lifetime   context.Context
	cancel     context.CancelFunc
}

func newEffectScope(f *Fiber, generation uint64) *EffectScope {
	ctx, cancel := context.WithCancel(context.Background())
	return &EffectScope{fiber: f, generation: generation, lifetime: ctx, cancel: cancel}
}

// Context 返回作用域的取消信号。
func (s *EffectScope) Context() context.Context { return s.lifetime }

// Bind 让框架注册接口显式归属此作用域；只能绑定同一个 fiber。
func (s *EffectScope) Bind(c *Context) (*Context, error) {
	if c.Fiber() != s.fiber {
		return nil, fmt.Errorf("资源作用域不属于此插件")
	}
	return c.withScope(s), nil
}

type effectCleanup struct {
	fn    Disposable
	child *effectState
}

type effectState struct {
	fiber      *Fiber
	scope      *EffectScope
	meta       *EffectMeta
	children   []*effectState
	collected  []effectCleanup
	task       chan struct{}
	taskErr    error
	done       chan struct{}
	disposing  bool
	disposeErr error
	entry      *disposableEntry
	owner      *effectState
}

// EffectHandle 是资源的稳定身份。Dispose 可并发调用并共享同一次清理结果。
type EffectHandle struct{ state *effectState }

// Dispose 请求清理；ctx 只取消调用者的等待，不会取消已开始的资源回收。
func (h *EffectHandle) Dispose(ctx context.Context) error { return h.state.dispose(ctx) }

// Scope 返回子资源必须显式使用的作用域。
func (h *EffectHandle) Scope() *EffectScope { return h.state.scope }

// Wait 等待生产者完成；不会等待其常驻资源被销毁。
func (h *EffectHandle) Wait(ctx context.Context) error {
	select {
	case <-h.state.task:
		return h.state.taskErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *EffectScope) reserve(label string) (*EffectHandle, error) {
	if s == nil {
		return nil, &CordisError{Code: "INACTIVE_EFFECT"}
	}
	f := s.fiber
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.uidLive || f.closing || f.generation != s.generation || s.lifetime.Err() != nil || s.parent != nil && s.parent.disposing {
		return nil, &CordisError{Code: "INACTIVE_EFFECT"}
	}
	if label == "" {
		label = "anonymous"
	}
	lifetime, cancel := context.WithCancel(s.lifetime)
	st := &effectState{fiber: f, meta: &EffectMeta{Label: label, Children: []EffectMeta{}}, task: make(chan struct{}), done: make(chan struct{})}
	st.scope = &EffectScope{fiber: f, generation: s.generation, parent: st, lifetime: lifetime, cancel: cancel}
	if s.parent != nil {
		st.owner = s.parent
		s.parent.children = append(s.parent.children, st)
		s.parent.collected = append(s.parent.collected, effectCleanup{fn: st.dispose, child: st})
	} else {
		st.entry = f.disposables.push(st.dispose, st.meta, st)
	}
	return &EffectHandle{state: st}, nil
}

// Effect 先登记身份再执行回调，关闭过程中返回的资源仍会被回收。
func (s *EffectScope) Effect(label string, execute EffectFunc) (*EffectHandle, error) {
	h, err := s.reserve(label)
	if err != nil {
		return nil, err
	}
	d, err := safeExecute(execute)
	st := h.state
	st.fiber.mu.Lock()
	if d != nil {
		st.collected = append(st.collected, effectCleanup{fn: d})
	}
	st.taskErr = err
	close(st.task)
	st.fiber.mu.Unlock()
	if err != nil {
		return nil, h.Dispose(context.Background())
	}
	return h, nil
}

// Iter 启动协作取消的生产者；子资源通过传入的 scope 登记。
func (s *EffectScope) Iter(label string, gen func(context.Context, *EffectScope) error) (*EffectHandle, error) {
	h, err := s.reserve(label)
	if err != nil {
		return nil, err
	}
	st := h.state
	st.fiber.own.Tasks().Go(func() {
		var err error
		func() {
			defer func() {
				if v := recover(); v != nil {
					err = fmt.Errorf("生成器发生 panic: %v", v)
				}
			}()
			err = gen(st.scope.lifetime, st.scope)
		}()
		if errors.Is(err, context.Canceled) && st.scope.lifetime.Err() != nil {
			err = nil
		}
		if errors.Is(err, errEffectStopped) {
			err = nil
		}
		st.fiber.mu.Lock()
		st.taskErr = err
		close(st.task)
		st.fiber.mu.Unlock()
		if err != nil {
			st.fiber.own.Logger().Error(err)
			st.startDispose()
		}
	})
	return h, nil
}

// Defer 将清理器交给正在执行的生产者。取消后的迟到资源仍登记并回收。
func (s *EffectScope) Defer(d Disposable) error {
	if d == nil {
		return nil
	}
	if s.parent == nil {
		_, err := s.Effect("defer", func() (Disposable, error) { return d, nil })
		if err != nil {
			return errors.Join(err, safeDispose(d, context.Background()))
		}
		return nil
	}
	s.fiber.mu.Lock()
	select {
	case <-s.parent.task:
		s.fiber.mu.Unlock()
		return errors.Join(&CordisError{Code: "INACTIVE_EFFECT"}, safeDispose(d, context.Background()))
	default:
	}
	s.parent.collected = append(s.parent.collected, effectCleanup{fn: d})
	stopped := s.parent.disposing || s.lifetime.Err() != nil
	s.fiber.mu.Unlock()
	if stopped {
		return errEffectStopped
	}
	return nil
}

func (st *effectState) startDispose() {
	st.fiber.mu.Lock()
	if st.disposing {
		st.fiber.mu.Unlock()
		return
	}
	st.disposing = true
	st.scope.cancel()
	st.fiber.mu.Unlock()
	st.fiber.own.Tasks().Go(func() {
		<-st.task
		st.fiber.mu.Lock()
		items := st.collected
		st.collected = nil
		err := st.taskErr
		st.fiber.mu.Unlock()
		for i := len(items) - 1; i >= 0; i-- {
			err = errors.Join(err, safeDispose(items[i].fn, context.Background()))
		}
		st.fiber.mu.Lock()
		st.fiber.disposables.remove(st.entry)
		st.entry = nil
		if st.owner != nil {
			for i, item := range st.owner.collected {
				if item.child == st {
					copy(st.owner.collected[i:], st.owner.collected[i+1:])
					st.owner.collected[len(st.owner.collected)-1] = effectCleanup{}
					st.owner.collected = st.owner.collected[:len(st.owner.collected)-1]
					break
				}
			}
			for i, child := range st.owner.children {
				if child == st {
					copy(st.owner.children[i:], st.owner.children[i+1:])
					st.owner.children[len(st.owner.children)-1] = nil
					st.owner.children = st.owner.children[:len(st.owner.children)-1]
					break
				}
			}
		}
		st.disposeErr = err
		close(st.done)
		st.fiber.mu.Unlock()
	})
}

func (st *effectState) dispose(ctx context.Context) error {
	st.startDispose()
	select {
	case <-st.done:
		return st.disposeErr
	default:
	}
	select {
	case <-st.done:
		return st.disposeErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
