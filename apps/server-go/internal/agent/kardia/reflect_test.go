package kardia

import (
	"context"
	"strings"
	"testing"
)

// 对应 core/tests/reflect.spec.ts（4 个用例）。错误文案断言按方案第 0 节的
// 中文版本；TS 的 to.throw 断言改为 error 返回值断言。

// derivedCase 是 TestReflectContextIs 的用例条目。
type derivedCase struct {
	name string
	ctx  *Context
}

// TestReflectContextIs 对应 'Context.is()'：TS 以子类实例验证 Context.is；
// Go 无子类化，等价断言是「派生层仍是共享同一 root 的 *Context」。
func TestReflectContextIs(t *testing.T) {
	root := NewContext()
	derived := []derivedCase{
		{"extend", root.Extend(ExtendMeta{})},
		{"isolate", root.Isolate("foo", nil)},
		{"intercept", root.Intercept("foo", nil)},
		{"shadow", root.Shadow(root)},
	}
	for _, d := range derived {
		if d.ctx == nil {
			t.Fatalf("%s 派生层不应为 nil", d.name)
		}
		if d.ctx.Root() != root {
			t.Errorf("%s 派生层应共享同一 root", d.name)
		}
		if d.ctx.Fiber() == nil {
			t.Errorf("%s 派生层应能沿链解析 fiber", d.name)
		}
		if d.ctx.Events() != root.Events() || d.ctx.Reflect() != root.Reflect() {
			t.Errorf("%s 派生层应共享 root 单例服务", d.name)
		}
	}
}

// TestReflectAccessCheck 对应 'access check'。
func TestReflectAccessCheck(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	// 匿名插件（Name 为空，fiber 名沿父解析为 root）。
	first := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			// TS: ctx['prototype'] 与 ctx.constructor 都不得抛错。
			if _, err := c.Get("prototype"); err != nil {
				t.Errorf(`读取 "prototype" 不应报错：%v`, err)
			}
			if _, err := c.Get("constructor"); err != nil {
				t.Errorf(`读取 "constructor" 不应报错：%v`, err)
			}
			if _, err := c.Get("bar"); err == nil || !strings.Contains(err.Error(), `无法在未注入的情况下读取属性 "bar"`) {
				t.Errorf(`读取未注入属性应报「无法在未注入的情况下读取属性 "bar"」，得到：%v`, err)
			}
			if err := c.Set("bar", 0); err == nil || !strings.Contains(err.Error(), `无法在未提供的情况下设置属性 "bar"`) {
				t.Errorf(`设置未提供属性应报「无法在未提供的情况下设置属性 "bar"」，得到：%v`, err)
			}
			return nil, nil
		},
	}
	fiber, err := root.Plugin(first, nil)
	if err != nil {
		t.Fatalf("装载第一个插件失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待第一个插件失败：%v", err)
	}

	second := &Plugin{
		Apply: func(c *Context, _ any) (Disposable, error) {
			if err := c.Set("foo", 0); err == nil || !strings.Contains(err.Error(), `无法在未提供的情况下设置属性 "foo"`) {
				t.Errorf(`provide 前设置应报「无法在未提供的情况下设置属性 "foo"」，得到：%v`, err)
			}
			if _, err := c.Provide("foo", nil, nil); err != nil {
				t.Errorf(`首次 provide 不应报错：%v`, err)
			}
			if _, err := c.Provide("foo", nil, nil); err == nil || !strings.Contains(err.Error(), `服务 "foo" 已注册于 <root>`) {
				t.Errorf(`重复 provide 应报「服务 "foo" 已注册于 <root>」，得到：%v`, err)
			}
			if err := c.Set("foo", 0); err != nil {
				t.Errorf(`provide 后设置不应报错：%v`, err)
			}
			return nil, nil
		},
	}
	fiber2, err := root.Plugin(second, nil)
	if err != nil {
		t.Fatalf("装载第二个插件失败：%v", err)
	}
	if _, err := fiber2.Await(ctxBg); err != nil {
		t.Fatalf("等待第二个插件失败：%v", err)
	}
}

