package tools

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"

	"elysian/server/internal/agent/kardia"
)

func TestInstallRejectsUnreadyAndCancelled(t *testing.T) {
	t.Run("依赖未就绪", func(t *testing.T) {
		root := kardia.NewContext()
		t.Cleanup(func() { _ = root.Fiber().Dispose(context.Background()) })
		plugin := &kardia.Plugin{Name: "missing", Inject: kardia.InjectMap{"absent": nil}, Apply: func(*kardia.Context, any) (kardia.Disposable, error) {
			t.Error("依赖未就绪不得执行")
			return nil, nil
		}}
		if _, err := Install(context.Background(), root, Plugin, plugin); err == nil {
			t.Fatal("未激活的插件不得报告装载成功")
		}
		if root.Registry().Size() != 0 {
			t.Fatal("装载失败必须回滚整批插件")
		}
	})
	t.Run("已取消", func(t *testing.T) {
		root := kardia.NewContext()
		t.Cleanup(func() { _ = root.Fiber().Dispose(context.Background()) })
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		plugin := &kardia.Plugin{Name: "cancelled", Apply: func(*kardia.Context, any) (kardia.Disposable, error) {
			t.Error("已取消的装载不得执行 Apply")
			return nil, nil
		}}
		if _, err := Install(ctx, root, plugin); !errors.Is(err, context.Canceled) {
			t.Fatalf("应返回取消错误：%v", err)
		}
	})
}

func TestSchemaAndIntegerExtractionAgree(t *testing.T) {
	for _, value := range []any{int8(42), int16(42), int32(42), int64(42), uint(42), uint8(42), uint16(42), uint32(42), uint64(42), float32(42), float64(42)} {
		if err := (Schema{Type: SchemaInteger}).Validate(value); err != nil {
			t.Fatal(err)
		}
		if got, ok := IntArg(Arguments{"n": value}, "n"); !ok || got != 42 {
			t.Errorf("通过校验的 %T 必须无损取值：%d %v", value, got, ok)
		}
	}
	for _, value := range []any{math.Exp2(63), uint64(math.MaxUint64), math.Inf(1), math.NaN(), 1.5} {
		if err := (Schema{Type: SchemaInteger}).Validate(value); err == nil {
			t.Errorf("不可表示为 int 的值必须被拒绝：%v", value)
		}
		if _, ok := IntArg(Arguments{"n": value}, "n"); ok {
			t.Errorf("不可表示为 int 的值不得溢出转换：%v", value)
		}
	}
}

func TestSchemaRejectsImpossibleRequiredAndEnforcesObjectEnum(t *testing.T) {
	for _, schema := range []Schema{
		{Type: SchemaObject, Required: []string{"missing"}},
		{Type: SchemaObject, Required: []string{"x", "x"}, Properties: map[string]Schema{"x": {Type: SchemaString}}},
	} {
		if err := schema.checkShape(""); err == nil {
			t.Fatal("不成立的 required 必须在注册前被拒绝")
		}
	}
	schema := Schema{Type: SchemaObject, Properties: map[string]Schema{"x": {Type: SchemaString}}, Enum: []any{map[string]any{"x": "a"}}}
	if err := schema.Validate(map[string]any{"x": "b"}); err == nil {
		t.Fatal("对象的枚举约束不得被跳过")
	}
	if err := (Schema{Type: SchemaInteger, Enum: []any{int64(9007199254740992)}}).Validate(int64(9007199254740993)); err == nil {
		t.Fatal("枚举比较不得把相邻大整数视为相同")
	}
	if got := (Schema{Type: SchemaObject}).JSONSchema(); got["additionalProperties"] != false {
		t.Fatal("导出模式必须说明拒绝额外参数")
	}
}

