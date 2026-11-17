package harness

import (
	"context"
	"encoding/json"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/jsonvalue"
)

// A domain request ID identifies one canonical operation, including its target
// and parameters. A sealed operation cannot be used as a fresh attempt merely
// to preserve a model cache prefix.
func validateOperationIdentity(ctx context.Context, q reportReader, operation Operation) error {
	metadata := operation.Capability.Metadata
	if !metadata.Async || metadata.TaskDomain == "" || metadata.TaskRequestArgument == "" {
		return nil
	}
	args, err := jsonvalue.Object([]byte(operation.ArgumentsJSON))
	if err != nil {
		return err
	}
	requestID := taskArgument(args, metadata.TaskRequestArgument)
	if requestID == "" {
		return nil
	}
	previous, err := readView(ctx, q).PriorOperationAttempts(ctx, operation.ID, metadata.TaskDomain)
	if err != nil {
		return err
	}
	for _, old := range previous {
		oldArgs, err := jsonvalue.Object([]byte(old.ArgumentsJSON))
		if err != nil {
			return err
		}
		if taskArgument(oldArgs, old.Capability.Metadata.TaskRequestArgument) != requestID {
			continue
		}
		canonical, err := jsonvalue.Canonical(json.RawMessage(operation.ArgumentsJSON))
		if err != nil {
			return err
		}
		original, err := jsonvalue.Canonical(json.RawMessage(old.ArgumentsJSON))
		if err != nil {
			return err
		}
		if old.Capability.Name != operation.Capability.Name || string(canonical) != string(original) {
			return &Error{Status: 409, Code: "request-id-conflict", Message: "该 requestId 已绑定另一组操作参数或目标；修改参数必须使用新的 requestId，原操作只允许按原身份核实"}
		}
		return &Error{Status: 409, Code: "request-id-reused", Message: "该 requestId 已有持久操作记录；原提交重试或核实须沿用原操作，封存后发起新的尝试必须使用新的 requestId"}
	}
	return nil
}

func (a *agentExecution) validateOperationBatch(ctx context.Context, calls []model.ToolCall) error {
	seen := map[string]bool{}
	return storeReadError(ctx, a.manager.store, "operation-identities", func(ctx context.Context) error {
		for _, call := range calls {
			capability, ok := a.capability(call.Name)
			if !ok || !capability.Metadata.Async {
				continue
			}
			args, err := jsonvalue.Object(call.Arguments)
			if err != nil {
				return err
			}
			id := taskArgument(args, capability.Metadata.TaskRequestArgument)
			if id != "" && capability.Metadata.TaskDomain != "" {
				key := capability.Metadata.TaskDomain + ":" + id
				if seen[key] {
					return bad("request-id-conflict", "同批操作重复使用了同一域 requestId；本批均未执行，请为不同操作使用独立身份")
				}
				seen[key] = true
			}
			if err = validateOperationIdentity(ctx, a.manager.store, Operation{Capability: capability, ArgumentsJSON: string(call.Arguments)}); err != nil {
				return err
			}
		}
		return nil
	})
}
