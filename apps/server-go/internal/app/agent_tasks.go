package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"

	"elysian/server/internal/agent/tools"
	"elysian/server/internal/containerapps"
	"elysian/server/internal/database"
	"elysian/server/internal/docker"
	"elysian/server/internal/websites"
)

func taskOutcome(terminal, failed, running bool) tools.TaskOutcome {
	if terminal {
		if failed {
			return tools.TaskFailed
		}
		return tools.TaskSucceeded
	}
	if running {
		return tools.TaskRunning
	}
	return tools.TaskUnknown
}

func normalizedTaskStatus(outcome tools.TaskOutcome, state string, value any, code, message string, progress *tools.TaskProgress) tools.TaskStatus {
	if outcome == tools.TaskUnknown && message == "" {
		message = "任务结果未确认，须核实实际状态，禁止自动重投"
	}
	if outcome == tools.TaskUnknown && code == "" {
		code = "domain-task-unknown"
	}
	return tools.TaskStatus{Outcome: outcome, State: state, Terminal: outcome == tools.TaskSucceeded || outcome == tools.TaskFailed, Failed: outcome == tools.TaskFailed, Value: value, ErrorCode: code, Error: message, Progress: progress}
}

func websiteTaskStatus(status websites.AgentTaskStatus) tools.TaskStatus {
	running := status.State == "queued" || status.State == "building" || status.State == "publishing" || status.State == "awaiting-config"
	outcome := taskOutcome(status.Terminal, status.Failed, running)
	return normalizedTaskStatus(outcome, status.State, status.Value, "website-task-"+string(outcome), status.Error, agentTaskProgress(status.State, status.Terminal, status.Stage, status.UpdatedAt, "正在执行网站任务"))
}

func containerBuildTaskStatus(status containerapps.AgentTaskStatus) tools.TaskStatus {
	running := status.State == containerapps.BuildStateQueued || status.State == containerapps.BuildStateBuilding
	outcome := taskOutcome(status.Terminal, status.Failed, running)
	return normalizedTaskStatus(outcome, status.State, status.Value, "container-app-build-"+string(outcome), status.Error, agentTaskProgress(status.State, status.Terminal, status.Stage, status.UpdatedAt, "正在构建容器镜像"))
}

func agentTaskReconciler(sites *websites.AgentFacade, apps *containerapps.AgentFacade, containers *docker.AgentFacade, databases *database.AgentFacade) func(context.Context, tools.TaskReconciliation) error {
	inspect := agentTaskInspector(sites, apps, containers, databases)
	return func(ctx context.Context, intent tools.TaskReconciliation) error {
		if intent.Task.Domain != docker.ContainerOperationDomain {
			status, err := inspect(ctx, intent.Task)
			if err != nil {
				return err
			}
			if status.EffectiveOutcome() == tools.TaskSucceeded || status.EffectiveOutcome() == tools.TaskFailed {
				return nil
			}
			return errors.New("域任务尚无可核实的结束回执")
		}
		var input any
		var target string
		switch intent.Tool {
		case "docker_container_exec":
			var value docker.ContainerExecInput
			if err := decodeContainerArguments(intent.ArgumentsJSON, &value); err != nil {
				return err
			}
			if value.RequestID != intent.Task.RequestID {
				return errors.New("容器操作原始请求身份不匹配")
			}
			input, target = value, value.ID
		case "docker_container_create_service":
			var value docker.AgentServiceCreateInput
			if err := decodeContainerArguments(intent.ArgumentsJSON, &value); err != nil {
				return err
			}
			if value.RequestID != intent.Task.RequestID {
				return errors.New("容器操作原始请求身份不匹配")
			}
			input, target = value, "name:"+value.Name
		default:
			return errors.New("无法核对容器操作的原始输入")
		}
		raw, err := json.Marshal(input)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(raw)
		digest := hex.EncodeToString(sum[:])
		if intent.Task.Target != "" && intent.Task.Target != target || intent.Task.Digest != "" && intent.Task.Digest != digest {
			return errors.New("容器操作受理摘要不匹配")
		}
		return containers.ReconcileContainerOperation(ctx, docker.ContainerOperationResolution{ID: intent.ID, TaskID: intent.Task.ID, RequestID: intent.Task.RequestID, Target: target, Digest: digest, Decision: intent.Decision, Evidence: intent.Evidence})
	}
}

