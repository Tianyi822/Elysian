package docker

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

type ContainerUpdateInput struct {
	ID                string  `json:"id"`
	RequestID         string  `json:"requestId"`
	RestartPolicy     *string `json:"restartPolicy,omitempty"`
	RestartMaxRetries *int    `json:"restartMaxRetries,omitempty"`
	MemoryMiB         *int    `json:"memoryMiB,omitempty"`
	CPUMillis         *int    `json:"cpuMillis,omitempty"`
	PIDsLimit         *int    `json:"pidsLimit,omitempty"`
}

// ScopedContainerOperationInput binds expanded tool versions to new request identities.
// Earlier operation digests are read and sealed using their original shape.
func ScopedContainerOperationInput(operation string, input any) any {
	return struct {
		Operation string `json:"operation"`
		Input     any    `json:"input"`
	}{operation, input}
}

type updateValues struct {
	restart string
	retries int64
	memory  int64
	nanoCPU int64
	quota   int64
	period  int64
	pids    int64
}

type updateChange struct {
	From any `json:"from"`
	To   any `json:"to"`
}

type containerUpdateResult struct {
	ID           string                  `json:"id"`
	Changes      map[string]updateChange `json:"changes"`
	WarningCount int                     `json:"warningCount"`
	AgentTargetNotes
}

func (a *AgentFacade) validateUpdateTarget(ctx context.Context, id string) (any, error) {
	value, err := a.inspectHostTarget(ctx, id)
	if err != nil {
		return nil, err
	}
	if _, err := a.operableTargetInspect(value); err != nil {
		return nil, err
	}
	return value, nil
}

func (a *AgentFacade) SubmitUpdate(ctx context.Context, input ContainerUpdateInput) (ContainerOperationTask, error) {
	if err := a.check(ctx); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	if !agentOperationIDPattern.MatchString(input.RequestID) {
		return ContainerOperationTask{}, agentSubmitRejected(shared.InvalidRequest("容器更新需要稳定的 64 位小写十六进制 requestId"))
	}
	identity := ScopedContainerOperationInput("update/v1", input)
	if task, ok, err := a.existingContainerOperation(input.RequestID, input.ID, identity); ok || err != nil {
		return task, agentSubmitRejected(err)
	}
	if err := a.CheckContainerMutation(ctx, input.ID, "", ""); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	value, err := a.validateUpdateTarget(ctx, input.ID)
	if err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	if err := a.checkDomainExecOrUpdate(ctx, input.ID, false); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	if _, err := planContainerUpdate(value, input); err != nil {
		return ContainerOperationTask{}, agentSubmitRejected(err)
	}
	return a.submitContainerOperation(input.RequestID, input.ID, identity, func(ctx context.Context, _ string) (any, error) {
		return a.executeUpdate(ctx, input)
	})
}

func (a *AgentFacade) executeUpdate(ctx context.Context, input ContainerUpdateInput) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	release, err := a.service.tryLockAction(input.ID)
	if err != nil {
		return nil, workerPreflightFailure(err)
	}
	defer release()
	if err := a.CheckContainerMutation(ctx, input.ID, "", input.RequestID); err != nil {
		return nil, workerPreflightFailure(err)
	}
	value, err := a.validateUpdateTarget(ctx, input.ID)
	if err != nil {
		return nil, workerPreflightFailure(err)
	}
	patch, err := planContainerUpdate(value, input)
	if err != nil {
		return nil, workerPreflightFailure(err)
	}
	result := containerUpdateResult{ID: input.ID, Changes: map[string]updateChange{}, AgentTargetNotes: describeAgentTarget(value, a.service.deps.selfContainerID)}
	if len(patch) == 0 {
		return result, nil
	}
	warnings, err := a.service.updateContainer(ctx, input.ID, patch)
	if err != nil {
		return nil, updateUnconfirmed()
	}
	latest, err := a.inspectHostTarget(ctx, input.ID)
	if err != nil {
		return nil, updateUnconfirmed()
	}
	before, after := readUpdateValues(value), readUpdateValues(latest)
	if remaining, err := planContainerUpdate(latest, input); err != nil || len(remaining) != 0 {
		return nil, updateUnconfirmed()
	}
	result.WarningCount = warnings
	for _, change := range []struct {
		key      string
		from, to any
		changed  bool
	}{
		{"restartPolicy", before.restart, after.restart, before.restart != after.restart},
		{"restartMaxRetries", before.retries, after.retries, before.retries != after.retries},
		{"memoryMiB", float64(before.memory) / mib, float64(after.memory) / mib, before.memory != after.memory},
		{"cpuMillis", before.cpuMillis(), after.cpuMillis(), before.cpuMillis() != after.cpuMillis()},
		{"pidsLimit", max(0, before.pids), max(0, after.pids), max(0, before.pids) != max(0, after.pids)},
	} {
		if change.changed {
			result.Changes[change.key] = updateChange{From: change.from, To: change.to}
		}
	}
	return result, nil
}

