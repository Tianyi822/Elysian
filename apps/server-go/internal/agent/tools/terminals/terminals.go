// Package terminals 把终端会话机工具箱封装成 kardia 服务。
//
// 本能力不登记工具：PTY 是交互式会话（帧流、合帧节流、空闲超时与撤销接线都长在
// WebSocket 连接上），不是请求/响应形状的工具调用。它的价值是把 seam.TerminalKit
// 以命名服务的形式提供给其它插件注入（例如未来的容器 exec 终端能力）。
//
// Kit 由宿主注入。terminals.NewKit() 本身无副作用，但为保持「域对象一律宿主
// 所有」的一致口径，本包不代为构造。
package terminals

import (
	"errors"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/seam"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "terminals"

// Deps 是宿主注入的域对象。
type Deps struct {
	// Kit 是终端会话机工具箱，由宿主经 terminals.NewKit() 构造后注入。
	Kit seam.TerminalKit
}

// Service 是终端能力服务。
type Service struct {
	kardia.Service

	kit seam.TerminalKit
}

func (d Deps) validate() error {
	if tools.IsNil(d.Kit) {
		return errors.New("终端能力缺少 seam.TerminalKit 实现：请注入 terminals.NewKit() 的产物")
	}
	return nil
}

// New 构造终端能力服务并把它提供到 c 上。本能力没有描述符，因此不依赖注册表。
func New(c *kardia.Context, deps Deps) (*Service, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	service := &Service{kit: deps.Kit}
	base, err := kardia.NewService(c, ServiceName, service, nil)
	if err != nil {
		return nil, err
	}
	service.Service = base
	return service, nil
}

// Plugin 把本能力封成 kardia 插件。注入表为空：没有描述符要登记。
func Plugin(deps Deps) *kardia.Plugin {
	return kardia.ServicePlugin(ServiceName, nil,
		func(c *kardia.Context, _ any) (any, error) { return New(c, deps) })
}

// From 取已装载的终端能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// Kit 返回宿主注入的会话机工具箱。
func (s *Service) Kit() seam.TerminalKit { return s.kit }
