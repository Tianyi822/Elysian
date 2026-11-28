// Package docker exposes host-injected Docker views and a restricted Agent
// facade. Mutations require Registry dispatch authorization and exact grants;
// the domain facade enforces container templates and image task idempotence.
package docker

import (
	"context"
	"encoding/json"
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
	Agent *domaindocker.AgentFacade
	// Views 是镜像与容器视图，由宿主经 docker.Assemble 构造后注入。
	Views seam.DockerViews
}

// Config 是本能力自身的开关。
type Config struct {
	// ListLimit 是列举条数上限，<=0 时取 DefaultListLimit。
	ListLimit int
}

// ContainerSummary 是可进入工具事件与运行记录的容器摘要。凭据、启动命令和
// 挂载内容不属于这个投影；新增域字段也不会自动进入工具结果。
type ContainerSummary struct {
	ID            string                     `json:"id"`
	Name          string                     `json:"name"`
	Status        string                     `json:"status"`
	ImageID       string                     `json:"imageId"`
	ImageRef      string                     `json:"imageRef,omitempty"`
	Ports         []contract.PortBindingView `json:"ports"`
	CreatedAt     string                     `json:"createdAt"`
	StartedAt     string                     `json:"startedAt,omitempty"`
	RestartPolicy string                     `json:"restartPolicy"`
}

// ImageSummary 显式列出镜像工具允许公开的字段。
type ImageSummary struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Tag       string   `json:"tag"`
	Digest    string   `json:"digest"`
	SizeMB    int      `json:"sizeMb"`
	PulledAt  *string  `json:"pulledAt"`
	OtherTags []string `json:"otherTags,omitempty"`
}

// Service 是容器能力服务。
type Service struct {
	kardia.Service

	deps Deps
	cfg  Config
}

