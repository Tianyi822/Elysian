package tools

import (
	"context"
	"testing"
	"time"

	"elysian/server/internal/agent/kardia"
)

func runtimePlugin(t *testing.T, started chan<- struct{}, release <-chan struct{}) *kardia.Plugin {
	t.Helper()
	return &kardia.Plugin{Name: "runtime-test", Inject: kardia.InjectMap{"tools": nil}, Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		registry, err := RegistryFrom(c)
		if err != nil {
			return nil, err
		}
		return registry.Register(Descriptor{
			Name:        "runtime_test_tool",
			Description: "运行时测试工具",
			Parameters:  Schema{Type: SchemaObject},
			Handler: func(access *kardia.Context, _ Arguments) (any, error) {
				if started != nil {
					select {
					case started <- struct{}{}:
					default:
					}
				}
				if release != nil {
					// 故意模拟不协作的域调用：取消后仍需等待真实返回，
					// 运行时不能把 scope 清理误报为调用已结束。
					<-release
				}
				return map[string]any{"ok": true}, nil
			},
		})
	}}
}

func TestRuntimeLoadsPluginsAndUnloadsRegistrations(t *testing.T) {
	r, err := NewRuntime(context.Background(), runtimePlugin(t, nil, nil))
	if err != nil {
		t.Fatal(err)
	}
	if !r.Available() || len(r.Schemas()) != 1 {
		t.Fatalf("运行时未公开插件工具：available=%v schemas=%v", r.Available(), r.Schemas())
	}
	value, err := r.Execute(context.Background(), "runtime_test_tool", nil)
	if err != nil || value.(map[string]any)["ok"] != true {
		t.Fatalf("工具执行失败：%v %v", value, err)
	}
	if err := r.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.Available() || len(r.Schemas()) != 0 {
		t.Fatal("关闭后运行时不得继续公开工具")
	}
	if _, err := r.Execute(context.Background(), "runtime_test_tool", nil); err == nil {
		t.Fatal("关闭后不得执行工具")
	}
}

func TestRuntimeCancellationWaitsForHandler(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	r, err := NewRuntime(context.Background(), runtimePlugin(t, started, release))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = r.Close(context.Background()) }()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan runtimeResult, 1)
	go func() {
		value, err := r.Execute(ctx, "runtime_test_tool", nil)
		done <- runtimeResult{value: value, err: err}
	}()
	<-started
	cancel()
	select {
	case <-done:
		t.Fatal("处理器尚未返回时，运行时不应提前结束调用")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case result := <-done:
		if result.err != nil || result.value.(map[string]any)["ok"] != true {
			t.Fatalf("应保留处理器的真实完成结果：%v %v", result.value, result.err)
		}
	case <-time.After(time.Second):
		t.Fatal("处理器返回后运行时未结束调用")
	}
}

func TestRuntimeRejectsNilContextAndPlugin(t *testing.T) {
	if _, err := NewRuntime(nil); err == nil {
		t.Fatal("nil ctx 必须拒绝")
	}
	if _, err := NewRuntime(context.Background(), nil); err == nil {
		t.Fatal("nil 插件必须拒绝")
	}
}