func agentTaskInspector(sites *websites.AgentFacade, apps *containerapps.AgentFacade, containers *docker.AgentFacade, databases *database.AgentFacade) func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
	return func(ctx context.Context, ref tools.TaskReference) (tools.TaskStatus, error) {
		if ref.ID == "" || ref.RequestID == "" {
			return tools.TaskStatus{}, errors.New("异步任务身份缺失")
		}
		switch ref.Domain {
		case docker.ContainerOperationDomain:
			task, err := containers.ObserveContainerOperation(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if task.RequestID != ref.RequestID || ref.Target != "" && ref.Target != task.Target || ref.Digest != "" && ref.Digest != task.Digest {
				return tools.TaskStatus{}, errors.New("容器操作请求身份不匹配")
			}
			terminal := task.State == "succeeded" || task.State == "failed"
			outcome := taskOutcome(terminal, task.State == "failed", task.State == "running")
			status := normalizedTaskStatus(outcome, task.State, docker.AgentOperationReceipt(task), task.ErrorCode, task.Message, agentTaskProgress(task.State, terminal, task.Message, task.UpdatedAt, "正在执行容器操作"))
			if task.State == "failed" {
				status.Evidence = &tools.ExecutionEvidence{Execution: "finished", Changes: "none", Recovery: "correct", Stage: task.Stage}
			}
			if task.Stage == "not-accepted" {
				status.Evidence = &tools.ExecutionEvidence{Execution: "not-started", Changes: "none", Recovery: "correct", Stage: "preflight", Suggestion: "修正参数并重新审批后使用新的请求编号提交"}
			}
			if task.Observation != nil {
				status.Outcome = tools.TaskSucceeded
				status.Terminal = true
				status.Failed = false
				status.Progress = nil
				status.Evidence = &tools.ExecutionEvidence{Execution: "finished", Changes: "unknown", Recovery: "verify", Stage: "exec-observed", Suggestion: "已核实命令退出状态；原输出无法恢复，请回读目标状态核对业务结果"}
				status.ErrorCode, status.Error = "", ""
				if task.Observation.ExitCode != 0 {
					// A nonzero exit can leave partial changes. Termination alone
					// does not authorize another mutation or release protection.
					status.Outcome = tools.TaskUnknown
					status.Terminal = false
					status.ErrorCode = "docker-exec-observed-failed"
					status.Error = "已核实容器命令以非零状态退出；已有变更须回读，原输出无法恢复"
				}
			}
			return status, nil
		case "database":
			task, err := databases.InspectTask(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if task.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("数据库任务请求身份不匹配")
			}
			outcome := taskOutcome(task.State == "succeeded", false, task.State == "running" || task.State == "pending")
			return normalizedTaskStatus(outcome, task.State, task, "database-task-unknown", task.Message, agentTaskProgress(task.State, task.State == "succeeded", task.Message, "", "正在执行数据库任务")), nil
		case "docker-image-pull":
			task, err := containers.InspectPull(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if task.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("镜像拉取请求身份不匹配")
			}
			terminal := task.State == "succeeded" || task.State == "failed"
			outcome := taskOutcome(terminal, task.State == "failed", task.State == "running")
			return normalizedTaskStatus(outcome, task.State, task, "docker-image-pull-"+task.State, task.ErrorMessage, agentPullProgress(task)), nil
		case "website":
			status, err := sites.InspectTask(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if status.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("网站任务请求身份不匹配")
			}
			return websiteTaskStatus(status), nil
		case "container-app-build":
			status, err := apps.InspectTask(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if status.RequestID != ref.RequestID {
				return tools.TaskStatus{}, errors.New("镜像任务请求身份不匹配")
			}
			return containerBuildTaskStatus(status), nil
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
			case docker.ContainerOperationDomain:
				var task docker.ContainerOperationTask
				task, err = containers.InspectContainerOperation(ctx, ref.ID)
				requestID = task.RequestID
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
		case docker.ContainerOperationDomain:
			task, err := containers.LookupContainerOperation(ctx, ref.RequestID)
			if err != nil {
				return ref, err
			}
			ref.ID = task.ID
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
		case docker.ContainerOperationDomain:
			return containers.CancelContainerOperation(ctx, ref.ID, ref.RequestID)
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