func (d Deps) validate() error {
	if tools.IsNil(d.Views) {
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
		return nil, errors.Join(err, service.Close(context.Background()))
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
	if s.deps.Agent != nil {
		if err := s.deps.Agent.Authorize(tools.Lifetime(access)); err != nil {
			return nil, err
		}
	}
	containers, err := s.deps.Views.ListContainers(tools.Lifetime(access))
	if err != nil {
		return nil, err
	}
	return limitList(containers, s.cfg.ListLimit), nil
}

// ListImages 返回镜像视图，按 ListLimit 截断。
func (s *Service) ListImages(access *kardia.Context) ([]contract.ContainerImage, error) {
	if s.deps.Agent != nil {
		if err := s.deps.Agent.Authorize(tools.Lifetime(access)); err != nil {
			return nil, err
		}
	}
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
	if s.deps.Agent != nil {
		if err := s.deps.Agent.Authorize(tools.Lifetime(access)); err != nil {
			return err
		}
	}
	return domaindocker.CheckRegistryHost(tools.Lifetime(access), raw)
}

func (s *Service) descriptors() []tools.Descriptor {
	empty := tools.Schema{Type: tools.SchemaObject}
	descriptors := []tools.Descriptor{
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
		{
			// 收敛 docker_policy_view 与 docker_self_container 的两条常量事实；
			// 两旧名保留注册与 legacy tool-batch 契约（allowed()／RUNTIME_TOOL_NAMES）。
			Name:        "docker_context_view",
			Description: "返回面板 Docker 运行上下文事实：挂载根、保留端口与面板自身所在容器 ID（未识别时 identified 为 false）",
			Parameters:  empty,
			Handler:     s.handleContextView,
		},
	}
	for i := range descriptors {
		descriptors[i].Metadata = tools.Metadata{Domain: "docker", Action: descriptors[i].Name, Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}
		switch descriptors[i].Name {
		case "docker_containers_list":
			descriptors[i].SearchNames = []string{"本地容器列表", "容器清单", "查看所有容器", "docker ps", "docker container ls", "containers list"}
		case "docker_images_list":
			descriptors[i].SearchNames = []string{"本地镜像列表", "镜像清单", "已安装镜像", "docker images", "docker image ls", "images list"}
		case "docker_context_view":
			descriptors[i].SearchNames = []string{"挂载根", "保留端口", "面板容器", "mount root", "reserved ports"}
		}
	}
	if s.deps.Agent == nil {
		return descriptors
	}
	text := tools.Schema{Type: tools.SchemaString}
	for _, action := range []string{"start", "stop", "restart", "remove"} {
		action := action
		description := "审批后对已授权的安全容器执行 " + action
		version := "2"
		if action == "remove" {
			description = "按本轮授权删除指定本机容器；通用容器须已停止，保留卷；受管数据库经登记、兄弟库和专属卷身份核验；面板自身与内部容器拒绝"
			version = "4"
		}
		descriptors = append(descriptors, tools.Descriptor{Name: "docker_container_" + action, Description: description, Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{"id": text}}, Metadata: tools.Metadata{Domain: "docker", Action: action, Effect: "write", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "id", Version: version}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			id, _ := tools.StringArg(args, "id")
			lifetime := tools.Lifetime(c)
			frozen := tools.FrozenMetadata(lifetime)
			if action == "remove" {
				remove := s.deps.Agent.LegacyRemove
				switch frozen.Version {
				case "2", "3":
					remove = s.deps.Agent.ManagedRemove
				case "4":
					remove = s.deps.Agent.Remove
				}
				if err := remove(lifetime, id); err != nil {
					return nil, agentBusinessError(err)
				}
				return map[string]bool{"removed": true}, nil
			}
			perform := s.deps.Agent.ManagedAction
			if frozen.Version == "1" {
				perform = s.deps.Agent.LegacyAction
			}
			container, err := perform(lifetime, id, action)
			if err != nil {
				return nil, agentBusinessError(err)
			}
			return containerSummary(container), nil
		}})
	}
	descriptors = append(descriptors, tools.Descriptor{Name: "docker_container_create_restricted", Description: "审批后用固定安全模板创建容器：非 root、无网络、只读根、无宿主挂载、无额外权限；镜像必须已存在且固定摘要", Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"name", "image", "requestId"}, Properties: map[string]tools.Schema{"name": text, "image": text, "requestId": text}}, Metadata: tools.Metadata{Domain: "docker", Action: "create", Effect: "write", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "name", Version: "1"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
		name, _ := tools.StringArg(args, "name")
		image, _ := tools.StringArg(args, "image")
		requestID, _ := tools.StringArg(args, "requestId")
		container, err := s.deps.Agent.CreateRestricted(tools.Lifetime(c), domaindocker.AgentCreateInput{Name: name, Image: image, RequestID: requestID})
		if err != nil {
			return nil, agentBusinessError(err)
		}
		return containerSummary(container), nil
	}})
	descriptors = append(descriptors, tools.Descriptor{
		Name:        "docker_container_create_service",
		Description: "审批后用 service-v1 模板创建并启动服务容器：本机已存在摘要镜像、可写根、专属卷与声明式凭据（只传变量名，值由后端生成且不出现在参数与回执）。提交前自动核对宿主容量，不足时不创建并把读数交回。resourceTier(small/medium/large) 与 networkScope(container-net/localhost/any-host) 先经 docker_host_capacity 核对可容纳的档位，再经 request_user_input 由用户选定后提交；any-host 必填 hostPort 并联动防火墙，localhost/any-host 必填容器端口 port。部署 MySQL/MariaDB/Redis 请改用 database_provision，它会优先复用现有实例。相同参数重试复用原 requestId",
		Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"name", "image", "requestId", "resourceTier", "networkScope"}, Properties: map[string]tools.Schema{
			"name":         {Type: tools.SchemaString, Description: "容器名称"},
			"image":        {Type: tools.SchemaString, Description: "本机已存在的镜像完整引用，名称:标签@sha256:64 位摘要"},
			"requestId":    {Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$", Description: "64 位小写十六进制稳定请求标识；同请求重试必须复用原值与完整参数"},
			"resourceTier": {Type: tools.SchemaString, Enum: tools.EnumOf("small", "medium", "large"), Description: "资源档位：small=512MiB+0.5CPU、medium=1GiB+1CPU、large=2GiB+2CPU"},
			"networkScope": {Type: tools.SchemaString, Enum: tools.EnumOf("container-net", "localhost", "any-host"), Description: "网络档位：仅容器网络/本机回环/任意主机"},
			"port":         {Type: tools.SchemaInteger, Description: "容器侧 TCP 端口；localhost 与 any-host 必填"},
			"hostPort":     {Type: tools.SchemaInteger, Description: "宿主端口；仅 any-host 必填且不得为面板保留端口"},
			"credentials":  {Type: tools.SchemaArray, Items: &tools.Schema{Type: tools.SchemaString, Pattern: "^[A-Z][A-Z0-9_]{0,63}$"}, Description: "凭据环境变量名列表（如 MYSQL_ROOT_PASSWORD），最多 8 项；值由后端生成，不传入明文"},
			"env":          {Type: tools.SchemaArray, Items: &tools.Schema{Type: tools.SchemaString}, Description: "非凭据环境变量 KEY=VALUE 列表，最多 16 项、每项不超过 512 字节，完整进入审批展示"},
			"volumes":      {Type: tools.SchemaArray, Items: &tools.Schema{Type: tools.SchemaString, Pattern: "^/[A-Za-z0-9._/-]{0,127}$"}, Description: "容器内持久卷挂载点（如 /var/lib/mysql），最多 2 个；卷由面板托管"},
		}},
		Metadata:    tools.Metadata{Domain: "docker", Action: "create_service", Effect: "write", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "name", Version: "4", Async: true, TaskDomain: domaindocker.ContainerOperationDomain, TaskRequestArgument: "requestId"},
		SearchNames: []string{"部署服务", "新建服务容器", "创建容器", "service container"},
		Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			input := domaindocker.AgentServiceCreateInput{}
			input.Name, _ = tools.StringArg(args, "name")
			input.Image, _ = tools.StringArg(args, "image")
			input.RequestID, _ = tools.StringArg(args, "requestId")
			input.ResourceTier, _ = tools.StringArg(args, "resourceTier")
			input.NetworkScope, _ = tools.StringArg(args, "networkScope")
			input.Port, _ = tools.IntArg(args, "port")
			input.HostPort, _ = tools.IntArg(args, "hostPort")
			input.Credentials = tools.StringArrayArg(args, "credentials")
			input.Env = tools.StringArrayArg(args, "env")
			input.Volumes = tools.StringArrayArg(args, "volumes")
			ctx := tools.Lifetime(c)
			if tools.FrozenMetadata(ctx).Version == "1" {
				value, err := s.deps.Agent.CreateService(ctx, input)
				return value, agentBusinessError(err)
			}
			task, err := s.deps.Agent.SubmitService(ctx, input)
			if err != nil {
				return nil, agentBusinessError(err)
			}
			return tools.Submission{Value: domaindocker.AgentOperationReceipt(task), Task: tools.TaskReference{Domain: domaindocker.ContainerOperationDomain, ID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest}}, nil
		},
	})
	descriptors = append(descriptors, tools.Descriptor{
		Name:        "docker_container_logs",
		Description: "只读读取指定本机容器的最近日志，含用户自装容器；面板自身与内部容器拒绝。日志可能含应用打印的凭据；缺省 100 行，最多 500 行及 64 KiB，需完整容器 ID",
		Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{
			"id":   text,
			"tail": {Type: tools.SchemaInteger, Description: "读取行数，1 至 500，缺省 100"},
		}},
		Metadata:    tools.Metadata{Domain: "docker", Action: "logs", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "2"},
		SearchNames: []string{"容器日志", "查看日志", "排查容器", "container logs"},
		Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			id, _ := tools.StringArg(args, "id")
			tail, _ := tools.IntArg(args, "tail")
			ctx := tools.Lifetime(c)
			read := s.deps.Agent.LegacyLogs
			if tools.FrozenMetadata(ctx).Version == "2" {
				read = s.deps.Agent.Logs
			}
			value, err := read(ctx, id, tail)
			return value, agentBusinessError(err)
		},
	})
	descriptors = append(descriptors, s.inspectionDescriptors()...)
	descriptors = append(descriptors, s.execDescriptor())
	descriptors = append(descriptors, s.imageDescriptors()...)
	descriptors = append(descriptors, s.registryDescriptors()...)
	descriptors = append(descriptors, s.powerDescriptor())
	descriptors = append(descriptors, s.capacityDescriptor())
	descriptors = append(descriptors, s.hostContainerDescriptors()...)
	return append(descriptors, s.recreateDescriptors()...)
}

