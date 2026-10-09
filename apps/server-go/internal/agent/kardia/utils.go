// utils.go 对应 TS core/src/utils.ts 的可移植部分：DisposableList、Tracker、
// IsolateMap 与 Task 接口。Proxy 影子机制（createTraceable/createShadow/
// withProps）以 Context 显式原语重表达（方案 2.1，差异清单第 8 条）；长栈追踪
// 辅助（composeError/buildOuterStack/handleError）不移植（差异清单第 5 条）。
package kardia

import (
	"context"
	"strconv"
	"strings"
	"sync"
)

// Task 是可等待的异步工作句柄（Fiber 的 inertia、Entry 的 _initTask 都实现它）。
type Task interface {
	Wait(ctx context.Context) error
}

// Tracker 对应 TS Tracker（utils.ts:41-45）。
type Tracker struct {
	Associate string
	Property  string
	NoShadow  bool
}

// dlEntry 是 DisposableList 的内部条目，保持插入序。
type dlEntry[T comparable] struct {
	sn    uint64
	value T
}

// DisposableList 对应 core/src/utils.ts:4-39（TS WeakMap 反查改普通 map，
// 差异清单第 6 条；因此约束 T 可比较）。本类型的读写
// 自行加锁，返回值均为独立的列表快照。
type DisposableList[T comparable] struct {
	mu    sync.Mutex
	sn    uint64
	order []dlEntry[T]
	index map[T]uint64 // 值→最近一次登记的序号（TS WeakMap 的等价物）
}

// Len 返回当前长度。
func (l *DisposableList[T]) Len() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.order) }

// Push 追加一个值并返回移除函数（按登记序号移除该次登记）。
func (l *DisposableList[T]) Push(v T) func() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sn++
	sn := l.sn
	l.order = append(l.order, dlEntry[T]{sn: sn, value: v})
	if l.index == nil {
		l.index = make(map[T]uint64)
	}
	l.index[v] = sn
	return func() { l.deleteSN(sn) }
}

// Delete 按值删除最近一次登记，返回是否删除成功。
func (l *DisposableList[T]) Delete(v T) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	sn, ok := l.index[v]
	if !ok {
		return false
	}
	for i, e := range l.order {
		if e.sn == sn {
			l.removeAt(i)
			return true
		}
	}
	return false
}

// Clear 清空并按插入序逆序返回（TS clear 的 dispose 顺序）。
func (l *DisposableList[T]) Clear() []T {
	l.mu.Lock()
	defer l.mu.Unlock()
	values := make([]T, 0, len(l.order))
	for _, e := range l.order {
		values = append(values, e.value)
	}
	l.order = nil
	l.index = make(map[T]uint64)
	for i, j := 0, len(values)-1; i < j; i, j = i+1, j-1 {
		values[i], values[j] = values[j], values[i]
	}
	return values
}

// Values 返回插入序快照。
func (l *DisposableList[T]) Values() []T {
	l.mu.Lock()
	defer l.mu.Unlock()
	values := make([]T, 0, len(l.order))
	for _, e := range l.order {
		values = append(values, e.value)
	}
	return values
}

func (l *DisposableList[T]) deleteSN(sn uint64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, e := range l.order {
		if e.sn == sn {
			l.removeAt(i)
			return
		}
	}
}

func (l *DisposableList[T]) removeAt(i int) {
	e := l.order[i]
	l.order = append(l.order[:i], l.order[i+1:]...)
	if sn, ok := l.index[e.value]; ok && sn == e.sn {
		delete(l.index, e.value)
	}
}

// IsolateMap 对应 ctx[symbols.isolate]：链式（原型链）名字→符号表。
// 每层独立加锁，父链变更由 Context.PatchLayer 协调。
type IsolateMap struct {
	mu     sync.RWMutex
	parent *IsolateMap
	own    map[string]*Symbol
}

// Lookup 沿链查名字（TS 原型链属性查找）。
func (m *IsolateMap) Lookup(name string) (*Symbol, bool) {
	for cur := m; cur != nil; {
		cur.mu.RLock()
		v, ok := cur.own[name]
		parent := cur.parent
		cur.mu.RUnlock()
		if ok {
			return v, true
		}
		cur = parent
	}
	return nil, false
}

// Set 设置本层隔离标记。
func (m *IsolateMap) Set(name string, sym *Symbol) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.own == nil {
		m.own = map[string]*Symbol{}
	}
	m.own[name] = sym
}

// Ensure 原子创建本层标记；父层已存在时复用。
func (m *IsolateMap) Ensure(name string, mk func() *Symbol) *Symbol {
	if v, ok := m.Lookup(name); ok {
		return v
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if v, ok := m.own[name]; ok {
		return v
	}
	if m.own == nil {
		m.own = map[string]*Symbol{}
	}
	v := mk()
	m.own[name] = v
	return v
}
func (m *IsolateMap) child() *IsolateMap { return &IsolateMap{parent: m} }
func (m *IsolateMap) snapshot() map[string]*Symbol {
	out := map[string]*Symbol{}
	for cur := m; cur != nil; {
		cur.mu.RLock()
		for k, v := range cur.own {
			if _, ok := out[k]; !ok {
				out[k] = v
			}
		}
		parent := cur.parent
		cur.mu.RUnlock()
		cur = parent
	}
	return out
}

// reservedWords 对应 TS RESERVED_WORDS（reflect.ts:27）加 constructor：TS
// 侧 ctx.constructor 经 Reflect.has 命中 Object.prototype.constructor 直通
// 不报错（reflect.spec 的 access check），Go 无原型链，并入保留字表走
// 直通路径承载同一行为。
var reservedWords = map[string]bool{"prototype": true, "then": true, "constructor": true}

// isSpecialProperty 对应 reflect.ts:33-38 的 isSpecialProperty：保留字、
// 数字串或下划线前缀的属性名走普通读写路径，不参与服务解析。
func isSpecialProperty(name string) bool {
	if reservedWords[name] {
		return true
	}
	if strings.HasPrefix(name, "_") {
		return true
	}
	if n, err := strconv.Atoi(name); err == nil && strconv.Itoa(n) == name {
		return true
	}
	return false
}

// noopDisposable 返回幂等的空清理器。
func noopDisposable() Disposable {
	return func(context.Context) error { return nil }
}
