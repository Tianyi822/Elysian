package docker

import (
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domaindocker "elysian/server/internal/docker"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

func (s *Service) imageDescriptors() []tools.Descriptor {
	if s.deps.Agent == nil {
		return nil
	}
	text := tools.Schema{Type: tools.SchemaString}
	var descriptors []tools.Descriptor
	for _, spec := range []struct{ action, description string }{
		{"search", "按关键词搜索 Docker 镜像名称，可指定镜像源；只读，不拉取镜像。searchable=false 表示搜索不可用而非镜像不存在；已知名称可直接查版本，失败可用 docker_registry_list 选择其他源，每源逐次尝试，勿重复失败查询"},
		{"tags", "查询 Docker 镜像仓库的可用版本标签，可指定镜像源；只读，不拉取镜像。searchable=false 不表示镜像不存在；查询失败可用 docker_registry_list 换源，不重复已失败的源"},
		{"pull", "审批后按精确镜像名称和标签提交异步拉取任务；需精确资源授权，可指定 registry。相同请求重试复用原 requestId；仅任务 failed 且已结束可选其他源及新 requestId；running 或 unknown 禁止换源重投，逐次等待结果，受本轮预算限制"},
		{"pull_get", "只读查询指定 Docker 镜像拉取任务的状态和结果；结果未知不代表可以重新拉取"},
		{"pull_logs", "分页读取 Docker 镜像拉取任务的结构化状态日志和时间；只读，不提供 Docker 原始输出"},
		{"pull_cancel", "审批后请求取消指定 Docker 镜像拉取任务；需精确资源授权，回执不代表任务已停止或变更已回滚"},
		{"remove", "审批后删除本地指定 ID 的 Docker 镜像；需精确资源授权"},
	} {
		action := spec.action
		properties := map[string]tools.Schema{}
		required := []string{}
		metadata := tools.Metadata{Domain: "docker", Action: action, Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}
		switch action {
		case "search":
			required = []string{"term"}
			properties["term"], properties["registry"] = text, text
		case "tags":
			required = []string{"name"}
			properties["name"], properties["registry"] = text, text
		case "pull":
			required = []string{"id", "requestId"}
			properties["id"], properties["requestId"] = text, text
			properties["registry"] = tools.Schema{Type: tools.SchemaString, Description: "可选 HTTPS 镜像源地址，省略使用官方 Docker Hub，从 docker_registry_list 获取；id 保持原始名称:标签，不同时内嵌源地址"}
			metadata.Version = "2"
			metadata.Effect, metadata.ResourceType, metadata.ResourceKeyArgument, metadata.ReadOnly, metadata.Default, metadata.Async = "write", "docker-image", "id", false, false, true
			metadata.TaskDomain, metadata.TaskRequestArgument = "docker-image-pull", "requestId"
		case "remove":
			required = []string{"id"}
			properties["id"] = text
			metadata.Effect, metadata.ResourceType, metadata.ResourceKeyArgument, metadata.ReadOnly, metadata.Default = "write", "docker-image", "id", false, false
		case "pull_get", "pull_logs", "pull_cancel":
			required = []string{"id", "taskId"}
			properties["id"], properties["taskId"] = text, text
			if action == "pull_logs" {
				properties["cursor"] = text
				properties["limit"] = tools.Schema{Type: tools.SchemaInteger}
			}
			metadata.ResourceType, metadata.ResourceKeyArgument, metadata.Default = "docker-image", "id", false
			metadata.TaskDomain, metadata.TaskIDArgument = "docker-image-pull", "taskId"
			if action == "pull_get" {
				metadata.Action = "task_status"
			}
			if action == "pull_logs" {
				metadata.Action = "task_logs"
			}
			if action == "pull_cancel" {
				metadata.Action, metadata.Effect, metadata.ReadOnly, metadata.Async, metadata.TaskDomain, metadata.TaskIDArgument = "cancel", "write", false, true, "docker-image-pull", "taskId"
			}
		}
		descriptors = append(descriptors, tools.Descriptor{Name: "docker_image_" + action, Description: spec.description, Parameters: tools.Schema{Type: tools.SchemaObject, Required: required, Properties: properties}, Metadata: metadata, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			ctx := tools.Lifetime(c)
			id, _ := tools.StringArg(args, "id")
			registry, _ := tools.StringArg(args, "registry")
			switch action {
			case "pull_get", "pull_logs", "pull_cancel":
				taskID, _ := tools.StringArg(args, "taskId")
				task, err := s.deps.Agent.PullStatus(ctx, id, taskID, action == "pull_cancel")
				if err != nil {
					return nil, err
				}
				if action == "pull_cancel" {
					return tools.Submission{Value: map[string]any{"id": task.ID, "cancelRequested": true}, Task: tools.TaskReference{Domain: "docker-image-pull", ID: task.ID, RequestID: task.RequestID}}, nil
				}
				if action == "pull_logs" {
					cursor, _ := tools.StringArg(args, "cursor")
					limit, _ := tools.IntArg(args, "limit")
					return domaindocker.AgentPullLogPage(task, cursor, limit)
				}
				return task, nil
			case "search":
				term, _ := tools.StringArg(args, "term")
				value, err := s.deps.Agent.Search(ctx, term, registry)
				return value, agentBusinessError(err)
			case "tags":
				name, _ := tools.StringArg(args, "name")
				value, err := s.deps.Agent.Tags(ctx, name, registry)
				return value, agentBusinessError(err)
			case "pull":
				requestID, _ := tools.StringArg(args, "requestId")
				task, err := s.deps.Agent.PullFromRegistry(ctx, id, requestID, registry)
				if err != nil {
					return nil, agentBusinessError(err)
				}
				return tools.Submission{Value: task, Task: tools.TaskReference{Domain: "docker-image-pull", ID: task.ID, RequestID: task.RequestID}}, nil
			default:
				if err := s.deps.Agent.RemoveImage(ctx, id); err != nil {
					return nil, err
				}
				return map[string]bool{"removed": true}, nil
			}
		}})
	}
	return descriptors
}

