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
		{"platform_memory", "memory", "读取面板进程内存采样", deps.Facade.Memory},
		{"platform_metrics", "metrics", "读取本机内存、CPU 使用率与负载、磁盘挂载占用的只读采样；读数为 Linux 内核视角，容器内不代表物理宿主", deps.Facade.Metrics},
		{"platform_dependencies", "dependencies", "现场读取 Docker 与 Caddy 依赖状态，不执行安装", deps.Facade.Dependencies},
	} {
		spec := spec
		descriptors = append(descriptors, tools.Descriptor{Name: spec.name, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject}, Metadata: tools.Metadata{Domain: "platform", Action: spec.action, Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}, Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) { return spec.call(tools.Lifetime(c)) }})
	}
	if err := tools.RegisterAll(c, descriptors...); err != nil {
		return nil, errors.Join(err, s.Close(context.Background()))
	}
	return s, nil
}
func Plugin(deps Deps, cfg Config) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, kardia.InjectMap{tools.ServiceName: nil}, func(c *kardia.Context, _ any) (any, error) { return New(c, deps, cfg) })
}
func From(c *kardia.Context) (*Service, error) { return tools.Use[*Service](c, ServiceName) }