func workerPreflightFailure(err error) error {
	rejection := agentSubmitRejected(err).(*AgentError)
	return &seam.AgentContainerError{Code: rejection.Code, Message: rejection.Message, NotDispatched: true}
}

func updateUnconfirmed() error {
	return &seam.AgentContainerError{Code: "docker-container-update-unknown", Message: "容器更新结果未确认，请回读配置并核实原操作"}
}

func (s *dockerService) updateContainer(ctx context.Context, id string, patch map[string]any) (int, error) {
	body, err := json.Marshal(patch)
	if err != nil {
		return 0, err
	}
	status, value, err := s.engineJSON(ctx, http.MethodPost, "/containers/"+id+"/update", nil, body, actionTimeout)
	if err != nil || status != http.StatusOK {
		return 0, errors.New("Docker 未确认容器更新")
	}
	response, ok := asRecord(value)
	if !ok {
		return 0, errors.New("Docker 容器更新回执无效")
	}
	warnings, ok := asArray(agentField(response, "Warnings"))
	if !ok && agentField(response, "Warnings") != nil {
		return 0, errors.New("Docker 容器更新告警回执无效")
	}
	return len(warnings), nil
}

func intOrZero(value *int64) int64 {
	if value == nil {
		return 0
	}
	return *value
}

func readUpdateValues(value any) updateValues {
	row, _ := asRecord(value)
	host := agentRecord(row, "HostConfig")
	restart := agentRecord(host, "RestartPolicy")
	policy := agentText(restart, "Name")
	if policy == "" {
		policy = "no"
	}
	return updateValues{
		restart: policy, retries: intOrZero(agentInt(restart, "MaximumRetryCount")),
		memory: intOrZero(agentInt(host, "Memory")), nanoCPU: intOrZero(agentInt(host, "NanoCpus")),
		quota: intOrZero(agentInt(host, "CpuQuota")), period: intOrZero(agentInt(host, "CpuPeriod")), pids: intOrZero(agentInt(host, "PidsLimit")),
	}
}

func (v updateValues) cpuMillis() float64 {
	if v.nanoCPU > 0 {
		return float64(v.nanoCPU) / 1_000_000
	}
	if v.quota > 0 {
		return float64(v.quota) * 1000 / float64(v.cpuPeriod())
	}
	return 0
}

func (v updateValues) cpuPeriod() int64 {
	if v.period > 0 {
		return v.period
	}
	return 100_000
}

