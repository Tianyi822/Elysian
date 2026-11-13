package platform

import (
	"context"
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/platform"
)

const ServiceName = "platform"

type Deps struct{ Facade *domain.AgentFacade }
type Config struct{}
type Service struct {
	kardia.Service
	deps Deps
}

func New(c *kardia.Context, deps Deps, _ Config) (*Service, error) {
	if deps.Facade == nil {
		return nil, errors.New("平台能力缺少共享域服务")
	}
	s := &Service{deps: deps}
	base, err := kardia.NewService(c, ServiceName, s, nil)
	if err != nil {
		return nil, err
	}
	s.Service = base
	var descriptors []tools.Descriptor
	for _, spec := range []struct {
		name, action, description string
		call                      func(context.Context) (any, error)
	}{
		{"platform_memory", "memory", "读取 Elysian 面板进程内存占用：RSS、Go 堆与 GC 采样；查询平台占用或平台性能时优先使用，并可结合 platform_metrics 补充系统概览。不提供面板进程 CPU 使用率", deps.Facade.Memory},
		{"platform_metrics", "metrics", "读取运行环境内存、CPU 使用率与负载、磁盘挂载占用的只读采样；查询平台占用时配合 platform_memory。读数为 Linux 内核视角，容器内不代表物理宿主；这里的 CPU 不是面板进程 CPU，也不能近似代替", deps.Facade.Metrics},
		{"platform_dependencies", "dependencies", "现场读取 Docker 与 Caddy 依赖状态，不执行安装", deps.Facade.Dependencies},
	} {
		spec := spec
		descriptors = append(descriptors, tools.Descriptor{Name: spec.name, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject}, Metadata: tools.Metadata{Domain: "platform", Action: spec.action, Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}, Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) { return spec.call(tools.Lifetime(c)) }})
	}
	// 收敛后的单一采样入口：进程内存为缺省轻量路径，宿主概览显式请求；
	// platform_memory 与 platform_metrics 保留注册仅供旧快照恢复。
	descriptors = append(descriptors, tools.Descriptor{
		Name:        "platform_sample",
		Description: "读取平台运行采样：scope=process 只读面板进程内存（RSS、Go 堆与 GC，无阻塞等待，缺省）；scope=host 读运行环境内存、CPU 使用率与负载、磁盘挂载占用（含约 200ms 采样等待）；scope=both 两者都返回，查询平台占用或平台性能时使用。读数为 Linux 内核视角，容器内不代表物理宿主；不提供面板进程 CPU 使用率，也不能用系统值冒充或近似代替",
		Parameters: tools.Schema{Type: tools.SchemaObject, Properties: map[string]tools.Schema{
			"scope": {Type: tools.SchemaString, Enum: tools.EnumOf("process", "host", "both"), Description: "采样范围，缺省 process"},
		}},
		Metadata:    tools.Metadata{Domain: "platform", Action: "sample", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"},
		SearchNames: []string{"平台占用", "平台性能", "进程内存", "面板内存", "系统概览", "CPU 使用率", "系统负载", "磁盘占用"},
		Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			scope, _ := tools.StringArg(args, "scope")
			wantProcess, wantHost, err := sampleScope(scope)
			if err != nil {
				return nil, err
			}
			process, host, err := deps.Facade.Sample(tools.Lifetime(c), wantProcess, wantHost)
			if err != nil {
				return nil, err
			}
			if wantProcess && wantHost {
				return map[string]any{"process": process, "host": host}, nil
			}
			if wantHost {
				return host, nil
			}
			return process, nil
		},
	})
	if err := tools.RegisterAll(c, descriptors...); err != nil {
		return nil, errors.Join(err, s.Close(context.Background()))
	}
	return s, nil
}
func Plugin(deps Deps, cfg Config) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, kardia.InjectMap{tools.ServiceName: nil}, func(c *kardia.Context, _ any) (any, error) { return New(c, deps, cfg) })
}
func From(c *kardia.Context) (*Service, error) { return tools.Use[*Service](c, ServiceName) }

// sampleScope 服务端强校验 scope 枚举：缺省取进程采样的轻量路径。
func sampleScope(scope string) (wantProcess, wantHost bool, err error) {
	switch scope {
	case "", "process":
		return true, false, nil
	case "host":
		return false, true, nil
	case "both":
		return true, true, nil
	default:
		return false, false, errors.New("scope 必须是 process、host 或 both")
	}
}
