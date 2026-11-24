package app

import (
	"context"
	"encoding/json"
	"errors"

	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/tools"
	tooldocker "elysian/server/internal/agent/tools/docker"
	"elysian/server/internal/docker"
)

func agentTaskVerifier(containers *docker.AgentFacade) func(context.Context, tools.TaskVerification) (tools.TaskReference, error) {
	return func(ctx context.Context, v tools.TaskVerification) (tools.TaskReference, error) {
		if v.OperationID == "" || v.DispatchID == "" || v.Task.Domain != docker.ContainerOperationDomain || v.Task.RequestID == "" || v.Task.ID != "" {
			return v.Task, errors.New("缺少可核实的原始提交身份")
		}
		input, target, err := containerOperationInputVersion(v.Tool, v.ToolVersion, v.ArgumentsJSON, v.Task.RequestID)
		if err != nil {
			return v.Task, err
		}
		task, err := containers.SealUnacceptedOperation(ctx, v.Task.RequestID, target, input)
		if err != nil {
			return v.Task, err
		}
		return tools.TaskReference{Domain: v.Task.Domain, ID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest}, nil
	}
}

// Keep the original JSON field order and omission rules for accepted exec v2
// receipts. An exec v3 or a v2 argv call marshals to the same bytes as before.
type execReceiptInput struct {
	docker.ContainerExecInput
	DatabaseChange *struct {
		Action           string `json:"action"`
		Name             string `json:"name"`
		ExpectedRevision string `json:"expectedRevision"`
		Charset          string `json:"charset,omitempty"`
	} `json:"databaseChange,omitempty"`
}

func containerOperationInput(tool, raw, requestID string) (any, string, error) {
	return containerOperationInputVersion(tool, "", raw, requestID)
}

func containerOperationInputVersion(tool, version, raw, requestID string) (any, string, error) {
	switch tool {
	case "docker_container_exec":
		var input execReceiptInput
		if err := decodeContainerArguments(raw, &input); err != nil {
			return nil, "", err
		}
		if input.RequestID == requestID {
			if version == "4" {
				return docker.ScopedContainerOperationInput("exec/v4", input.ContainerExecInput), input.ID, nil
			}
			return input, input.ID, nil
		}
	case "docker_container_update":
		if version != "1" {
			break
		}
		args, err := jsonvalue.Object([]byte(raw))
		if err != nil {
			return nil, "", err
		}
		input, err := tooldocker.DecodeContainerUpdate(args)
		if err != nil {
			return nil, "", err
		}
		if input.RequestID == requestID {
			return docker.ScopedContainerOperationInput("update/v1", input), input.ID, nil
		}
	case "docker_container_create_service":
		var input docker.AgentServiceCreateInput
		if err := decodeContainerArguments(raw, &input); err != nil {
			return nil, "", err
		}
		if input.RequestID == requestID {
			return input, "name:" + input.Name, nil
		}
	default:
		return nil, "", errors.New("该工具没有经过审核的容器操作核实契约")
	}
	return nil, "", errors.New("容器操作原始请求身份不匹配")
}

// Match the tool's lossless integer interpretation, including 3306.0 and 3e3.
func decodeContainerArguments(raw string, target any) error {
	args, err := jsonvalue.Object([]byte(raw))
	if err != nil {
		return err
	}
	for _, key := range []string{"port", "hostPort"} {
		if _, exists := args[key]; exists {
			n, ok := tools.IntArg(args, key)
			if !ok {
				return errors.New("端口必须是可表示的整数")
			}
			args[key] = n
		}
	}
	value, err := json.Marshal(args)
	if err != nil {
		return err
	}
	return json.Unmarshal(value, target)
}
