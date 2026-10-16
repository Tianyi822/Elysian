package app

import (
	"context"
	"errors"

	"elysian/server/internal/agent/tools"
	"elysian/server/internal/containerapps"
	"elysian/server/internal/database"
	"elysian/server/internal/docker"
	"elysian/server/internal/websites"
)

func agentTaskInspector(sites *websites.AgentFacade, apps *containerapps.AgentFacade, containers *docker.AgentFacade, databases *database.AgentFacade) func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
	return func(ctx context.Context, ref tools.TaskReference) (tools.TaskStatus, error) {
		if ref.ID == "" || ref.RequestID == "" {
			return tools.TaskStatus{}, errors.New("异步任务身份缺失")
		}
		switch ref.Domain {
		case "database":
			task, err := databases.InspectTask(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if task.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("数据库任务请求身份不匹配")
			}
			return tools.TaskStatus{State: task.State, Terminal: task.State == "succeeded", Value: task}, nil
		case "docker-image-pull":
			task, err := containers.InspectPull(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if task.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("镜像拉取请求身份不匹配")
			}
			terminal := task.State == "succeeded" || task.State == "failed"
			return tools.TaskStatus{State: task.State, Terminal: terminal, Failed: terminal && task.State != "succeeded", Value: task}, nil
		case "website":
			status, err := sites.InspectTask(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if status.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("网站任务请求身份不匹配")
			}
			return tools.TaskStatus{State: status.State, Terminal: status.Terminal, Failed: status.Failed, Value: status.Value, Error: status.Error}, nil
		case "container-app-build":
			status, err := apps.InspectTask(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if status.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("镜像任务请求身份不匹配")
			}
			return tools.TaskStatus{State: status.State, Terminal: status.Terminal, Failed: status.Failed, Value: status.Value, Error: status.Error}, nil
		default:
			return tools.TaskStatus{}, errors.New("异步任务领域无效")
		}
	}
}

func agentTaskLookup(sites *websites.AgentFacade, apps *containerapps.AgentFacade, containers *docker.AgentFacade, databases *database.AgentFacade) func(context.Context, tools.TaskReference) (tools.TaskReference, error) {
	return func(ctx context.Context, ref tools.TaskReference) (tools.TaskReference, error) {
		if ref.ID != "" {
			var requestID string
			var err error
			switch ref.Domain {
			case "database":
				var task database.AgentTask
				task, err = databases.InspectTask(ctx, ref.ID)
				requestID = task.RequestID
			case "website":
				var task websites.AgentTaskStatus
				task, err = sites.InspectTask(ctx, ref.ID)
				requestID = task.RequestID
			case "container-app-build":
				var task containerapps.AgentTaskStatus
				task, err = apps.InspectTask(ctx, ref.ID)
				requestID = task.RequestID
			case "docker-image-pull":
				var task docker.AgentPullTask
				task, err = containers.InspectPull(ctx, ref.ID)
				requestID = task.RequestID
			default:
				err = errors.New("异步任务领域无效")
			}
			if err != nil {
				return ref, err
			}
			if requestID == "" || ref.RequestID != "" && ref.RequestID != requestID {
				return ref, errors.New("异步任务请求身份不匹配")
			}
			ref.RequestID = requestID
			return ref, nil
		}
		if ref.RequestID == "" {
			return ref, errors.New("异步任务请求身份缺失")
		}
		var err error
		switch ref.Domain {
		case "database":
			var task database.AgentTask
			task, err = databases.LookupTask(ctx, ref.RequestID)
			ref.ID = task.ID
		case "website":
			ref.ID, err = sites.LookupTask(ctx, ref.RequestID)
		case "container-app-build":
			ref.ID, err = apps.LookupTask(ctx, ref.RequestID)
		case "docker-image-pull":
			var task docker.AgentPullTask
			task, err = containers.LookupPull(ctx, ref.RequestID)
			ref.ID = task.ID
		default:
			err = errors.New("异步任务领域无效")
		}
		return ref, err
	}
}
