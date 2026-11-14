package app

import (
	"context"
	"encoding/json"
	"errors"

	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/tools"
	"elysian/server/internal/docker"
)

func agentTaskVerifier(containers *docker.AgentFacade) func(context.Context, tools.TaskVerification) (tools.TaskReference, error) {
	return func(ctx context.Context, v tools.TaskVerification) (tools.TaskReference, error) {
		if v.OperationID == "" || v.DispatchID == "" || v.Task.Domain != docker.ContainerOperationDomain || v.Task.RequestID == "" || v.Task.ID != "" {
			return v.Task, errors.New("缺少可核实的原始提交身份")
		}
		var task docker.ContainerOperationTask
		var err error
		switch v.Tool {
		case "docker_container_create_service":
			var input docker.AgentServiceCreateInput
			if decodeContainerArguments(v.ArgumentsJSON, &input) != nil || input.RequestID != v.Task.RequestID {
				return v.Task, errors.New("核实参数身份不匹配")
			}
			task, err = containers.SealUnacceptedOperation(ctx, input.RequestID, "name:"+input.Name, input)
		case "docker_container_exec":
			var input docker.ContainerExecInput
			if decodeContainerArguments(v.ArgumentsJSON, &input) != nil || input.RequestID != v.Task.RequestID {
				return v.Task, errors.New("核实参数身份不匹配")
			}
			task, err = containers.SealUnacceptedOperation(ctx, input.RequestID, input.ID, input)
		default:
			return v.Task, errors.New("该工具没有经过审核的未受理核实契约")
		}
		if err != nil {
			return v.Task, err
		}
		return tools.TaskReference{Domain: v.Task.Domain, ID: task.ID, RequestID: task.RequestID, Target: task.Target, Digest: task.Digest}, nil
	}
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
