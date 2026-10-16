package docker

import (
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	domaindocker "elysian/server/internal/docker"
)

func (s *Service) imageDescriptors() []tools.Descriptor {
	if s.deps.Agent == nil {
		return nil
	}
	text := tools.Schema{Type: tools.SchemaString}
	var descriptors []tools.Descriptor
	for _, action := range []string{"search", "tags", "pull", "pull_get", "pull_logs", "pull_cancel", "remove"} {
		action := action
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
		descriptors = append(descriptors, tools.Descriptor{Name: "docker_image_" + action, Description: "Docker 镜像" + action + "，写操作需精确资源授权和审批", Parameters: tools.Schema{Type: tools.SchemaObject, Required: required, Properties: properties}, Metadata: metadata, Handler: func(c *kardia.Context, args tools.Arguments) (any, error) {
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
				return s.deps.Agent.Search(ctx, term, registry)
			case "tags":
				name, _ := tools.StringArg(args, "name")
				return s.deps.Agent.Tags(ctx, name, registry)
			case "pull":
				requestID, _ := tools.StringArg(args, "requestId")
				task, err := s.deps.Agent.Pull(ctx, id, requestID)
				if err != nil {
					return nil, err
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
