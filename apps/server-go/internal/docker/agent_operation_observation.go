package docker

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"time"

	"elysian/server/internal/config"
	"elysian/server/internal/seam"
)

// Keep the original unknown receipt intact. This separate observation proves
// only exec termination/exit status, never reconstructs missing stdout or SQL.
type ContainerOperationObservation struct {
	TaskID          string `json:"taskId"`
	RequestID       string `json:"requestId"`
	Target          string `json:"target"`
	Digest          string `json:"digest"`
	ExecID          string `json:"execId"`
	ExitCode        int    `json:"exitCode"`
	ObservedAt      string `json:"observedAt"`
	OutputRecovered bool   `json:"outputRecovered"`
}

func validContainerObservation(t ContainerOperationTask) bool {
	o := t.Observation
	return o != nil && t.State == "unknown" && t.ExecObservedRunning && t.ExecID != "" && o.ExecID == t.ExecID && o.TaskID == t.ID && o.RequestID == t.RequestID && o.Target == t.Target && o.Digest == t.Digest && o.ExitCode >= 0 && o.ExitCode <= 255 && o.ObservedAt != "" && !o.OutputRecovered
}

func containerOperationBlocks(t ContainerOperationTask) bool {
	return (t.State == "running" || t.State == "unknown") && t.Resolution == nil && !(validContainerObservation(t) && t.Observation.ExitCode == 0)
}

func (a *AgentFacade) ObserveContainerOperation(ctx context.Context, id string) (ContainerOperationTask, error) {
	task, err := a.InspectContainerOperation(ctx, id)
	if err != nil {
		return task, err
	}
	if task.State != "unknown" || task.ExecID == "" || task.Observation != nil || task.Resolution != nil || a.service == nil {
		return task, nil
	}
	a.operationMu.Lock()
	active := a.operationCancel[id] != nil
	a.operationMu.Unlock()
	if active {
		return task, nil
	}
	response, err := a.service.deps.transport.Request(ctx, seam.EngineRequest{Method: http.MethodGet, Path: "/exec/" + task.ExecID + "/json", MaxBytes: 64 << 10})
	if err != nil {
		return task, err
	}
	var state struct {
		Running     *bool
		ContainerID string
		ExitCode    *int
	}
	if response.Status != http.StatusOK || json.Unmarshal(response.Body, &state) != nil || state.Running == nil || state.ContainerID != task.Target {
		return task, nil
	}
	// An unstarted exec can also report Running=false, ExitCode=0. Require
	// a durable observation of Running=true before confirming a later exit.
	if !*state.Running && (!task.ExecObservedRunning || state.ExitCode == nil || *state.ExitCode < 0 || *state.ExitCode > 255) {
		return task, nil
	}
	a.operationMu.Lock()
	defer a.operationMu.Unlock()
	current, ok := a.operations[id]
	if !ok || current.State != "unknown" || current.Resolution != nil || current.Observation != nil || a.operationCancel[id] != nil || current.Digest != task.Digest || current.Target != task.Target || current.ExecID != task.ExecID {
		return current, nil
	}
	if *state.Running {
		if current.ExecObservedRunning {
			return current, nil
		}
		current.ExecObservedRunning = true
		if err := config.AtomicJSON(filepath.Join(a.operationRoot, id+".json"), &current); err != nil {
			return task, err
		}
		a.operations[id] = current
		return current, nil
	}
	current.Observation = &ContainerOperationObservation{TaskID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest, ExecID: task.ExecID, ExitCode: *state.ExitCode, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := config.AtomicJSON(filepath.Join(a.operationRoot, id+".json"), &current); err != nil {
		return task, err
	}
	a.operations[id] = current
	return current, nil
}
