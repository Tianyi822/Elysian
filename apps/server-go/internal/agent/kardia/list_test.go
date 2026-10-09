package kardia

import (
	"context"
	"testing"
)

// 对应 packages/utils 的 List<T>（无 TS spec，方案第 3 节自建用例）。

func TestListPushAndOrder(t *testing.T) {
	root := NewContext()
	l := NewList[int](root, "test")
	if l.Len() != 0 {
		t.Fatalf("初始长度应为 0，得到 %d", l.Len())
	}
	l.Push(1)
	l.Push(2)
	l.Push(3)
	if l.Len() != 3 {
		t.Fatalf("长度应为 3，得到 %d", l.Len())
	}
	if got := l.Values(); len(got) != 3 || got[0] != 1 || got[1] != 2 || got[2] != 3 {
		t.Fatalf("应保持插入序 [1 2 3]，得到 %v", got)
	}
}

func TestListFilterAndMap(t *testing.T) {
	root := NewContext()
	l := NewList[int](root, "test")
	l.Push(1)
	l.Push(2)
	l.Push(3)
	l.Push(4)
	even := l.Filter(func(v int) bool { return v%2 == 0 })
	if len(even) != 2 || even[0] != 2 || even[1] != 4 {
		t.Fatalf("Filter 应返回 [2 4]，得到 %v", even)
	}
	mapped := l.Map(func(v int) any { return v * 10 })
	if len(mapped) != 4 || mapped[0] != 10 || mapped[3] != 40 {
		t.Fatalf("Map 应返回 [10 20 30 40]，得到 %v", mapped)
	}
}

func TestListDisposedWithFiber(t *testing.T) {
	// push 经 ctx.effect 登记：登记它的 fiber 销毁后元素自动移除。
	root := NewContext()
	var l *List[string]
	fiber, err := root.Plugin(&Plugin{
		Name: "list-holder",
		Apply: func(c *Context, _ any) (Disposable, error) {
			l = NewList[string](c, "holder")
			l.Push("a")
			l.Push("b")
			return nil, nil
		},
	}, nil)
	if err != nil {
		t.Fatalf("插件装载失败：%v", err)
	}
	if _, err := fiber.Await(context.Background()); err != nil {
		t.Fatalf("等待 fiber 失败：%v", err)
	}
	if l.Len() != 2 {
		t.Fatalf("装载后长度应为 2，得到 %d", l.Len())
	}
	if err := fiber.Dispose(context.Background()); err != nil {
		t.Fatalf("销毁 fiber 失败：%v", err)
	}
	if l.Len() != 0 {
		t.Fatalf("fiber 销毁后列表应清空，得到 %d 项", l.Len())
	}
}
