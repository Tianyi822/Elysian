package docker

import (
	"context"
	"encoding/json"
	"net/http"

	"elysian/server/internal/config"
	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
	"path/filepath"
)

func validContainerResolution(r ContainerOperationResolution, task ContainerOperationTask) bool {
	return r.ID != "" && r.TaskID == task.ID && r.RequestID == task.RequestID && r.Target == task.Target && r.Digest == task.Digest && r.Digest != "" && len(r.Evidence) > 0 && len(r.Evidence) <= 8192 && (r.Decision == "confirmed-completed" || r.Decision == "confirmed-stopped")
}

// ReconcileContainerOperation records evidence; it never executes the original request.
func (a *AgentFacade) ReconcileContainerOperation(ctx context.Context, resolution ContainerOperationResolution) error {
	task, err := a.InspectContainerOperation(ctx, resolution.TaskID)
	if err != nil {
		return err
	}
	if !validContainerResolution(resolution, task) {
		return shared.InvalidRequest("容器操作核实身份或证据不匹配")
	}
	if task.Resolution != nil {
		if *task.Resolution == resolution {
			return nil
		}
		return shared.InvalidRequest("容器操作已有不同核实决定")
	}
	if task.ExecID != "" {
		// Context cancellation and a stopped local worker do not prove that Docker exec exited.
		if a.service == nil {
			return shared.InvalidRequest("无法核实容器命令是否已结束")
		}
		response, err := a.service.deps.transport.Request(ctx, seam.EngineRequest{Method: http.MethodGet, Path: "/exec/" + task.ExecID + "/json", MaxBytes: 64 << 10})
		if err != nil {
			return err
		}
		var state struct {
			Running     *bool
			ContainerID string
		}
		if response.Status != http.StatusOK || json.Unmarshal(response.Body, &state) != nil || state.Running == nil || *state.Running || state.ContainerID != task.Target {
			return shared.InvalidRequest("容器命令仍在运行或身份无法确认")
		}
	}
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	current, ok := a.operations[task.ID]
	if !ok || !validContainerResolution(resolution, current) {
		return shared.InvalidRequest("容器操作核实期间身份已变化")
	}
	if current.Resolution != nil {
		if *current.Resolution == resolution {
			return nil
		}
		return shared.InvalidRequest("容器操作已有不同核实决定")
	}
	if current.State != "unknown" && current.State != "succeeded" && current.State != "failed" || a.operationCancel[current.ID] != nil {
		return shared.InvalidRequest("只能核实执行已停止的容器操作")
	}
	current.Resolution = &resolution
	if err := config.AtomicJSON(filepath.Join(a.operationRoot, current.ID+".json"), current); err != nil {
		return err
	}
	a.operations[current.ID] = current
	return nil
}
