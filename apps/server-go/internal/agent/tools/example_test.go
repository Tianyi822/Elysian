// example_test.go 是宿主的接入示例，同时充当本层的用法文档：装载注册表、
// 登记描述符、执行、被策略拒绝，以及能力插件如何注入注册表。
package tools

import (
	"context"
	"errors"
	"fmt"

	"elysian/server/internal/agent/kardia"
)

// disposeAll 逆序销毁 fiber，示例与宿主的退出路径同形。
func disposeAll(fibers []*kardia.Fiber) {
	for i := len(fibers) - 1; i >= 0; i-- {
		_ = fibers[i].Dispose(context.Background())
	}
}

func ExampleRegistry_Execute() {
	root := kardia.NewContext()
	fibers, err := Install(context.Background(), root, Plugin)
	if err != nil {
		panic(err)
	}
	defer disposeAll(fibers)

	registry, err := RegistryFrom(root)
	if err != nil {
		panic(err)
	}
	if _, err = registry.Register(Descriptor{
		Name:        "demo_uptime",
		Description: "返回演示用的运行时长",
		Parameters:  Schema{Type: SchemaObject},
		Handler: func(*kardia.Context, Arguments) (any, error) {
			return map[string]any{"seconds": 42}, nil
		},
	}); err != nil {
		panic(err)
	}

	value, err := registry.Execute(root, "demo_uptime", nil)
	fmt.Printf("结果：%v，错误：%v\n", value, err)
	// Output: 结果：map[seconds:42]，错误：<nil>
}

func ExampleRegistry_Execute_denied() {
	root := kardia.NewContext()
	fibers, err := Install(context.Background(), root, Plugin)
	if err != nil {
		panic(err)
	}
	defer disposeAll(fibers)

	registry, err := RegistryFrom(root)
	if err != nil {
		panic(err)
	}
	if _, err = registry.Register(Descriptor{
		Name:        "demo_restart",
		Description: "演示用的重启动作",
		Parameters:  Schema{Type: SchemaObject},
		Handler: func(*kardia.Context, Arguments) (any, error) {
			return "不应执行到这里", nil
		},
	}); err != nil {
		panic(err)
	}
	// 策略监听者只能拒：返回 *Deny 即中断，处理器不会被调用。
	if _, err = root.On(EventPreExecute, func(*kardia.EventCtx) (any, error) {
		return &Deny{Reason: "该动作需要人工审批"}, nil
	}); err != nil {
		panic(err)
	}

	_, err = registry.Execute(root, "demo_restart", nil)
	var denied *DeniedError
	if errors.As(err, &denied) {
		fmt.Printf("被拒：%s\n", denied.Reason)
	}
	// Output: 被拒：该动作需要人工审批
}

func ExampleInstall() {
	root := kardia.NewContext()
	// 能力插件以 Inject 声明依赖注册表：注册表未就绪时它的 fiber 不会激活。
	capability := &kardia.Plugin{
		Name:   "demo-capability",
		Inject: kardia.InjectMap{ServiceName: nil},
		Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
			registry, err := RegistryFrom(c)
			if err != nil {
				return nil, err
			}
			return registry.Register(Descriptor{
				Name:        "demo_ping",
				Description: "演示用的连通性检查",
				Parameters:  Schema{Type: SchemaObject},
				Handler:     func(*kardia.Context, Arguments) (any, error) { return "pong", nil },
			})
		},
	}

	fibers, err := Install(context.Background(), root, Plugin, capability)
	if err != nil {
		panic(err)
	}
	defer disposeAll(fibers)

	registry, err := RegistryFrom(root)
	if err != nil {
		panic(err)
	}
	for _, schema := range registry.Schemas() {
		fmt.Printf("%s：%s\n", schema.Name, schema.Description)
	}
	// Output: demo_ping：演示用的连通性检查
}
