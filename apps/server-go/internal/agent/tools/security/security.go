package security

import (
	"context"
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domain "elysian/server/internal/security"
)

const ServiceName = "security"

type Deps struct{ Facade *domain.AgentFacade }
type Config struct{}
type Service struct {
	kardia.Service
	deps Deps
}

func New(c *kardia.Context, deps Deps, _ Config) (*Service, error) {
	if deps.Facade == nil || !deps.Facade.Available() {
		return nil, errors.New("安全能力缺少共享域服务")
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
		{"security_snapshot", "snapshot", "读取 SSH 状态、认证策略与密钥指纹，不读取密钥内容", deps.Facade.Snapshot},
		{"security_users", "users", "读取最多 200 条托管系统账号状态，不含备注", deps.Facade.Users},
		{"security_login_records", "login-records", "读取最多 200 条 SSH 登录记录", deps.Facade.LoginRecords},
	} {
		spec := spec
		descriptors = append(descriptors, tools.Descriptor{Name: spec.name, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject}, Metadata: tools.Metadata{Domain: "security", Action: spec.action, Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}, Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) { return spec.call(tools.Lifetime(c)) }})
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
