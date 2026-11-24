package docker

import (
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domaindocker "elysian/server/internal/docker"
	"elysian/server/internal/shared"
)

func (s *Service) hostContainerDescriptors() []tools.Descriptor {
	text := tools.Schema{Type: tools.SchemaString}
	return []tools.Descriptor{
		{
			Name: "docker_container_stats", Description: "只读采样指定本机容器的 CPU、内存、PID、网络和磁盘 IO。需要完整容器 ID；面板自身和内部容器拒绝",
			SearchNames: []string{"容器资源", "容器统计", "容器占用", "docker stats"},
			Parameters:  tools.Schema{Type: tools.SchemaObject, Required: []string{"id"}, Properties: map[string]tools.Schema{"id": text}},
			Metadata:    tools.Metadata{Domain: "docker", Action: "stats", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "1"},
			Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
				id, _ := tools.StringArg(args, "id")
				value, err := s.deps.Agent.ContainerStats(tools.Lifetime(c), id)
				return value, agentBusinessError(err)
			},
		},
		{
			Name: "docker_networks_list", Description: "只读列出本机网络、网段和关联容器，结果有界",
			SearchNames: []string{"Docker 网络", "容器网络清单", "docker network ls"},
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Metadata:    tools.Metadata{Domain: "docker", Action: "networks_list", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"},
			Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) {
				value, err := s.deps.Agent.NetworkInventory(tools.Lifetime(c), s.cfg.ListLimit)
				return value, agentBusinessError(err)
			},
		},
		{
			Name: "docker_volumes_list", Description: "只读列出本机卷及引用容器，结果有界",
			SearchNames: []string{"Docker 卷", "容器卷清单", "docker volume ls"},
			Parameters:  tools.Schema{Type: tools.SchemaObject},
			Metadata:    tools.Metadata{Domain: "docker", Action: "volumes_list", Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"},
			Handler: func(c *kardia.Context, _ tools.Arguments) (any, error) {
				value, err := s.deps.Agent.VolumeInventory(tools.Lifetime(c), s.cfg.ListLimit)
				return value, agentBusinessError(err)
			},
		},
		s.updateDescriptor(),
	}
}

func (s *Service) updateDescriptor() tools.Descriptor {
	return tools.Descriptor{
		Name: "docker_container_update", Description: "按本轮授权原地修改指定容器的重启策略及 CPU、内存或 PID 限制。至少提供一项，省略项保留；PID 为 0 可解除限制。使用完整容器 ID 和稳定 requestId，等待回读确认",
		SearchNames: []string{"调整容器资源", "修改重启策略", "更新容器配置", "docker update"},
		Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "requestId"}, Properties: map[string]tools.Schema{
			"id":                {Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$"},
			"requestId":         {Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$", Description: "相同请求复用原标识和完整参数"},
			"restartPolicy":     {Type: tools.SchemaString, Enum: tools.EnumOf("no", "always", "on-failure", "unless-stopped")},
			"restartMaxRetries": {Type: tools.SchemaInteger, Description: "仅对 on-failure 生效，0 表示不限重试次数"},
			"memoryMiB":         {Type: tools.SchemaInteger, Description: "内存上限 MiB；0 仅确认当前已无限制"},
			"cpuMillis":         {Type: tools.SchemaInteger, Description: "千分之一 CPU；0 仅确认当前已无限制"},
			"pidsLimit":         {Type: tools.SchemaInteger, Description: "最大进程数；0 解除限制"},
		}},
		Metadata: tools.Metadata{Domain: "docker", Backend: "domain", Action: "update", Effect: "write", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "1", Async: true, TaskDomain: domaindocker.ContainerOperationDomain, TaskRequestArgument: "requestId"},
		Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			input, err := DecodeContainerUpdate(args)
			if err != nil {
				return nil, &tools.BusinessError{Code: "docker-operation-rejected", Message: err.Error(), NotDispatched: true}
			}
			task, err := s.deps.Agent.SubmitUpdate(tools.Lifetime(c), input)
			if err != nil {
				return nil, agentBusinessError(err)
			}
			return tools.Submission{Value: domaindocker.AgentOperationReceipt(task), Task: tools.TaskReference{
				Domain: domaindocker.ContainerOperationDomain, ID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest,
			}}, nil
		},
	}
}

// DecodeContainerUpdate uses the same canonical integer parsing for dispatch and recovery.
func DecodeContainerUpdate(args tools.Arguments) (domaindocker.ContainerUpdateInput, error) {
	id, _ := tools.StringArg(args, "id")
	requestID, _ := tools.StringArg(args, "requestId")
	input := domaindocker.ContainerUpdateInput{ID: id, RequestID: requestID}
	if _, present := args["restartPolicy"]; present {
		policy, ok := tools.StringArg(args, "restartPolicy")
		if !ok {
			return input, shared.InvalidRequest("重启策略无效")
		}
		input.RestartPolicy = &policy
	}
	for _, field := range []struct {
		key    string
		target **int
	}{
		{"restartMaxRetries", &input.RestartMaxRetries}, {"memoryMiB", &input.MemoryMiB},
		{"cpuMillis", &input.CPUMillis}, {"pidsLimit", &input.PIDsLimit},
	} {
		if _, present := args[field.key]; !present {
			continue
		}
		value, ok := tools.IntArg(args, field.key)
		if !ok {
			return input, shared.InvalidRequest("容器更新的资源和重试次数必须为整数")
		}
		*field.target = &value
	}
	return input, nil
}
