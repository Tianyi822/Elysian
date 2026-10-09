// list.go 完整移植 packages/utils/src/index.ts 的 List<T>（方案第 1 节裁决：
// packages/utils 不是转发包，本体落此处；packages/group 才是转发包，其本体
// Group 插件在 kardia/loader/group.go，本文件无对应产出）。
//
// List 的 push 经 ctx.effect 登记（fiber 销毁自动移除），保持插入序，
// 可过滤/映射迭代（TS 生成器方法在 Go 返回切片快照）。
package kardia

import (
	"context"
	"sync"
)

// List 对应 packages/utils List<T>。
type List[T any] struct {
	mu    sync.Mutex
	ctx   *Context
	trace string
	sn    int64
	inner map[int64]T
	order []int64
}

// NewList 构造绑定 ctx 的列表；trace 用于 effect 标签（trace+".push()"）。
func NewList[T any](ctx *Context, trace string) *List[T] {
	return &List[T]{ctx: ctx, trace: trace, inner: make(map[int64]T)}
}

// Len 返回当前元素数。
func (l *List[T]) Len() int { l.mu.Lock(); defer l.mu.Unlock(); return len(l.order) }

// Push 追加元素：经 ctx.Effect 登记（label 为 trace+".push()"），fiber
// 销毁时自动移除本条。
func (l *List[T]) Push(value T) error {
	_, err := l.ctx.Effect(l.trace+".push()", func() (Disposable, error) {
		l.mu.Lock()
		defer l.mu.Unlock()
		l.sn++
		sn := l.sn
		l.inner[sn] = value
		l.order = append(l.order, sn)
		return func(context.Context) error {
			l.mu.Lock()
			defer l.mu.Unlock()
			delete(l.inner, sn)
			for i, id := range l.order {
				if id == sn {
					l.order = append(l.order[:i], l.order[i+1:]...)
					break
				}
			}
			return nil
		}, nil
	})
	return err
}

// Values 返回插入序快照（对应 TS 的 Symbol.iterator）。
func (l *List[T]) Values() []T {
	l.mu.Lock()
	defer l.mu.Unlock()
	values := make([]T, 0, len(l.order))
	for _, id := range l.order {
		values = append(values, l.inner[id])
	}
	return values
}

// Filter 返回保留谓词命中元素的插入序切片（对应 TS 生成器 filter）。
func (l *List[T]) Filter(pred func(T) bool) []T {
	values := make([]T, 0, l.Len())
	for _, v := range l.Values() {
		if pred(v) {
			values = append(values, v)
		}
	}
	return values
}

// Map 返回映射结果（对应 TS 生成器 map）。
func (l *List[T]) Map(mapper func(T) any) []any {
	values := make([]any, 0, l.Len())
	for _, v := range l.Values() {
		values = append(values, mapper(v))
	}
	return values
}