// powerDescriptor 把 start/stop/restart 三个生命周期动作收敛为单一入口；
// action 参数进入审批与授权摘要，逐动作精确比对，remove 保持独立工具不并入。
func (s *Service) powerDescriptor() tools.Descriptor {
	text := tools.Schema{Type: tools.SchemaString}
	return tools.Descriptor{
		Name:        "docker_container_power",
		Description: "按本轮授权启停或重启指定本机容器，含用户自装容器；受管数据库与网站按所属域登记路由；面板自身与内部容器拒绝",
		Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "action"}, Properties: map[string]tools.Schema{
			"id": text,
			"action": {Type: tools.SchemaString, Enum: tools.EnumOf("start", "stop", "restart"),
				Description: "生命周期动作，三选一；每次动作单独审批"},
		}},
		Metadata:    tools.Metadata{Domain: "docker", Action: "power", Effect: "write", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "2"},
		SearchNames: []string{"启动容器", "停止容器", "重启容器", "容器启停", "start container", "stop container", "restart container"},
		Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			id, _ := tools.StringArg(args, "id")
			action, _ := tools.StringArg(args, "action")
			ctx := tools.Lifetime(c)
			if tools.FrozenMetadata(ctx).Version != "2" {
				container, err := s.deps.Agent.ManagedAction(ctx, id, action)
				if err != nil {
					return nil, agentBusinessError(err)
				}
				return containerSummary(container), nil
			}
			container, notes, err := s.deps.Agent.ActionWithNotes(ctx, id, action)
			if err != nil {
				return nil, agentBusinessError(err)
			}
			return struct {
				ContainerSummary
				domaindocker.AgentTargetNotes
			}{containerSummary(container), notes}, nil
		},
	}
}

