package harness

import "elysian/server/internal/agent/harness/model"

const StateRecoveryRequired = "recovery-required"
const StateReady = "ready"

type WorkflowLimits struct {
	ActiveMilliseconds int64 `json:"activeMilliseconds"`
	ModelRequests      int   `json:"modelRequests"`
	Calls              int   `json:"calls"`
	Tokens             int   `json:"tokens"`
	ResultBytes        int   `json:"resultBytes"`
	Attempts           int   `json:"attempts"`
}

func DefaultWorkflowLimits() WorkflowLimits {
	return WorkflowLimits{3600000, 64, 64, 256000, 8388608, 3}
}

type WorkflowUsage struct {
	ActiveMilliseconds   int64 `json:"activeMilliseconds"`
	ReservedMilliseconds int64 `json:"reservedMilliseconds"`
	ModelRequests        int   `json:"modelRequests"`
	Calls                int   `json:"calls"`
	Tokens               int   `json:"tokens"`
	ResultBytes          int   `json:"resultBytes"`
}
type WorkflowInstance struct {
	GateClosed         bool                   `json:"gateClosed,omitempty"`
	Definitions        []WorkflowDefinition   `json:"definitions,omitempty"`
	LanguageVersion    string                 `json:"languageVersion,omitempty"`
	RootScopeID        string                 `json:"rootScopeId,omitempty"`
	ID                 string                 `json:"id"`
	RequestID          string                 `json:"requestId"`
	DefinitionID       string                 `json:"definitionId"`
	DefinitionRevision int                    `json:"definitionRevision"`
	SourceSessionID    string                 `json:"sourceSessionId"`
	SessionID          string                 `json:"sessionId"`
	TaskID             string                 `json:"taskId"`
	Revision           int                    `json:"revision"`
	Status             string                 `json:"status"`
	CurrentStepID      string                 `json:"currentStepId"`
	ActiveRunID        string                 `json:"activeRunId,omitempty"`
	InputJSON          string                 `json:"inputJson"`
	OutputJSON         string                 `json:"outputJson,omitempty"`
	Model              model.Profile          `json:"model"`
	Snapshot           CapabilitySnapshot     `json:"snapshot"`
	CreatedAt          string                 `json:"createdAt"`
	UpdatedAt          string                 `json:"updatedAt"`
	ReadyAt            string                 `json:"readyAt,omitempty"`
	EndedAt            string                 `json:"endedAt,omitempty"`
	CancelRequestedAt  string                 `json:"cancelRequestedAt,omitempty"`
	Error              *Failure               `json:"error,omitempty"`
	Limits             WorkflowLimits         `json:"limits"`
	Usage              WorkflowUsage          `json:"usage"`
	LastSeq            string                 `json:"lastSeq"`
	AllowedActions     []string               `json:"allowedActions"`
	ExecutionTree      *WorkflowExecutionTree `json:"executionTree,omitempty"`
}
type WorkflowAttempt struct {
	WorkflowID        string `json:"workflowId"`
	StepID            string `json:"stepId"`
	Number            int    `json:"number"`
	RunID             string `json:"runId"`
	RunNumber         int    `json:"runNumber"`
	Status            string `json:"status"`
	InputJSON         string `json:"inputJson"`
	OutputJSON        string `json:"outputJson,omitempty"`
	OutputCallID      string `json:"outputCallId,omitempty"`
	OutputRequestID   string `json:"outputRequestId,omitempty"`
	CompletionSource  string `json:"completionSource,omitempty"`
	Evidence          string `json:"evidence,omitempty"`
	EventSeq          string `json:"eventSeq,omitempty"`
	WorkspaceRevision int    `json:"workspaceRevision"`
	CreatedAt         string `json:"createdAt"`
	EndedAt           string `json:"endedAt,omitempty"`
	ScopeID           string `json:"scopeId,omitempty"`
	NodeID            string `json:"nodeId,omitempty"`
	Iteration         int    `json:"iteration,omitempty"`
	ExpectedRevision  int    `json:"expectedRevision,omitempty"`
}
type WorkflowEvent struct {
	WorkflowID string `json:"workflowId"`
	Seq        string `json:"seq"`
	Type       string `json:"type"`
	StepID     string `json:"stepId,omitempty"`
	RunID      string `json:"runId,omitempty"`
	At         string `json:"at"`
	Detail     string `json:"detail,omitempty"`
}
type CreateWorkflowInput struct {
	RequestID          string `json:"requestId"`
	DefinitionID       string `json:"definitionId"`
	DefinitionRevision int    `json:"definitionRevision"`
	SourceSessionID    string `json:"sourceSessionId"`
	InputJSON          string `json:"inputJson"`
}
type WorkflowRecoveryInput struct {
	NodeID           string `json:"nodeId,omitempty"`
	RequestID        string `json:"requestId"`
	ExpectedRevision int    `json:"expectedRevision"`
	Action           string `json:"action"`
	Evidence         string `json:"evidence,omitempty"`
	OutputJSON       string `json:"outputJson,omitempty"`
}
