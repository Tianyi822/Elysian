package harness

import (
	"context"
	"encoding/json"

	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/tools"
)

const StateWaitingApproval = "waiting-approval"
const StateWaitingResource = "waiting-resource"
const StateWaitingTask = "waiting-task"
const StateWaitingRecovery = "waiting-recovery"

type CapabilityResult struct {
	Task          *tools.TaskReference
	Value         json.RawMessage
	BusinessError *Failure
	Unknown       bool
	Context       *ContextItem
	Workspace     *workspace.Version
}

type operationPreparer interface {
	Prepare(context.Context, CapabilitySnapshot, Operation) (Operation, error)
}

type operationDispatchChecker interface {
	DispatchCheck(context.Context, CapabilitySnapshot, Operation) error
}

type operationScopeCloser interface {
	CloseOperation(context.Context, Operation) error
}

// Catalog 固定可用契约并执行派发前撤销检查；所有副作用始终在父进程。
type CapabilityCatalog interface {
	Snapshot(context.Context, Environment) (CapabilitySnapshot, error)
	Validate(Capability, json.RawMessage) error
	Check(context.Context, CapabilitySnapshot, Operation) error
	Execute(context.Context, CapabilitySnapshot, Operation) (CapabilityResult, error)
}