func (s *Service) handleListContainers(access *kardia.Context, _ tools.Arguments) (any, error) {
	containers, err := s.ListContainers(access)
	if err != nil {
		return nil, err
	}
	summaries := make([]ContainerSummary, len(containers))
	for i, container := range containers {
		summaries[i] = containerSummary(container)
	}
	return summaries, nil
}

func (s *Service) handleListImages(access *kardia.Context, _ tools.Arguments) (any, error) {
	images, err := s.ListImages(access)
	if err != nil {
		return nil, err
	}
	summaries := make([]ImageSummary, len(images))
	for i, image := range images {
		summaries[i] = imageSummary(image)
	}
	return summaries, nil
}

func (s *Service) handlePolicy(access *kardia.Context, _ tools.Arguments) (any, error) {
	if s.deps.Agent != nil {
		if err := s.deps.Agent.Authorize(tools.Lifetime(access)); err != nil {
			return nil, err
		}
	}
	policy := s.Policy(access)
	return map[string]any{
		"mount_root":     policy.MountRoot,
		"reserved_ports": append([]int{}, policy.ReservedPorts...),
	}, nil
}

func (s *Service) handleSelfContainer(access *kardia.Context, _ tools.Arguments) (any, error) {
	if s.deps.Agent != nil {
		if err := s.deps.Agent.Authorize(tools.Lifetime(access)); err != nil {
			return nil, err
		}
	}
	id := s.SelfContainerID(access)
	return map[string]any{"id": id, "identified": id != ""}, nil
}

func (s *Service) handleContextView(access *kardia.Context, _ tools.Arguments) (any, error) {
	if s.deps.Agent != nil {
		if err := s.deps.Agent.Authorize(tools.Lifetime(access)); err != nil {
			return nil, err
		}
	}
	policy := s.Policy(access)
	id := s.SelfContainerID(access)
	runtime := "unknown"
	if id != "" {
		runtime = "container"
	}
	if s.deps.Agent != nil {
		runtime = s.deps.Agent.PanelRuntime()
	}
	notes := map[string]string{
		"host":      "面板直接运行在宿主机，没有自身容器 ID",
		"container": "已识别面板自身容器",
		"unknown":   "面板运行位置未能确认，扩展容器路径暂不可用",
	}
	return map[string]any{
		"mount_root":        policy.MountRoot,
		"reserved_ports":    append([]int{}, policy.ReservedPorts...),
		"self_container_id": id,
		"identified":        id != "",
		"panel_runtime":     runtime,
		"runtime_note":      notes[runtime],
	}, nil
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

func (s *Service) execDescriptor() tools.Descriptor {
	text := tools.Schema{Type: tools.SchemaString}
	return tools.Descriptor{Name: "docker_container_exec", Description: "按本轮授权在指定本机容器中执行 argv，含用户自装容器；面板自身、内部容器、受管数据库和网站拒绝。回执标注目标风险；相同请求复用 requestId，异步等待真实终态", SearchNames: []string{"执行容器命令", "容器内命令", "容器exec"}, Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "requestId"}, Properties: map[string]tools.Schema{"id": text, "requestId": {Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$", Description: "64 位小写十六进制稳定请求标识；精确重试复用原值与完整参数"}, "argv": {Type: tools.SchemaArray, Items: &text}, "workdir": text}}, Metadata: tools.Metadata{Domain: "docker", Backend: "domain", Action: "exec", Effect: "execute", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "4", Async: true, TaskDomain: domaindocker.ContainerOperationDomain, TaskRequestArgument: "requestId"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
		raw, err := json.Marshal(args)
		if err != nil {
			return nil, err
		}
		var input domaindocker.ContainerExecInput
		if err := json.Unmarshal(raw, &input); err != nil {
			return nil, err
		}
		ctx := tools.Lifetime(c)
		submit := s.deps.Agent.ManagedSubmitExec
		if tools.FrozenMetadata(ctx).Version == "4" {
			submit = s.deps.Agent.SubmitExec
		}
		task, err := submit(ctx, input)
		if err != nil {
			return nil, agentBusinessError(err)
		}
		return tools.Submission{Value: domaindocker.AgentOperationReceipt(task), Task: tools.TaskReference{Domain: domaindocker.ContainerOperationDomain, ID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest}}, nil
	}}
}