func TestRegistrySnapshotsOwnSchema(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	d := echoDescriptor("snapshot", "ok")
	d.Parameters = Schema{Type: SchemaObject, Required: []string{"x"}, Properties: map[string]Schema{"x": {Type: SchemaString, MinLength: intPtr(1), Enum: []any{"a"}}}}
	if _, err := registry.Register(d); err != nil {
		t.Fatal(err)
	}
	d.Parameters.Required[0] = "bad"
	*d.Parameters.Properties["x"].MinLength = 100
	d.Parameters.Properties["x"].Enum[0] = "bad"
	d.Parameters.Properties["extra"] = Schema{Type: SchemaString}
	lookup, _ := registry.Lookup("snapshot")
	lookup.Parameters.Required[0] = "bad"
	list := registry.List()
	list[0].Parameters.Properties["x"] = Schema{Type: SchemaBoolean}
	public := registry.Schemas()[0]
	public.Parameters["required"].([]string)[0] = "bad"
	if _, err := registry.Execute(root, "snapshot", Arguments{"x": "a"}); err != nil {
		t.Fatalf("修改输入或快照不得污染注册表：%v", err)
	}
	if _, err := registry.Execute(root, "snapshot", Arguments{"x": "a", "extra": "b"}); err == nil {
		t.Fatal("外部修改不得放宽已注册模式")
	}
}

func TestCallArgumentsDoNotAliasHandlerOrCaller(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	d := echoDescriptor("immutable", "ok")
	d.Parameters = Schema{Type: SchemaObject, Properties: map[string]Schema{"nested": {Type: SchemaObject, Properties: map[string]Schema{"value": {Type: SchemaString}}}}}
	d.Handler = func(_ *kardia.Context, args Arguments) (any, error) {
		nested := args["nested"].(map[string]any)
		if nested["value"] != "original" {
			t.Errorf("监听者不得改写处理器参数：%v", args)
		}
		nested["value"] = "handler"
		return nil, nil
	}
	if _, err := registry.Register(d); err != nil {
		t.Fatal(err)
	}
	listen(t, root, EventPreExecute, func(ev *kardia.EventCtx) (any, error) {
		ev.Args[0].(Call).Args["nested"].(map[string]any)["value"] = "listener"
		return ev.Next()
	})
	listen(t, root, EventResult, func(ev *kardia.EventCtx) (any, error) {
		if ev.Args[0].(Call).Args["nested"].(map[string]any)["value"] != "original" {
			t.Error("结果事件必须记录原始调用参数")
		}
		return nil, nil
	})
	args := Arguments{"nested": map[string]any{"value": "original"}}
	if _, err := registry.Execute(root, "immutable", args); err != nil {
		t.Fatal(err)
	}
	if args["nested"].(map[string]any)["value"] != "original" {
		t.Fatal("调用方参数不得被修改")
	}
}

func TestTypedNilDenyFailsClosed(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	if _, err := registry.Register(echoDescriptor("nil_deny", "ok")); err != nil {
		t.Fatal(err)
	}
	listen(t, root, EventPreExecute, func(*kardia.EventCtx) (any, error) { return (*Deny)(nil), nil })
	if _, err := registry.Execute(root, "nil_deny", nil); err == nil {
		t.Fatal("空拒绝裁决应返回错误")
	}
}

func TestRegistryDisposalInvalidatesRetainedReferences(t *testing.T) {
	root, registry, fiber := newRegistryCtx(t)
	if _, err := registry.Register(echoDescriptor("retained", "ok")); err != nil {
		t.Fatal(err)
	}
	d, _ := registry.Lookup("retained")
	if err := fiber.Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	if registry.Size() != 0 {
		t.Error("卸载注册表必须清理直接登记的工具")
	}
	if _, err := registry.Execute(root, "retained", nil); err == nil {
		t.Error("卸载后保留的注册表引用不可调用")
	}
	if _, err := d.Handler(root, nil); err == nil {
		t.Error("卸载后保留的处理器不可调用")
	}
	if _, err := registry.Register(echoDescriptor("late", "ok")); err == nil {
		t.Error("卸载后不可登记工具")
	}
}

