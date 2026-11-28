package docker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"elysian/server/internal/seam"
	"elysian/server/internal/shared"
)

func (a *AgentFacade) executeContainerCommand(ctx context.Context, taskID string, input ContainerExecInput, scope agentScope) (any, error) {
	// 派发前按同一冻结范围复查目标：受理与执行之间容器可能被替换。
	var value any
	if scope == scopeHost {
		var err error
		value, err = a.inspectHostTarget(ctx, input.ID)
		if err != nil {
			return nil, workerPreflightFailure(err)
		}
		if _, err := a.operableTargetInspect(value); err != nil {
			return nil, workerPreflightFailure(err)
		}
	} else if _, err := a.safeTarget(ctx, input.ID); err != nil {
		return nil, err
	}
	body, _ := json.Marshal(map[string]any{"AttachStdin": false, "AttachStdout": true, "AttachStderr": true, "Tty": false, "Privileged": false, "Cmd": input.Argv, "WorkingDir": input.Workdir})
	response, err := a.service.deps.transport.Request(ctx, seam.EngineRequest{Method: http.MethodPost, Path: "/containers/" + input.ID + "/exec", Body: body, Timeout: 15 * time.Second, MaxBytes: 64 << 10})
	if err != nil {
		return nil, err
	}
	var created struct {
		ID string `json:"Id"`
	}
	if response.Status != http.StatusCreated || json.Unmarshal(response.Body, &created) != nil || !agentOperationIDPattern.MatchString(created.ID) {
		return nil, errors.New("创建容器执行失败")
	}
	if err := a.updateContainerOperation(taskID, func(task *ContainerOperationTask) { task.ExecID = created.ID; task.Stage = "exec-created" }); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := a.updateContainerOperation(taskID, func(task *ContainerOperationTask) { task.Stage = "exec-start-dispatched" }); err != nil {
		return nil, err
	}
	output := shared.NewExecOutput(65 << 10)
	response, err = a.service.deps.transport.Stream(ctx, seam.EngineRequest{Method: http.MethodPost, Path: "/exec/" + created.ID + "/start", Body: []byte(`{"Detach":false,"Tty":false}`), Timeout: 10 * time.Minute, DiscardBody: true}, output.Consume)
	if err != nil || response.Status != http.StatusOK || output.Invalid() || output.Incomplete() {
		return nil, errors.New("容器执行流未完整确认")
	}
	response, err = a.service.deps.transport.Request(ctx, seam.EngineRequest{Method: http.MethodGet, Path: "/exec/" + created.ID + "/json", Timeout: 5 * time.Second, MaxBytes: 64 << 10})
	if err != nil {
		return nil, err
	}
	var status struct {
		Running     *bool  `json:"Running"`
		ExitCode    *int   `json:"ExitCode"`
		ContainerID string `json:"ContainerID"`
	}
	if response.Status != http.StatusOK || json.Unmarshal(response.Body, &status) != nil || status.Running == nil || *status.Running || status.ExitCode == nil || status.ContainerID != input.ID {
		return nil, errors.New("容器执行退出状态未确认")
	}
	stdout, stderr := string(output.Stdout()), string(output.Stderr())
	truncated := output.Truncated()
	if a.credentials != nil {
		records, err := a.credentials.load()
		if err != nil {
			return nil, err
		}
		for _, record := range records {
			if record.ContainerID == input.ID {
				for _, secret := range record.Credentials {
					if secret != "" {
						stdout = strings.ReplaceAll(stdout, secret, "[REDACTED]")
						stderr = strings.ReplaceAll(stderr, secret, "[REDACTED]")
					}
				}
			}
		}
	}
	if len(stdout) > 64<<10 {
		stdout = stdout[:64<<10]
		stderr = ""
		truncated = true
	} else if len(stdout)+len(stderr) > 64<<10 {
		stderr = stderr[:(64<<10)-len(stdout)]
		truncated = true
	}
	result := map[string]any{"id": input.ID, "exitCode": *status.ExitCode, "stdout": stdout, "stderr": stderr, "truncated": truncated}
	if scope == scopeHost {
		notes := describeAgentTarget(value, a.service.deps.selfContainerID)
		result["ownership"], result["exposure"] = notes.Ownership, notes.Exposure
	}
	return result, nil
}