func planContainerUpdate(value any, input ContainerUpdateInput) (map[string]any, error) {
	row, _ := asRecord(value)
	host := agentRecord(row, "HostConfig")
	if host == nil {
		return nil, shared.InvalidRequest("容器资源配置无法核实")
	}
	if input.RestartPolicy == nil && input.RestartMaxRetries == nil && input.MemoryMiB == nil && input.CPUMillis == nil && input.PIDsLimit == nil {
		return nil, shared.InvalidRequest("至少提供一项容器配置")
	}
	current := readUpdateValues(value)
	labels := agentRecord(agentRecord(row, "Config"), "Labels")
	template := agentText(labels, "elysian.agent.template")
	patch := map[string]any{}

	if input.RestartPolicy != nil || input.RestartMaxRetries != nil {
		policy, retries := current.restart, current.retries
		if input.RestartPolicy != nil {
			policy = *input.RestartPolicy
		}
		switch policy {
		case "no", "always", "on-failure", "unless-stopped":
		default:
			return nil, shared.InvalidRequest("容器重启策略无效")
		}
		if policy != "on-failure" || current.restart != "on-failure" {
			retries = 0
		}
		if input.RestartMaxRetries != nil {
			if policy != "on-failure" || *input.RestartMaxRetries < 0 || *input.RestartMaxRetries > math.MaxInt32 {
				return nil, shared.InvalidRequest("重试次数仅适用于 on-failure，且须为非负整数")
			}
			retries = int64(*input.RestartMaxRetries)
		}
		if policy != "no" && (template == "restricted-v1" || agentField(host, "AutoRemove") == true) {
			return nil, shared.InvalidRequest("该容器仅支持 no 重启策略")
		}
		if policy != current.restart || retries != current.retries {
			patch["RestartPolicy"] = map[string]any{"Name": policy, "MaximumRetryCount": retries}
		}
	}
	if input.MemoryMiB != nil {
		memory := int64(*input.MemoryMiB)
		if memory < 0 || memory > math.MaxInt64/mib || memory > 0 && memory < 6 {
			return nil, shared.InvalidRequest("内存上限须为 0 或至少 6 MiB 的可表示整数")
		}
		memory *= mib
		if memory == 0 && current.memory > 0 {
			return nil, shared.InvalidRequest("Docker 原地更新无法解除已有内存上限")
		}
		if memory != current.memory {
			swap := intOrZero(agentInt(host, "MemorySwap"))
			reservation := intOrZero(agentInt(host, "MemoryReservation"))
			if swap > 0 && memory > swap || reservation > memory {
				return nil, shared.InvalidRequest("新内存上限与现有 swap 或保留内存配置冲突")
			}
			if template != "" && (current.memory <= 0 || memory > current.memory) {
				return nil, shared.InvalidRequest("Agent 模板只允许收紧内存上限")
			}
			patch["Memory"] = memory
		}
	}
	if input.CPUMillis != nil {
		cpu := int64(*input.CPUMillis)
		if cpu < 0 || cpu > math.MaxInt64/1_000_000 {
			return nil, shared.InvalidRequest("CPU 上限须为可表示的非负整数")
		}
		if cpu == 0 && current.cpuMillis() > 0 {
			return nil, shared.InvalidRequest("Docker 原地更新无法解除已有 CPU 上限")
		}
		if float64(cpu) != current.cpuMillis() {
			if template != "" && (current.cpuMillis() <= 0 || float64(cpu) > current.cpuMillis()) {
				return nil, shared.InvalidRequest("Agent 模板只允许收紧 CPU 上限")
			}
			if current.nanoCPU == 0 && (current.period > 0 || current.quota > 0) {
				period := current.cpuPeriod()
				if cpu > math.MaxInt64/period || cpu*period%1000 != 0 || cpu*period/1000 < 1000 {
					return nil, shared.InvalidRequest("当前 CPU 周期无法精确表示指定上限")
				}
				patch["CpuQuota"] = cpu * period / 1000
			} else {
				if cpu < 10 {
					return nil, shared.InvalidRequest("CPU 上限至少为 10 毫核")
				}
				patch["NanoCpus"] = cpu * 1_000_000
			}
		}
	}
	if input.PIDsLimit != nil {
		pids := int64(*input.PIDsLimit)
		if pids < 0 || pids > math.MaxInt32 {
			return nil, shared.InvalidRequest("PID 上限须为可表示的非负整数")
		}
		if pids != max(current.pids, 0) {
			if template != "" && (pids == 0 || current.pids <= 0 || pids > current.pids) {
				return nil, shared.InvalidRequest("Agent 模板只允许收紧 PID 上限")
			}
			if pids == 0 {
				pids = -1
			}
			patch["PidsLimit"] = pids
		}
	}
	return patch, nil
}