func TestUseRejectsTypedNil(t *testing.T) {
	root := kardia.NewContext()
	t.Cleanup(func() { _ = root.Fiber().Dispose(context.Background()) })
	if _, err := kardia.NewService(root, "nil_service", (*Registry)(nil), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := Use[*Registry](root, "nil_service"); err == nil || !strings.Contains(err.Error(), "未提供") {
		t.Fatalf("带类型的 nil 不得被当作可调用服务：%v", err)
	}
}

func TestToolUsesProviderShadowAndRefusesUnloadedProvider(t *testing.T) {
	root := kardia.NewContext()
	t.Cleanup(func() { _ = root.Fiber().Dispose(context.Background()) })
	var owner *kardia.Context
	called := 0
	capability := &kardia.Plugin{Name: "shadow-capability", Inject: kardia.InjectMap{ServiceName: nil}, Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		owner = c
		d := echoDescriptor("shadow_tool", nil)
		d.Handler = func(access *kardia.Context, _ Arguments) (any, error) {
			called++
			if access.DefSite() != owner {
				t.Error("处理器的影子必须是能力提供者")
			}
			return "ok", nil
		}
		return nil, RegisterAll(c, d)
	}}
	fibers, err := Install(context.Background(), root, Plugin, capability)
	if err != nil {
		t.Fatal(err)
	}
	registry := registryOf(t, root)
	if _, err := registry.Execute(root, "shadow_tool", nil); err != nil {
		t.Fatal(err)
	}
	listen(t, root, EventPreExecute, func(ev *kardia.EventCtx) (any, error) {
		if err := fibers[1].Dispose(context.Background()); err != nil {
			return nil, err
		}
		return ev.Next()
	})
	if _, err := registry.Execute(root, "shadow_tool", nil); err == nil {
		t.Fatal("策略检查中卸载后不得执行旧处理器")
	}
	if called != 1 {
		t.Fatalf("已卸载处理器被执行：%d", called)
	}
}

func TestDisposedCallerCannotRunTool(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	var caller *kardia.Context
	fibers, err := Install(context.Background(), root, &kardia.Plugin{Name: "caller", Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		caller = c
		return nil, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	d := echoDescriptor("cancelled_call", nil)
	d.Handler = func(*kardia.Context, Arguments) (any, error) {
		t.Error("已取消的调用不得触达域对象")
		return nil, nil
	}
	if _, err := registry.Register(d); err != nil {
		t.Fatal(err)
	}
	if err := fibers[0].Dispose(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Execute(caller, d.Name, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("应保留调用方的取消原因：%v", err)
	}
}

func TestResultFailurePreservesBothErrors(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	executionErr, auditErr := errors.New("执行失败"), errors.New("审计失败")
	d := echoDescriptor("two_errors", nil)
	d.Handler = func(*kardia.Context, Arguments) (any, error) { return nil, executionErr }
	if _, err := registry.Register(d); err != nil {
		t.Fatal(err)
	}
	listen(t, root, EventResult, func(*kardia.EventCtx) (any, error) { return nil, auditErr })
	if _, err := registry.Execute(root, d.Name, nil); !errors.Is(err, executionErr) || !errors.Is(err, auditErr) {
		t.Fatalf("执行与审计错误都应保留：%v", err)
	}
}

func TestPublicSchemaJSONKeys(t *testing.T) {
	encoded, err := json.Marshal(echoDescriptor("public", nil).Public())
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if fields["name"] != "public" || fields["description"] == nil || fields["parameters"] == nil || len(fields) != 3 {
		t.Fatalf("工具清单必须使用稳定的 JSON 字段：%s", encoded)
	}
}

func TestRegistryConcurrentSnapshotsDoNotShareSchema(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	d := echoDescriptor("concurrent", nil)
	d.Parameters.Properties = map[string]Schema{"n": {Type: SchemaInteger}}
	if _, err := registry.Register(d); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				d, _ := registry.Lookup("concurrent")
				d.Parameters.Properties["n"] = Schema{Type: SchemaString}
				if _, err := registry.Execute(root, "concurrent", Arguments{"n": j}); err != nil {
					t.Error(err)
				}
			}
		}()
	}
	wg.Wait()
}
