package app

import (
	"context"
	"errors"
	"math"

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
			return tools.TaskStatus{State: task.State, Terminal: task.State == "succeeded", Value: task, Progress: agentTaskProgress(task.State, task.State == "succeeded", task.Message, "", "正在执行数据库任务")}, nil
		case "docker-image-pull":
			task, err := containers.InspectPull(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if task.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("镜像拉取请求身份不匹配")
			}
			terminal := task.State == "succeeded" || task.State == "failed"
			return tools.TaskStatus{State: task.State, Terminal: terminal, Failed: terminal && task.State != "succeeded", Value: task, Error: task.ErrorMessage, Progress: agentPullProgress(task)}, nil
		case "website":
			status, err := sites.InspectTask(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if status.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("网站任务请求身份不匹配")
			}
			return tools.TaskStatus{State: status.State, Terminal: status.Terminal, Failed: status.Failed, Value: status.Value, Error: status.Error, Progress: agentTaskProgress(status.State, status.Terminal, status.Stage, status.UpdatedAt, "正在执行网站任务")}, nil
		case "container-app-build":
			status, err := apps.InspectTask(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if status.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("镜像任务请求身份不匹配")
			}
			return tools.TaskStatus{State: status.State, Terminal: status.Terminal, Failed: status.Failed, Value: status.Value, Error: status.Error, Progress: agentTaskProgress(status.State, status.Terminal, status.Stage, status.UpdatedAt, "正在构建容器镜像")}, nil
		default:
			return tools.TaskStatus{}, errors.New("异步任务领域无效")
		}
	}
}

// 仅投影各域已有的受控阶段文案，不读取自由日志或调用模型。
func agentTaskProgress(state string, terminal bool, message, updatedAt, fallback string) *tools.TaskProgress {
	if terminal {
		return nil
	}
	progress := &tools.TaskProgress{State: "running", Message: message, UpdatedAt: updatedAt}
	switch state {
	case "unknown", "interrupted", "failed", "cancelled":
		progress.State = "unknown"
		if progress.Message == "" {
			progress.Message = "任务结果未确认，须核实实际状态"
		}
	}
	if progress.Message == "" {
		progress.Message = fallback
	}
	return progress
}

func agentPullProgress(task docker.AgentPullTask) *tools.TaskProgress {
	progress := agentTaskProgress(task.State, task.State == "succeeded" || task.State == "failed", task.ErrorMessage, task.UpdatedAt, "正在准备镜像拉取")
	if progress == nil || progress.State == "unknown" || task.Progress == nil {
		return progress
	}
	source := task.Progress
	if source.Message != "" {
		progress.Message = source.Message
	} else if label := map[string]string{"preparing": "正在准备镜像层", "downloading": "正在下载镜像层", "extracting": "正在解压镜像层", "finalizing": "正在确认镜像拉取结果"}[source.Phase]; label != "" {
		progress.Message = label
	}
	if source.Phase == "downloading" || source.Phase == "extracting" {
		progress.LayerID = source.LayerID
		if source.LayerID != "" && source.CurrentBytes != nil && source.TotalBytes != nil {
			current, total := *source.CurrentBytes, *source.TotalBytes
			if !math.IsNaN(current) && !math.IsNaN(total) && current >= 0 && total > 0 && current <= total && total <= 1<<53-1 {
				progress.CurrentBytes, progress.TotalBytes = &current, &total
			}
		}
	}
	return progress
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

// 仅供管理员删除会话后的宿主收尾使用，要求完整匹配持久任务身份。
func agentTaskCanceller(sites *websites.AgentFacade, apps *containerapps.AgentFacade, containers *docker.AgentFacade, databases *database.AgentFacade) func(context.Context, tools.TaskReference) error {
	return func(ctx context.Context, ref tools.TaskReference) error {
		if ref.ID == "" || ref.RequestID == "" {
			return errors.New("后台任务身份缺失")
		}
		switch ref.Domain {
		case "database":
			return databases.CancelOwnedTask(ctx, ref.ID, ref.RequestID)
		case "website":
			return sites.CancelOwnedTask(ctx, ref.ID, ref.RequestID)
		case "container-app-build":
			return apps.CancelOwnedTask(ctx, ref.ID, ref.RequestID)
		case "docker-image-pull":
			return containers.CancelOwnedTask(ctx, ref.ID, ref.RequestID)
		default:
			return errors.New("后台任务领域无效")
		}
	}
}
