// Package docker 把容器与镜像的只读视图封装成 kardia 插件。
//
// 只包 seam.DockerViews 与 docker.CheckRegistryHost 这一个纯函数：容器视图由
// 宿主经 docker.Assemble 构造后注入——Assemble 会起事件流 goroutine 与采样定时
// 器且没有导出 Close，本包不代为构造（所有权契约见上级包 doc.go）。
//
// 启停、删除、重启这类写操作本轮不暴露：它们是不可逆动作，必须等审批层落地后
// 再开（AGENTS.md 把「哪些动作必须人为干预」推迟给 harness 层）。
package docker

import (
	"errors"
	"fmt"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/contract"
	domaindocker "elysian/server/internal/docker"
	"elysian/server/internal/seam"
)

// ServiceName 是本能力在 kardia 上的服务名。
const ServiceName = "docker"

// DefaultListLimit 是列举类工具的缺省条数上限，避免把整台宿主的容器表塞进一次
// 工具结果。
const DefaultListLimit = 200

// Deps 是宿主注入的域对象。
type Deps struct {
	// Views 是镜像与容器视图，由宿主经 docker.Assemble 构造后注入。
	Views seam.DockerViews
}

// Config 是本能力自身的开关。
type Config struct {
	// ListLimit 是列举条数上限，<=0 时取 DefaultListLimit。
	ListLimit int
}

// Service 是容器能力服务。
type Service struct {
	kardia.Service

	deps Deps
	cfg  Config
}

func (d Deps) validate() error {
	if d.Views == nil {
		return errors.New("容器能力缺少 seam.DockerViews 实现：视图由宿主经 docker.Assemble 构造后注入")
	}
	return nil
}

// New 构造容器能力服务，提供服务并登记描述符。
func New(c *kardia.Context, deps Deps, cfg Config) (*Service, error) {
	if err := deps.validate(); err != nil {
		return nil, err
	}
	if cfg.ListLimit < 0 {
		return nil, fmt.Errorf("列举上限不得为负：%d", cfg.ListLimit)
	}
	if cfg.ListLimit == 0 {
		cfg.ListLimit = DefaultListLimit
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

// From 取已装载的容器能力服务。
func From(c *kardia.Context) (*Service, error) {
	return tools.Use[*Service](c, ServiceName)
}

// ListContainers 返回容器视图，按 ListLimit 截断。
func (s *Service) ListContainers(access *kardia.Context) ([]contract.Container, error) {
	containers, err := s.deps.Views.ListContainers(tools.Lifetime(access))
	if err != nil {
		return nil, err
	}
	return limitList(containers, s.cfg.ListLimit), nil
}

// ListImages 返回镜像视图，按 ListLimit 截断。
func (s *Service) ListImages(access *kardia.Context) ([]contract.ContainerImage, error) {
	images, err := s.deps.Views.ListImages(tools.Lifetime(access))
	if err != nil {
		return nil, err
	}
	return limitList(images, s.cfg.ListLimit), nil
}

// Policy 返回挂载与端口策略事实。
func (s *Service) Policy(access *kardia.Context) seam.DockerPolicy {
	return s.deps.Views.Policy()
}

// SelfContainerID 返回面板自身容器 ID，空串表示未识别。
func (s *Service) SelfContainerID(access *kardia.Context) string {
	return s.deps.Views.SelfContainerID()
}

// CheckRegistryHost 校验镜像源主机名是否合法且解析为公网地址。它会做一次 DNS
// 解析（上游自带 3 秒超时），因此不是纯本地调用。
func (s *Service) CheckRegistryHost(access *kardia.Context, raw string) error {
	return domaindocker.CheckRegistryHost(tools.Lifetime(access), raw)
}

func (s *Service) descriptors() []tools.Descriptor {
	empty := tools.Schema{Type: tools.SchemaObject}
	return []tools.Descriptor{
		{
			Name:        "docker_containers_list",
			Description: fmt.Sprintf("列出容器视图，最多 %d 条", s.cfg.ListLimit),
			Parameters:  empty,
			Handler:     s.handleListContainers,
		},
		{
			Name:        "docker_images_list",
			Description: fmt.Sprintf("列出镜像视图，最多 %d 条", s.cfg.ListLimit),
			Parameters:  empty,
			Handler:     s.handleListImages,
		},
		{
			Name:        "docker_policy_view",
			Description: "返回挂载根与保留端口这两条策略事实",
			Parameters:  empty,
			Handler:     s.handlePolicy,
		},
		{
			Name:        "docker_self_container",
			Description: "返回面板自身所在容器的 ID，未识别时 identified 为 false",
			Parameters:  empty,
			Handler:     s.handleSelfContainer,
		},
		{
			Name:        "registry_host_check",
			Description: "校验镜像源主机名是否合法并解析为公网地址；会发起一次 DNS 解析",
			Parameters: tools.Schema{
				Type:     tools.SchemaObject,
				Required: []string{"host"},
				Properties: map[string]tools.Schema{
					"host": {Type: tools.SchemaString, Description: "镜像源主机名，可含端口"},
				},
			},
			Handler: s.handleRegistryHostCheck,
		},
	}
}

func (s *Service) handleListContainers(access *kardia.Context, _ tools.Arguments) (any, error) {
	containers, err := s.ListContainers(access)
	if err != nil {
		return nil, err
	}
	return containers, nil
}

func (s *Service) handleListImages(access *kardia.Context, _ tools.Arguments) (any, error) {
	images, err := s.ListImages(access)
	if err != nil {
		return nil, err
	}
	return images, nil
}

func (s *Service) handlePolicy(access *kardia.Context, _ tools.Arguments) (any, error) {
	policy := s.Policy(access)
	return map[string]any{
		"mount_root":     policy.MountRoot,
		"reserved_ports": policy.ReservedPorts,
	}, nil
}

func (s *Service) handleSelfContainer(access *kardia.Context, _ tools.Arguments) (any, error) {
	id := s.SelfContainerID(access)
	return map[string]any{"id": id, "identified": id != ""}, nil
}

func (s *Service) handleRegistryHostCheck(access *kardia.Context, args tools.Arguments) (any, error) {
	host, ok := tools.StringArg(args, "host")
	if !ok {
		return nil, errors.New("镜像源参数不是字符串")
	}
	if err := s.CheckRegistryHost(access, host); err != nil {
		return nil, err
	}
	return map[string]any{"host": host, "allowed": true}, nil
}

// limitList 按上限截断，避免工具结果无界增长。
func limitList[T any](values []T, limit int) []T {
	if limit <= 0 || len(values) <= limit {
		return values
	}
	return values[:limit]
}
