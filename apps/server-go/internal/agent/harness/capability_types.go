package harness

import (
	"context"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/workspace"
	"encoding/json"
)

const StateWaitingApproval = "waiting-approval"
const StateWaitingResource = "waiting-resource"

type RevisionRef struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
	Digest   string `json:"digest,omitempty"`
}
type ResourceRef struct {
	ServerID string `json:"serverId"`
	URI      string `json:"uri"`
}
type PromptRef struct {
	ServerID  string          `json:"serverId"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}
type Environment struct {
	SessionID         string        `json:"sessionId"`
	Revision          int           `json:"revision"`
	Skills            []RevisionRef `json:"skills"`
	Servers           []RevisionRef `json:"servers"`
	Tools             []string      `json:"tools"`
	Resources         []ResourceRef `json:"resources"`
	ExecutionProfiles []RevisionRef `json:"executionProfiles"`
	Grants            []RevisionRef `json:"grants"`
	TrustedReadOnly   []string      `json:"trustedReadOnly"`
	ResourceRules     []RevisionRef `json:"resourceRules,omitempty"`
}
type Capability struct {
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Parameters    json.RawMessage `json:"parameters"`
	Source        string          `json:"source"`
	Ref           RevisionRef     `json:"ref"`
	OriginalName  string          `json:"originalName,omitempty"`
	CatalogDigest string          `json:"catalogDigest,omitempty"`
	OutputSchema  json.RawMessage `json:"outputSchema,omitempty"`
	ReadOnly      bool            `json:"readOnly"`
}
type CapabilitySnapshot struct {
	Environment    Environment          `json:"environment"`
	Tools          []Capability         `json:"tools"`
	Materials      []Capability         `json:"materials,omitempty"`
	SkillSummaries []SkillSummary       `json:"skillSummaries,omitempty"`
	Profiles       []execconfig.Profile `json:"executionProfiles,omitempty"`
	Grants         []execconfig.Grant   `json:"grants,omitempty"`
	ResourceRules  []ResourceRule       `json:"resourceRules,omitempty"`
	Digest         string               `json:"digest"`
}
type SkillSummary struct {
	Ref         RevisionRef `json:"ref"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
}
type ExecutionPlan struct {
	Profile      execconfig.Profile `json:"profile"`
	Grant        *execconfig.Grant  `json:"grant,omitempty"`
	ScriptDigest string             `json:"scriptDigest"`
}
type RecoveryCursor struct {
	ResponseID string `json:"responseId"`
	CallIndex  int    `json:"callIndex"`
}
type Operation struct {
	ScopeID         string `json:"scopeId,omitempty"`
	NodeID          string `json:"nodeId,omitempty"`
	Source          string `json:"source,omitempty"`
	WorkflowID      string `json:"workflowId,omitempty"`
	WorkflowStepID  string `json:"workflowStepId,omitempty"`
	WorkflowAttempt int    `json:"workflowAttempt,omitempty"`

	ID                string          `json:"id"`
	RunID             string          `json:"runId"`
	TaskID            string          `json:"taskId"`
	ModelRequestID    string          `json:"modelRequestId"`
	CallIndex         int             `json:"callIndex"`
	ModelCallID       string          `json:"modelCallId"`
	ArgumentsJSON     string          `json:"argumentsJson"`
	Capability        Capability      `json:"capability"`
	SnapshotDigest    string          `json:"snapshotDigest"`
	WorkspaceRevision int             `json:"workspaceRevision"`
	Execution         *ExecutionPlan  `json:"execution,omitempty"`
	ResourceClaims    []ResourceClaim `json:"resourceClaims,omitempty"`
	ResourceRules     []RevisionRef   `json:"resourceRules,omitempty"`
	ClaimsDigest      string          `json:"claimsDigest,omitempty"`
	Policy            string          `json:"policy"`
	Status            string          `json:"status"`
	ApprovalID        string          `json:"approvalId,omitempty"`
	CallID            string          `json:"callId"`
	DispatchID        string          `json:"dispatchId,omitempty"`
	CreatedAt         string          `json:"createdAt"`
	DispatchedAt      string          `json:"dispatchedAt,omitempty"`
	EndedAt           string          `json:"endedAt,omitempty"`
	Error             *Failure        `json:"error,omitempty"`
}
type Approval struct {
	ScopeID         string `json:"scopeId,omitempty"`
	NodeID          string `json:"nodeId,omitempty"`
	Kind            string `json:"kind,omitempty"`
	WorkflowID      string `json:"workflowId,omitempty"`
	WorkflowStepID  string `json:"workflowStepId,omitempty"`
	WorkflowAttempt int    `json:"workflowAttempt,omitempty"`
	ContentDigest   string `json:"contentDigest,omitempty"`
	Instruction     string `json:"instruction,omitempty"`
	InputJSON       string `json:"inputJson,omitempty"`

	ID          string    `json:"id"`
	RunID       string    `json:"runId"`
	OperationID string    `json:"operationId"`
	Status      string    `json:"status"`
	CreatedAt   string    `json:"createdAt"`
	ExpiresAt   string    `json:"expiresAt"`
	DecidedAt   string    `json:"decidedAt,omitempty"`
	Decision    string    `json:"decision,omitempty"`
	Operation   Operation `json:"operation"`
}
type ExecutionBarrier struct {
	ScopeID      string `json:"scopeId,omitempty"`
	NodeID       string `json:"nodeId,omitempty"`
	WorkflowID   string `json:"workflowId,omitempty"`
	ID           string `json:"id"`
	RunID        string `json:"runId"`
	OperationID  string `json:"operationId"`
	Status       string `json:"status"`
	CreatedAt    string `json:"createdAt"`
	Evidence     string `json:"evidence,omitempty"`
	Decision     string `json:"decision,omitempty"`
	ReconciledAt string `json:"reconciledAt,omitempty"`
}
type ContextItem struct {
	ID        string      `json:"id"`
	RunID     string      `json:"runId"`
	TaskID    string      `json:"taskId"`
	Source    string      `json:"source"`
	Ref       RevisionRef `json:"ref"`
	Path      string      `json:"path,omitempty"`
	Digest    string      `json:"digest"`
	Content   string      `json:"content"`
	CreatedAt string      `json:"createdAt"`
	EventSeq  string      `json:"eventSeq"`
	CallID    string      `json:"callId,omitempty"`
}
type CapabilityResult struct {
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

func (s CapabilitySnapshot) modelTools() []model.Tool {
	out := make([]model.Tool, 0, len(s.Tools))
	for _, c := range s.Tools {
		out = append(out, model.Tool{Name: c.Name, Description: c.Description, Parameters: c.Parameters})
	}
	return out
}
