package docker

import (
	"encoding/json"

	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domaindocker "elysian/server/internal/docker"
)

func (s *Service) recreateDescriptors() []tools.Descriptor {
	id := tools.Schema{Type: tools.SchemaString, Pattern: "^[a-f0-9]{64}$"}
	text := tools.Schema{Type: tools.SchemaString}
	flag := tools.Schema{Type: tools.SchemaBoolean}
	number := tools.Schema{Type: tools.SchemaInteger}
	port := tools.Schema{Type: tools.SchemaObject, Required: []string{"containerPort", "hostPort", "protocol"}, Properties: map[string]tools.Schema{
		"containerPort": number, "hostPort": number, "protocol": {Type: tools.SchemaString, Enum: tools.EnumOf("tcp", "udp")}, "hostIp": text,
	}}
	env := tools.Schema{Type: tools.SchemaObject, Required: []string{"key"}, Properties: map[string]tools.Schema{"key": text, "value": text, "remove": flag}}
	mount := tools.Schema{Type: tools.SchemaObject, Required: []string{"kind", "source", "target"}, Properties: map[string]tools.Schema{
		"kind": {Type: tools.SchemaString, Enum: tools.EnumOf("bind", "volume")}, "source": text, "target": text, "readOnly": flag,
	}}
	return []tools.Descriptor{
		{
			Name:        "docker_container_recreate_preview",
			Description: "只读预览独立容器重建，支持端口、非敏感环境变量、本地镜像和挂载。ports 和 mounts 提交完整目标列表，省略即保留；env 为增删改清单。敏感值请在 Web 设置，Compose 请修改项目配置。",
			SearchNames: []string{"预览容器重建", "修改端口映射", "修改容器环境变量", "容器挂载", "更换容器镜像"},
			Parameters: tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "patch"}, Properties: map[string]tools.Schema{
				"id": id, "patch": {Type: tools.SchemaObject, Properties: map[string]tools.Schema{
					"imageId": text, "ports": {Type: tools.SchemaArray, Items: &port}, "env": {Type: tools.SchemaArray, Items: &env}, "mounts": {Type: tools.SchemaArray, Items: &mount},
				}},
			}},
			Metadata: tools.Metadata{Domain: "docker", Action: "recreate_preview", Effect: "read", Exposure: "agent", ReadOnly: true, ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "1"},
			Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
				ctx := tools.Lifetime(c)
				raw, _ := json.Marshal(args["patch"])
				id, _ := tools.StringArg(args, "id")
				var patch domaindocker.RecreatePatch
				if err := json.Unmarshal(raw, &patch); err != nil {
					return nil, recreateArgumentError()
				}
				if tools.AuthorizedRunID(ctx) == "" {
					return nil, recreateArgumentError()
				}
				v, err := s.deps.Agent.PreviewAgentRecreate(ctx, id, patch, tools.AuthorizedRunID(ctx))
				return v, agentBusinessError(err)
			},
		},
		{
			Name:        "docker_container_recreate",
			Description: "按本轮权限提交已预览的独立容器重建。运行容器会短暂停机，成功后原容器保留为停用的恢复副本。重试同一请求必须复用原 requestId。",
			SearchNames: []string{"确认重建容器", "应用容器配置"},
			Parameters:  tools.Schema{Type: tools.SchemaObject, Required: []string{"id", "planId", "revision", "requestId"}, Properties: map[string]tools.Schema{"id": id, "planId": id, "revision": id, "requestId": id}},
			Metadata:    tools.Metadata{Domain: "docker", Backend: "domain", Action: "recreate", Effect: "write", Exposure: "agent", ResourceType: "docker-container", ResourceKeyArgument: "id", Version: "1", Async: true, TaskDomain: domaindocker.ContainerOperationDomain, TaskRequestArgument: "requestId"},
			Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
				ctx := tools.Lifetime(c)
				raw, _ := json.Marshal(args)
				var input domaindocker.RecreateInput
				if json.Unmarshal(raw, &input) != nil || tools.AuthorizedRunID(ctx) == "" {
					return nil, recreateArgumentError()
				}
				task, err := s.deps.Agent.SubmitAgentRecreate(ctx, input, tools.AuthorizedRunID(ctx))
				if err != nil {
					return nil, agentBusinessError(err)
				}
				return tools.Submission{Value: domaindocker.AgentOperationReceipt(task), Task: tools.TaskReference{Domain: domaindocker.ContainerOperationDomain, ID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest}}, nil
			},
		},
	}
}

func recreateArgumentError() error {
	return &tools.BusinessError{Code: "docker-recreate-invalid", Message: "重建参数或运行身份无效", NotDispatched: true}
}
