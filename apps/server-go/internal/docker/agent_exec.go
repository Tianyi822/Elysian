package docker

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"elysian/server/internal/seam"
)

// execOutput decodes Docker's non-TTY multiplexed stream without retaining an
// unbounded frame. Truncated output is still drained until execution ends.
type execOutput struct {
	header             []byte
	remaining          uint32
	stream             byte
	stdout, stderr     []byte
	truncated, invalid bool
}

func (o *execOutput) consume(chunk []byte) {
	if o.invalid {
		return
	}
	for len(chunk) > 0 {
		if o.remaining == 0 {
			n := 8 - len(o.header)
			if n > len(chunk) {
				n = len(chunk)
			}
			o.header = append(o.header, chunk[:n]...)
			chunk = chunk[n:]
			if len(o.header) < 8 {
				return
			}
			o.stream = o.header[0]
			if (o.stream != 1 && o.stream != 2) || o.header[1] != 0 || o.header[2] != 0 || o.header[3] != 0 {
				o.invalid = true
				return
			}
			o.remaining = binary.BigEndian.Uint32(o.header[4:])
			o.header = nil
			if o.remaining == 0 {
				continue
			}
		}
		n := len(chunk)
		if uint32(n) > o.remaining {
			n = int(o.remaining)
		}
		keep := n
		room := (65 << 10) - len(o.stdout) - len(o.stderr)
		if keep > room {
			keep = room
			o.truncated = true
		}
		if o.stream == 1 {
			o.stdout = append(o.stdout, chunk[:keep]...)
		} else {
			o.stderr = append(o.stderr, chunk[:keep]...)
		}
		o.remaining -= uint32(n)
		chunk = chunk[n:]
	}
}

func (a *AgentFacade) executeContainerCommand(ctx context.Context, taskID string, input ContainerExecInput) (any, error) {
	if _, err := a.safeTarget(ctx, input.ID); err != nil {
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
	output := &execOutput{}
	response, err = a.service.deps.transport.Stream(ctx, seam.EngineRequest{Method: http.MethodPost, Path: "/exec/" + created.ID + "/start", Body: []byte(`{"Detach":false,"Tty":false}`), Timeout: 10 * time.Minute, DiscardBody: true}, output.consume)
	if err != nil || response.Status != http.StatusOK || output.invalid || output.remaining != 0 || len(output.header) != 0 {
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
	stdout, stderr := string(output.stdout), string(output.stderr)
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
		output.truncated = true
	} else if len(stdout)+len(stderr) > 64<<10 {
		stderr = stderr[:(64<<10)-len(stdout)]
		output.truncated = true
	}
	return map[string]any{"id": input.ID, "exitCode": *status.ExitCode, "stdout": stdout, "stderr": stderr, "truncated": output.truncated}, nil
}