// TestReflectServiceInjection 对应 'service injection'（以 logger buffer
// 无 warn 等价 TS 的 warn 计数为 0）。
func TestReflectServiceInjection(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()

	root.Mixin("foo", []string{"bar"})
	if _, err := root.Provide("foo", nil, nil); err != nil {
		t.Fatalf("provide foo 失败：%v", err)
	}
	if err := root.Set("foo", map[string]any{"bar": 1}); err != nil {
		t.Fatalf("set foo 失败：%v", err)
	}

	// foo 是服务。
	v, err := root.Reflect().Get(root, "foo")
	if err != nil || v == nil {
		t.Fatalf(`reflect.get("foo") 应得到服务值：%v, %v`, v, err)
	}
	if m, ok := v.(map[string]any); !ok || m["bar"] != 1 {
		t.Fatalf(`reflect.get("foo") 应得到 {bar:1}，得到 %v`, v)
	}
	// bar 是 mixin：reflect.get 直查实现表应得 nil。
	if v, _ := root.Reflect().Get(root, "bar"); v != nil {
		t.Errorf(`reflect.get("bar") 应为 nil（mixin 不是实现），得到 %v`, v)
	}
	// root 是普通属性：无 isolate 符号，得 nil。
	if v, _ := root.Reflect().Get(root, "root"); v != nil {
		t.Errorf(`reflect.get("root") 应为 nil，得到 %v`, v)
	}

	inner := &Plugin{
		Apply: func(cc *Context, _ any) (Disposable, error) {
			baz, err := cc.Get("baz")
			if err != nil || baz != 2 {
				t.Errorf(`ctx.baz 应为 2（extend 的具名属性），得到 %v, %v`, baz, err)
			}
			return nil, nil
		},
	}
	fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		nested, err := c.Extend(ExtendMeta{Props: map[any]any{"baz": 2}}).Plugin(inner, nil)
		if err != nil {
			t.Errorf("嵌套插件装载失败：%v", err)
			return nil, nil
		}
		if _, err := nested.Await(ctxBg); err != nil {
			t.Errorf("等待嵌套插件失败：%v", err)
		}
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	if _, err := fiber.Await(ctxBg); err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}

	for _, m := range root.LoggerService().Messages() {
		if m.Type == "warn" {
			t.Errorf("解析过程不应产生告警：%v", m.Args)
		}
	}
}

// TestReflectServiceInjectLeak 对应 'service inject leak'。
func TestReflectServiceInjectLeak(t *testing.T) {
	ctxBg := context.Background()
	root := NewContext()
	if _, err := root.Provide("foo", nil, nil); err != nil {
		t.Fatalf("provide foo 失败：%v", err)
	}
	if err := root.Set("foo", map[string]any{"bar": 1}); err != nil {
		t.Fatalf("set foo 失败：%v", err)
	}
	fiber, err := root.Inject([]string{"foo"}, func(c *Context, _ any) (Disposable, error) {
		return nil, nil
	})
	if err != nil {
		t.Fatalf("inject 失败：%v", err)
	}
	f, err := fiber.Await(ctxBg)
	if err != nil {
		t.Fatalf("等待 inject fiber 失败：%v", err)
	}
	if _, err := f.Ctx().Get("foo"); err != nil {
		t.Fatalf("注入 fiber 的 ctx 应能读取 foo：%v", err)
	}
	if err := f.Dispose(ctxBg); err != nil {
		t.Fatalf("销毁 inject fiber 失败：%v", err)
	}
	if _, err := f.Ctx().Get("foo"); err == nil || !strings.Contains(err.Error(), `无法在非激活上下文中获取必需服务 "foo"`) {
		t.Errorf(`销毁后读取应报「无法在非激活上下文中获取必需服务 "foo"」，得到：%v`, err)
	}
}
