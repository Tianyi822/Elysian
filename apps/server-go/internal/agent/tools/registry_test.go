// 注册表行为的契约测试：装载即提供服务、注册可撤销、执行前失败闭合。
package tools

import (
	"context"
	"errors"
	"strings"
	"testing"

	"elysian/server/internal/agent/kardia"
)

// newRegistryCtx 装载注册表插件并等待就绪，测试结束自动销毁。
func newRegistryCtx(t *testing.T) (*kardia.Context, *Registry, *kardia.Fiber) {
	t.Helper()
	root := kardia.NewContext()
	fiber, err := root.Plugin(Plugin, nil)
	if err != nil {
		t.Fatalf("装载注册表插件失败：%v", err)
	}
	if _, err = fiber.Await(context.Background()); err != nil {
		t.Fatalf("等待注册表就绪失败：%v", err)
	}
	registry, err := RegistryFrom(root)
	if err != nil {
		t.Fatalf("取注册表失败：%v", err)
	}
	t.Cleanup(func() {
		if err := fiber.Dispose(context.Background()); err != nil {
			t.Errorf("销毁注册表失败：%v", err)
		}
	})
	return root, registry, fiber
}

// echoDescriptor 是一条恒返回固定值的最小描述符。
func echoDescriptor(name string, value any) Descriptor {
	return Descriptor{
		Name:        name,
		Description: name + " 的说明",
		Parameters:  Schema{Type: SchemaObject},
		Handler: func(_ *kardia.Context, args Arguments) (any, error) {
			return map[string]any{"echo": value, "args": args}, nil
		},
	}
}

func TestPluginProvidesRegistryService(t *testing.T) {
	root, registry, fiber := newRegistryCtx(t)
	if registry.Name != ServiceName {
		t.Fatalf("服务名应为 %q，实际 %q", ServiceName, registry.Name)
	}
	if fiber.State() != kardia.FiberActive {
		t.Fatalf("注册表 fiber 应处于激活态，实际 %v", fiber.State())
	}

	if err := fiber.Dispose(context.Background()); err != nil {
		t.Fatalf("销毁失败：%v", err)
	}
	if _, err := RegistryFrom(root); err == nil {
		t.Fatal("销毁后应取不到注册表")
	}
}

func TestRegistryListIsSortedAndPublicSchemaHidesHandler(t *testing.T) {
	_, registry, _ := newRegistryCtx(t)
	for _, name := range []string{"zeta_tool", "alpha_tool"} {
		if _, err := registry.Register(echoDescriptor(name, name)); err != nil {
			t.Fatalf("注册 %s 失败：%v", name, err)
		}
	}

	list := registry.List()
	if len(list) != 2 || list[0].Name != "alpha_tool" || list[1].Name != "zeta_tool" {
		t.Fatalf("列举应按名字稳定排序：%v", list)
	}
	schemas := registry.Schemas()
	if len(schemas) != 2 || schemas[0].Name != "alpha_tool" {
		t.Fatalf("模式列举应同序：%v", schemas)
	}
	if schemas[0].Parameters["type"] != SchemaObject {
		t.Fatalf("模式导出应含类型：%v", schemas[0].Parameters)
	}
	if _, found := schemas[0].Parameters["handler"]; found {
		t.Fatal("模式导出不得含 handler")
	}
	if got, ok := registry.Lookup("alpha_tool"); !ok || got.Name != "alpha_tool" {
		t.Fatalf("按名查询失败：%v %v", got, ok)
	}
	if _, ok := registry.Lookup("missing_tool"); ok {
		t.Fatal("未注册的名字不应命中")
	}
}

