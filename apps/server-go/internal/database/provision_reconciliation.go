package database

import (
	"context"
	"errors"
	"strings"

	"elysian/server/internal/shared"
)

// ProvisionResolution is stored alongside the original domain receipt.
type ProvisionResolution struct {
	ID        string `json:"id"`
	TaskID    string `json:"taskId"`
	RequestID string `json:"requestId"`
	Target    string `json:"target"`
	Digest    string `json:"digest"`
	Decision  string `json:"decision"`
	Evidence  string `json:"evidence"`
	Effect    string `json:"effect,omitempty"`
}

func resolutionMatches(task ProvisionTask, resolution ProvisionResolution) bool {
	return resolution.ID != "" && resolution.TaskID == task.ID && resolution.RequestID == task.RequestID &&
		resolution.Target == task.Target && resolution.Digest != "" && resolution.Digest == task.Digest &&
		len(resolution.Evidence) > 0 && len(resolution.Evidence) <= 8192 &&
		(resolution.Decision == "confirmed-completed" || resolution.Decision == "confirmed-stopped")
}

func sameProvisionDecision(saved, requested ProvisionResolution) bool {
	requested.Effect = saved.Effect
	return saved == requested
}

// ReconcileProvision records evidence without re-dispatching the original task.
func (f *AgentFacade) ReconcileProvision(ctx context.Context, resolution ProvisionResolution) error {
	task, err := f.InspectProvision(ctx, resolution.TaskID)
	if err != nil {
		return err
	}
	if !resolutionMatches(task, resolution) {
		return shared.InvalidRequest("数据库部署核实身份或证据不匹配")
	}
	if task.Resolution != nil {
		if sameProvisionDecision(*task.Resolution, resolution) {
			return nil
		}
		return shared.Conflict("数据库部署已有不同核实决定")
	}
	release, err := f.lockProvisionTarget(ctx, task.InstanceID, task.InstanceName, true)
	if err != nil {
		return err
	}
	defer release()
	task, err = f.InspectProvision(ctx, resolution.TaskID)
	if err != nil {
		return err
	}
	if !resolutionMatches(task, resolution) {
		return shared.InvalidRequest("数据库部署核实期间身份已变化")
	}
	if task.Resolution != nil {
		if sameProvisionDecision(*task.Resolution, resolution) {
			return nil
		}
		return shared.Conflict("数据库部署已有不同核实决定")
	}
	resolution.Effect = ""
	f.operationMu.Lock()
	active := f.operationCancel[task.ID] != nil
	f.operationMu.Unlock()
	if active || task.State == ProvisionRunning {
		return shared.Conflict("数据库部署仍在执行")
	}
	switch task.State {
	case ProvisionUnknown:
		effect, err := f.verifyProvisionResolution(ctx, task, resolution.Decision)
		if err != nil {
			return err
		}
		resolution.Effect = effect
	case ProvisionSucceeded:
		if resolution.Decision != "confirmed-completed" {
			return shared.Conflict("原任务已有成功回执")
		}
	case ProvisionFailed:
		if resolution.Decision != "confirmed-stopped" {
			return shared.Conflict("原任务已有失败回执")
		}
		resolution.Effect = task.Effect
	default:
		return shared.Conflict("数据库部署状态无法核实")
	}

	f.operationMu.Lock()
	defer f.operationMu.Unlock()
	current := f.operations[task.ID]
	if !resolutionMatches(current, resolution) || current.State != task.State || f.operationCancel[task.ID] != nil {
		return shared.Conflict("数据库部署核实期间任务状态已变化")
	}
	if current.Resolution != nil {
		if sameProvisionDecision(*current.Resolution, resolution) {
			return nil
		}
		return shared.Conflict("数据库部署已有不同核实决定")
	}
	current.Resolution = &resolution
	return f.publishProvisionLocked(task.ID, current)
}

func (f *AgentFacade) verifyProvisionResolution(ctx context.Context, task ProvisionTask, decision string) (string, error) {
	docker, _ := f.service.deps.docker.(*dockerAPI)
	var volume string
	redisPersisted, created := false, false
	for _, write := range task.Writes {
		if write.Volume != "" {
			volume = write.Volume
		}
		created = created || write.Stage == "create-container"
		redisPersisted = redisPersisted || write.Stage == "redis-acl-persisted" && write.Finished
		if write.Finished {
			continue
		}
		if docker == nil || write.ExecID == "" || write.InstanceID != task.InstanceID {
			return "", shared.Conflict("原变更请求尚无可信结束证据")
		}
		if _, err := docker.inspectAdminExec(ctx, write.ExecID, task.InstanceID); err != nil {
			return "", shared.Conflict("原容器命令运行状态或身份无法确认")
		}
	}

	engine, rest, ok := strings.Cut(task.Target, "/")
	version, name, valid := strings.Cut(rest, "/")
	if !ok || !valid || validateLogicalDatabase(name) != nil || !validDatabaseVersion(version) {
		return "", shared.InvalidRequest("部署目标无法核实")
	}
	rows, err := f.service.deps.registry.list()
	if err != nil {
		return "", err
	}
	for _, row := range rows {
		if row.ContainerID != task.InstanceID || row.Engine != engine || !versionMatches(row.VersionTag, version) {
			continue
		}
		for _, logical := range row.Logical {
			if logical.RequestID == task.RequestID && logical.Name == name && len(logical.Users) == 1 {
				return f.verifyRegisteredProvision(ctx, task, row, logical, decision, created, redisPersisted)
			}
		}
	}
	if decision == "confirmed-stopped" && created && task.InstanceID != "" && volume != "" &&
		f.service.deps.docker.verifyRemoved(ctx, task.InstanceID, volume) == nil {
		return ProvisionEffectNoChange, nil
	}
	return "", shared.Conflict("没有可核实的部署结束记录")
}

func (f *AgentFacade) verifyRegisteredProvision(ctx context.Context, task ProvisionTask, row databaseRecord, logical logicalDatabaseRecord, decision string, created, redisPersisted bool) (string, error) {
	admin := f.service.deps.admin
	if admin == nil || row.Admin.Password == "" {
		return "", errors.New("实例管理凭据不可核验")
	}
	target := adminTarget{containerID: task.InstanceID, engine: row.Engine, admin: row.Admin}
	user := logical.Users[0]
	facts, err := admin.inspectLogical(ctx, target, logicalPlan{database: logical.Name, username: user.Username, password: user.Password})
	if err != nil {
		return "", shared.Conflict("无法回读实例内的部署事实")
	}
	complete := facts.User && facts.PasswordMatches && facts.PermissionsMatch
	if row.Engine == engineRedis {
		complete = complete && (redisPersisted || logical.State == logicalStateActive)
	} else {
		complete = complete && facts.Database
	}
	if decision == "confirmed-completed" && complete && (logical.State == logicalStateActive || len(task.Writes) > 0 && logical.State == logicalStatePending) {
		if logical.State == logicalStatePending {
			if err := f.service.activateLogical(ctx, row.ContainerID, logical.ID); err != nil {
				return "", err
			}
		}
		return "", nil
	}
	if decision == "confirmed-stopped" && !complete && len(task.Writes) > 0 {
		if facts.PasswordMatches || created {
			return ProvisionEffectPartial, nil
		}
		if !facts.Database && !facts.User && logical.State == logicalStatePending {
			return ProvisionEffectNoChange, nil
		}
	}
	return "", shared.Conflict("回读证据与核实决定不一致，保持部署保护")
}