func agentBusinessError(err error) error {
	if failure, ok := err.(*seam.AgentContainerError); ok {
		return &tools.BusinessError{Code: failure.Code, Message: failure.Message, NotDispatched: failure.NotDispatched}
	}
	// 不掩盖清理组合错误或其他链路故障。
	if failure, ok := err.(*domaindocker.AgentError); ok {
		return &tools.BusinessError{Code: failure.Code, Message: failure.Message, NotDispatched: failure.NotDispatched}
	}
	// 只读查询的状态类拒绝（查无此对象、ID 形态不符）是模型可以改判的事实，
	// 作为业务错误交回模型让运行继续；原始错误仍按原样上抛终止运行。
	if invalid, ok := err.(*shared.InvalidRequestError); ok {
		return &tools.BusinessError{Code: "docker-invalid-request", Message: invalid.Message}
	}
	return err
}

func (s *Service) registryDescriptors() []tools.Descriptor {
	if s.deps.Agent == nil {
		return nil
	}
	descriptors := []tools.Descriptor{}
	for _, action := range []string{"list", "probe"} {
		action := action
		properties := map[string]tools.Schema{}
		required := []string{}
		description := "只读列出镜像源预设，供查询或拉取失败后逐次选择其他源；不代表源当前可达。已知镜像名可直接查标签，每源失败后避免重复尝试，受本轮预算约束"
		if action == "probe" {
			properties["registry"] = tools.Schema{Type: tools.SchemaString}
			required = []string{"registry"}
			description = "只读按需探测单个镜像源：10 秒内下载最多 1 MiB Alpine 样本；只代表当次样本，不保证 MySQL 可用，不启动镜像拉取；无需预先测试全部源"
		}
		descriptors = append(descriptors, tools.Descriptor{Name: "docker_registry_" + action, Description: description, SearchNames: []string{"镜像源", "镜像加速", "换源", "registry mirror"}, Parameters: tools.Schema{Type: tools.SchemaObject, Required: required, Properties: properties}, Metadata: tools.Metadata{Domain: "docker", Action: "registry_" + action, Effect: "read", Exposure: "agent", ReadOnly: true, Default: true, Version: "1"}, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
			ctx := tools.Lifetime(c)
			if action == "list" {
				return s.deps.Agent.Registries(ctx)
			}
			registry, _ := tools.StringArg(args, "registry")
			result, err := s.deps.Agent.Probe(ctx, registry)
			return result, agentBusinessError(err)
		}})
	}
	return descriptors
}