func TestRegistryRejectsDuplicateAndInvalidDescriptor(t *testing.T) {
	_, registry, _ := newRegistryCtx(t)
	if _, err := registry.Register(echoDescriptor("dup_tool", 1)); err != nil {
		t.Fatalf("首次注册应成功：%v", err)
	}
	_, err := registry.Register(echoDescriptor("dup_tool", 2))
	if err == nil || !strings.Contains(err.Error(), "已注册") {
		t.Fatalf("重名应拒绝，实际：%v", err)
	}

	cases := []struct {
		name       string
		descriptor Descriptor
		needle     string
	}{
		{"名字为空", Descriptor{Description: "d", Parameters: Schema{Type: SchemaObject}, Handler: func(*kardia.Context, Arguments) (any, error) { return nil, nil }}, "名字不得为空"},
		{"名字含非法字符", Descriptor{Name: "Docker-List", Description: "d", Parameters: Schema{Type: SchemaObject}, Handler: func(*kardia.Context, Arguments) (any, error) { return nil, nil }}, "只能由小写字母、数字与下划线组成"},
		{"说明为空", Descriptor{Name: "ok_tool", Parameters: Schema{Type: SchemaObject}, Handler: func(*kardia.Context, Arguments) (any, error) { return nil, nil }}, "说明不得为空"},
		{"处理器为空", Descriptor{Name: "ok_tool", Description: "d", Parameters: Schema{Type: SchemaObject}}, "处理器不得为空"},
		{"参数模式非法", Descriptor{Name: "ok_tool", Description: "d", Parameters: Schema{Type: "map"}, Handler: func(*kardia.Context, Arguments) (any, error) { return nil, nil }}, "不支持的参数类型"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := registry.Register(tc.descriptor)
			if err == nil {
				t.Fatal("非法描述符应拒绝")
			}
			if !strings.Contains(err.Error(), tc.needle) {
				t.Fatalf("期望错误含 %q，实际：%v", tc.needle, err)
			}
			if len(registry.List()) != 1 {
				t.Fatalf("被拒的描述符不应入表：%v", registry.List())
			}
		})
	}
}

func TestRegistryDisposableRemovesOnce(t *testing.T) {
	_, registry, _ := newRegistryCtx(t)
	dispose, err := registry.Register(echoDescriptor("temp_tool", 1))
	if err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	if len(registry.List()) != 1 {
		t.Fatalf("注册后应有一条：%v", registry.List())
	}
	if err := dispose(context.Background()); err != nil {
		t.Fatalf("撤销失败：%v", err)
	}
	if len(registry.List()) != 0 {
		t.Fatalf("撤销后应为空：%v", registry.List())
	}
	if err := dispose(context.Background()); err != nil {
		t.Fatalf("重复撤销应幂等，实际：%v", err)
	}
}

func TestRegistryExecuteFailsClosedBeforeHandler(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	called := false
	if _, err := registry.Register(Descriptor{
		Name:        "strict_tool",
		Description: "严格校验参数",
		Parameters: Schema{
			Type:     SchemaObject,
			Required: []string{"slug"},
			Properties: map[string]Schema{
				"slug": {Type: SchemaString},
			},
		},
		Handler: func(*kardia.Context, Arguments) (any, error) {
			called = true
			return "ok", nil
		},
	}); err != nil {
		t.Fatalf("注册失败：%v", err)
	}

	if _, err := registry.Execute(root, "missing_tool", nil); err == nil || !strings.Contains(err.Error(), "未注册") {
		t.Fatalf("未注册的工具应失败，实际：%v", err)
	}
	if _, err := registry.Execute(root, "strict_tool", Arguments{}); err == nil || !strings.Contains(err.Error(), "缺少必填参数") {
		t.Fatalf("参数校验失败应阻断，实际：%v", err)
	}
	if called {
		t.Fatal("参数校验失败时不得调用处理器")
	}

	value, err := registry.Execute(root, "strict_tool", Arguments{"slug": "web-a"})
	if err != nil {
		t.Fatalf("合法调用失败：%v", err)
	}
	if value != "ok" {
		t.Fatalf("返回值不符：%v", value)
	}
}

func TestRegistryExecuteKeepsHandlerError(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	sentinel := errors.New("上游拒绝了这次调用")
	if _, err := registry.Register(Descriptor{
		Name:        "failing_tool",
		Description: "恒失败",
		Parameters:  Schema{Type: SchemaObject},
		Handler:     func(*kardia.Context, Arguments) (any, error) { return nil, sentinel },
	}); err != nil {
		t.Fatalf("注册失败：%v", err)
	}

	_, err := registry.Execute(root, "failing_tool", nil)
	if !errors.Is(err, sentinel) {
		t.Fatalf("处理器错误应原样穿透，实际：%v", err)
	}
}

func TestRegistryExecuteKeepsNilArgumentsAsEmptyObject(t *testing.T) {
	root, registry, _ := newRegistryCtx(t)
	var seen Arguments
	if _, err := registry.Register(Descriptor{
		Name:        "nil_args_tool",
		Description: "记录收到的参数",
		Parameters:  Schema{Type: SchemaObject},
		Handler: func(_ *kardia.Context, args Arguments) (any, error) {
			seen = args
			return nil, nil
		},
	}); err != nil {
		t.Fatalf("注册失败：%v", err)
	}
	if _, err := registry.Execute(root, "nil_args_tool", nil); err != nil {
		t.Fatalf("执行失败：%v", err)
	}
	if seen == nil {
		t.Fatal("处理器应收到非 nil 的参数表")
	}
	if len(seen) != 0 {
		t.Fatalf("参数表应为空：%v", seen)
	}
}
