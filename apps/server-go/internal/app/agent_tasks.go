package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"

	"elysian/server/internal/agent/jsonvalue"
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

func agentTaskReconciler(inspect func(context.Context, tools.TaskReference) (tools.TaskStatus, error), containers *docker.AgentFacade, provisioning *database.AgentFacade) func(context.Context, tools.TaskReconciliation) error {
	return func(ctx context.Context, intent tools.TaskReconciliation) error {
		if intent.Task.Domain == database.ProvisionTaskDomain {
			// 数据库部署的未知任务按登记与实例内只读核对恢复事实，不重投原请求。
			if err := provisioningReady(provisioning); err != nil {
				return err
			}
			resolution, err := provisionResolutionFromIntent(intent)
			if err != nil {
				return err
			}
			return provisioning.ReconcileProvision(ctx, resolution)
		}
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
		input, target, err := containerOperationInput(intent.Tool, intent.ArgumentsJSON, intent.Task.RequestID)
		if err != nil {
			return err
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

func provisionResolutionFromIntent(intent tools.TaskReconciliation) (database.ProvisionResolution, error) {
	args, err := jsonvalue.Object([]byte(intent.ArgumentsJSON))
	if err != nil || intent.Tool != "database_provision" {
		return database.ProvisionResolution{}, errors.New("数据库部署核实工具或原参数无效")
	}
	input, err := database.DecodeProvisionInput(args)
	if err != nil || input.RequestID == "" || input.RequestID != intent.Task.RequestID {
		return database.ProvisionResolution{}, errors.New("数据库部署核实请求身份不匹配")
	}
	digest, err := database.ProvisionInputDigest(input)
	target := input.Engine + "/" + input.Version + "/" + input.Database
	if err != nil || intent.Task.Digest != "" && intent.Task.Digest != digest || intent.Task.Target != "" && intent.Task.Target != target {
		return database.ProvisionResolution{}, errors.New("数据库部署核实摘要不匹配")
	}
	// Older recovered references can omit target or digest. The domain rechecks
	// both reconstructed values against its immutable acceptance record.
	return database.ProvisionResolution{
		ID: intent.ID, TaskID: intent.Task.ID, RequestID: input.RequestID, Target: target, Digest: digest,
		Decision: intent.Decision, Evidence: intent.Evidence,
	}, nil
}

// provisionTaskStatus 把数据库部署任务映射成运行时状态；失败任务按对业务的影响带证据，
// 未派发与已回滚可以纠正后继续，部分完成如实说明已有变更，未知不提供任何证据。
func provisionTaskStatus(task database.ProvisionTask) tools.TaskStatus {
	terminal := task.State == database.ProvisionSucceeded || task.State == database.ProvisionFailed
	outcome := taskOutcome(terminal, task.State == database.ProvisionFailed, task.State == database.ProvisionRunning)
	status := normalizedTaskStatus(outcome, task.State, database.ProvisionAgentReceipt(task), task.ErrorCode, task.Message, agentTaskProgress(task.State, terminal, task.Message, task.UpdatedAt, "正在部署数据库"))
	switch {
	case task.State != database.ProvisionFailed:
	case task.Effect == database.ProvisionEffectNotDispatched:
		status.Evidence = &tools.ExecutionEvidence{Execution: "not-started", Changes: "none", Recovery: "correct", Stage: "preflight"}
	case task.Effect == database.ProvisionEffectNoChange:
		status.Evidence = &tools.ExecutionEvidence{Execution: "finished", Changes: "none", Recovery: "correct"}
	case task.Effect == database.ProvisionEffectPartial:
		status.Evidence = &tools.ExecutionEvidence{Execution: "finished", Changes: "confirmed", Recovery: "correct", Stage: task.Stage}
	}
	return status
}

// provisioningReady 判断数据库部署任务服务是否可用。
func provisioningReady(provisioning *database.AgentFacade) error {
	if provisioning == nil || !provisioning.Available() {
		return errors.New("数据库部署任务服务未装配")
	}
	return nil
}

func agentTaskInspector(sites *websites.AgentFacade, apps *containerapps.AgentFacade, containers *docker.AgentFacade, databases database.LegacyTaskLedger, provisioning *database.AgentFacade) func(context.Context, tools.TaskReference) (tools.TaskStatus, error) {
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
			task = docker.RecreateTaskStatus(task)
			terminal := task.State == "succeeded" || task.State == "failed"
			outcome := taskOutcome(terminal, task.State == "failed", task.State == "running")
			status := normalizedTaskStatus(outcome, task.State, docker.AgentOperationReceipt(task), task.ErrorCode, task.Message, agentTaskProgress(task.State, terminal, task.Message, task.UpdatedAt, "正在执行容器操作"))
			if task.State == "failed" {
				status.Evidence = &tools.ExecutionEvidence{Execution: "finished", Changes: "none", Recovery: "correct", Stage: task.Stage}
			}
			if task.ErrorCode == "docker-recreate-rolled-back" {
				status.Evidence = &tools.ExecutionEvidence{Execution: "finished", Changes: "confirmed", Recovery: "correct", Stage: "rolled-back"}
			}
			if task.Stage == "preflight-rejected" {
				status.Evidence = &tools.ExecutionEvidence{Execution: "not-started", Changes: "none", Recovery: "correct", Stage: "preflight"}
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
			task, err := databases.Read(ctx, ref.ID, ref.RequestID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if task.State == "succeeded" {
				return normalizedTaskStatus(tools.TaskSucceeded, task.State, task, "", "", nil), nil
			}
			return normalizedTaskStatus(tools.TaskUnknown, task.State, task, "database-task-unknown", task.Message, nil), nil
		case database.ProvisionTaskDomain:
			if err := provisioningReady(provisioning); err != nil {
				return tools.TaskStatus{}, err
			}
			task, err := provisioning.InspectProvision(ctx, ref.ID)
			if err != nil {
				return tools.TaskStatus{}, err
			}
			if task.RequestID != ref.RequestID || ref.Target != "" && ref.Target != task.Target || ref.Digest != "" && ref.Digest != task.Digest {
				return tools.TaskStatus{}, errors.New("数据库部署请求身份不匹配")
			}
			return provisionTaskStatus(task), nil
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

func agentTaskLookup(sites *websites.AgentFacade, apps *containerapps.AgentFacade, containers *docker.AgentFacade, databases database.LegacyTaskLedger, provisioning *database.AgentFacade) func(context.Context, tools.TaskReference) (tools.TaskReference, error) {
	return func(ctx context.Context, ref tools.TaskReference) (tools.TaskReference, error) {
		if ref.Domain == "database" {
			task, err := databases.Read(ctx, ref.ID, ref.RequestID)
			if err != nil {
				return ref, err
			}
			ref.ID, ref.RequestID = task.ID, task.RequestID
			return ref, nil
		}
		if ref.Domain == database.ProvisionTaskDomain {
			if err := provisioningReady(provisioning); err != nil {
				return ref, err
			}
			var task database.ProvisionTask
			var err error
			if ref.ID != "" {
				task, err = provisioning.InspectProvision(ctx, ref.ID)
			} else {
				task, err = provisioning.LookupProvision(ctx, ref.RequestID)
			}
			if err != nil {
				return ref, err
			}
			if ref.RequestID != "" && ref.RequestID != task.RequestID ||
				ref.Target != "" && ref.Target != task.Target || ref.Digest != "" && ref.Digest != task.Digest {
				return ref, errors.New("数据库部署请求身份不匹配")
			}
			ref.ID, ref.RequestID, ref.Target, ref.Digest = task.ID, task.RequestID, task.Target, task.Digest
			return ref, nil
		}
		if ref.ID != "" {
			var requestID string
			var err error
			switch ref.Domain {
			case docker.ContainerOperationDomain:
				var task docker.ContainerOperationTask
				task, err = containers.InspectContainerOperation(ctx, ref.ID)
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
func agentTaskCanceller(sites *websites.AgentFacade, apps *containerapps.AgentFacade, containers *docker.AgentFacade, databases database.LegacyTaskLedger, provisioning *database.AgentFacade) func(context.Context, tools.TaskReference) error {
	return func(ctx context.Context, ref tools.TaskReference) error {
		if ref.ID == "" || ref.RequestID == "" {
			return errors.New("后台任务身份缺失")
		}
		switch ref.Domain {
		case docker.ContainerOperationDomain:
			return containers.CancelContainerOperation(ctx, ref.ID, ref.RequestID)
		case "website":
			return sites.CancelOwnedTask(ctx, ref.ID, ref.RequestID)
		case "container-app-build":
			return apps.CancelOwnedTask(ctx, ref.ID, ref.RequestID)
		case "docker-image-pull":
			return containers.CancelOwnedTask(ctx, ref.ID, ref.RequestID)
		case database.ProvisionTaskDomain:
			if err := provisioningReady(provisioning); err != nil {
				return err
			}
			return provisioning.CancelProvision(ctx, ref.ID, ref.RequestID)
		case "database":
			// The retired worker is absent; only verify that the reference belongs to it.
			_, err := databases.Read(ctx, ref.ID, ref.RequestID)
			return err
		default:
			return errors.New("后台任务领域无效")
		}
	}
}
