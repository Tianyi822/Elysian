package kardia

import "fmt"

// Within 报告当前上下文是否位于 ancestor 的子树中。
func (c *Context) Within(ancestor *Context) bool {
	c.chainMu.RLock()
	defer c.chainMu.RUnlock()
	for p := c; p != nil; p = p.parent {
		if p == ancestor {
			return true
		}
	}
	return false
}

// Isolation 返回服务的有效隔离标记。
func (c *Context) Isolation(name string) *Symbol { v, _ := c.isolateSym(name); return v }

// IsolationSnapshot 返回有效隔离表的独立快照。
func (c *Context) IsolationSnapshot() map[string]*Symbol {
	m := c.nearestIsolate()
	if m == nil {
		return map[string]*Symbol{}
	}
	return m.snapshot()
}

// PatchLayer 原子切换上下文层及其提供的服务槽，再在锁外通知依赖。
// 目标槽已被另一提供者占用时拒绝切换，保留原层与原实现。
func (c *Context) PatchLayer(parent *Context, isolate map[string]*Symbol, intercept map[string]any) error {
	if parent == nil || parent.root != c.root {
		return fmt.Errorf("无效的上下文父节点")
	}
	own := map[string]*Symbol{}
	for k, v := range isolate {
		own[k] = v
	}
	values := map[string]any{}
	for k, v := range intercept {
		values[k] = CloneConfig(v)
	}
	c.mu.Lock()
	if parent.Within(c) {
		c.mu.Unlock()
		return fmt.Errorf("无效的上下文父节点")
	}
	parentMap := parent.nearestIsolate()
	owned := map[*Symbol]*Impl{}
	for key, impl := range c.reflect.store {
		if impl.Fiber.Ctx().Within(c) {
			owned[key] = impl
		}
	}
	c.chainMu.Lock()
	oldParent := c.parent
	oldIntercept := c.meta.Intercept
	m := c.meta.Isolate
	created := m == nil
	if created {
		m = &IsolateMap{}
		c.meta.Isolate = m
	}
	m.mu.Lock()
	oldMapParent, oldOwn := m.parent, m.own
	m.parent, m.own = parentMap, own
	m.mu.Unlock()
	c.parent, c.meta.Intercept = parent, values
	c.chainMu.Unlock()
	moves := map[*Symbol]*Impl{}
	var conflict error
	for old, impl := range owned {
		next := impl.Fiber.Ctx().Isolation(impl.Name)
		if next == old {
			continue
		}
		if other := c.reflect.store[next]; other != nil && other != impl {
			conflict = fmt.Errorf("隔离切换失败：服务 %q 的目标已占用", impl.Name)
			break
		}
		if other := moves[next]; other != nil && other != impl {
			conflict = fmt.Errorf("隔离切换导致服务 %q 冲突", impl.Name)
			break
		}
		moves[next] = impl
	}
	if conflict != nil {
		c.chainMu.Lock()
		c.parent, c.meta.Intercept = oldParent, oldIntercept
		m.mu.Lock()
		m.parent, m.own = oldMapParent, oldOwn
		m.mu.Unlock()
		if created {
			c.meta.Isolate = nil
		}
		c.chainMu.Unlock()
		c.mu.Unlock()
		return conflict
	}
	for old, impl := range owned {
		if impl.Fiber.Ctx().Isolation(impl.Name) != old {
			delete(c.reflect.store, old)
		}
	}
	for key, impl := range moves {
		c.reflect.store[key] = impl
	}
	names := make([]string, 0, len(c.reflect.props))
	for name, prop := range c.reflect.props {
		if prop.Type == PropertyService {
			names = append(names, name)
		}
	}
	c.mu.Unlock()
	_, err := c.reflect.notify(c, names, func(*Context, string) bool { return true })
	return err
}
