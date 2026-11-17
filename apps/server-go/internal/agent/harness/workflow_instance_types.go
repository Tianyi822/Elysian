package harness

const StateRecoveryRequired = "recovery-required"
const StateReady = "ready"

func DefaultWorkflowLimits() WorkflowLimits {
	return WorkflowLimits{ActiveMilliseconds: 3600000, ModelRequests: 64, Calls: 64, Tokens: 256000, ResultBytes: 8388608, Attempts: 3}
}
