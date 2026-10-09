// Package firewall 把端口放行能力封装成 kardia 插件。
//
// 只包 seam.PortOpener 这一个方法：firewall 域的 21 方法 Service 接口虽导出，
// 却没有导出构造器（Deps 的 service/host 槽位未导出），从包外拿不到实例
// （ADR-0023 后续项）。放行器由宿主注入——firewall.NewPortOpener 会打开 sqlite
// 台账并在启动期恢复宿主 UFW，本包绝不代为构造；宿主可以显式注入
// seam.NoopPortOpener() 表达「防火墙片不可用」。
package firewall

import (
	"errors"
	"fmt"
	"strings"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/contract"
	"elysian/server/internal/seam"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "firewall"

// DefaultNote 是放行规则的缺省备注。
const DefaultNote = "agent 请求放行"

// Deps 是宿主注入的域对象。
type Deps struct {
	// Opener 是端口放行接缝，由宿主构造后注入。
	Opener seam.PortOpener
}

// Config 是本能力自身的开关。
type Config struct {
	// DefaultNote 是调用方未给备注时使用的规则备注，空则取 DefaultNote。
	DefaultNote string
}

// Service 是防火墙能力服务。
type Service struct {
	kardia.Service

	deps Deps
	cfg  Config
}

func (d Deps) validate() error {
	if d.Opener == nil {
		return errors.New("防火墙能力缺少 seam.PortOpener 实现：放行器由宿主构造并注入，不可用时请显式注入 seam.NoopPortOpener()")
	}
	return nil
}

// New 构造防火墙能力服务，提供服务并登记描述符。
func New(c *kardia.Context, deps Deps, cfg Config) (*Service, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	if strings.TrimSpace(cfg.DefaultNote) == "" {
		cfg.DefaultNote = DefaultNote
	}
	service := &Service{deps: deps, cfg: cfg}
	base, err := kardia.NewService(c, ServiceName, service, nil)
	if err != nil {
		return nil, err
	}
	service.Service = base
	if err := tools.RegisterAll(c, service.descriptors()...); err != nil {
		return nil, err
	}
	return service, nil
}

// Plugin 把本能力封成 kardia 插件。
func Plugin(deps Deps, cfg Config) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, kardia.InjectMap{tools.ServiceName: nil},
		func(c *kardia.Context, _ any) (any, error) { return New(c, deps, cfg) })
}

// From 取已装载的防火墙能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// EnsurePortRule 幂等补一条 ufw 放行规则。端口越界即拒绝；放行结果本身永不
// 报错，一切状态以 contract.FirewallPortSync 带回（opened|skipped|failed）。
func (s *Service) EnsurePortRule(access *kardia.Context, port int, note string) (contract.FirewallPortSync, error) {
	if port < 1 || port > 65535 {
		return contract.FirewallPortSync{}, fmt.Errorf("端口 %d 越界：只接受 1 到 65535", port)
	}
	if strings.TrimSpace(note) == "" {
		note = s.cfg.DefaultNote
	}
	return s.deps.Opener.EnsurePortRule(tools.Lifetime(access), port, note), nil
}

func (s *Service) descriptors() []tools.Descriptor {
	return []tools.Descriptor{
		{
			Name:        "port_rule_ensure",
			Description: "幂等补一条 ufw 端口放行规则；返回 opened、skipped 或 failed 与中文说明",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"port"},
				Properties: map[string]tools.Schema{
					"port": {Type: tools.SchemaInteger, Description: "要放行的端口，1 到 65535"},
					"note": {Type: tools.SchemaString, Description: "规则备注，缺省为 " + s.cfg.DefaultNote},
				},
			},
			Handler: s.handleEnsurePortRule,
		},
	}
}

func (s *Service) handleEnsurePortRule(access *kardia.Context, args tools.Arguments) (any, error) {
	port, ok := tools.IntArg(args, "port")
	if !ok {
		return nil, errors.New("端口参数不是整数")
	}
	note, _ := tools.StringArg(args, "note")
	sync, err := s.EnsurePortRule(access, port, note)
	if err != nil {
		return nil, err
	}
	return sync, nil
}
