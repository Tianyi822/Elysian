package state

import (
	"bytes"
	"encoding/json"
	"io"

	"elysian/server/internal/agent/harness/model"
)

// WorkflowDefinition 是已接受工作流所固定的不可变模板修订。
type WorkflowDefinition struct {
	// LanguageVersion fixes the execution language for every instance. Empty is
	// retained as v1 for backwards compatibility with schema4 documents.
	LanguageVersion  string                   `json:"languageVersion,omitempty"`
	ID               string                   `json:"id"`
	Revision         int                      `json:"revision"`
	Name             string                   `json:"name"`
	Enabled          bool                     `json:"enabled"`
	Goal             string                   `json:"goal"`
	InputSchemaJSON  string                   `json:"inputSchemaJson"`
	OutputSchemaJSON string                   `json:"outputSchemaJson"`
	Entry            string                   `json:"entry"`
	Steps            []WorkflowStepDefinition `json:"steps"`
	CreatedAt        string                   `json:"createdAt"`
}

type WorkflowStepDefinition struct {
	ID               string               `json:"id"`
	Kind             string               `json:"kind"`
	Instruction      string               `json:"instruction,omitempty"`
	Capability       string               `json:"capability,omitempty"`
	Input            WorkflowBinding      `json:"input"`
	OutputSchemaJSON string               `json:"outputSchemaJson"`
	Next             string               `json:"next,omitempty"`
	Condition        *WorkflowCondition   `json:"condition,omitempty"`
	Then             string               `json:"then,omitempty"`
	Else             string               `json:"else,omitempty"`
	Finish           *WorkflowBinding     `json:"finish,omitempty"`
	Selection        *AgentInput          `json:"selection,omitempty"`
	Parallel         *WorkflowParallel    `json:"parallel,omitempty"`
	Foreach          *WorkflowForeach     `json:"foreach,omitempty"`
	Subworkflow      *WorkflowSubworkflow `json:"subworkflow,omitempty"`
}

type WorkflowSubworkflow struct {
	DefinitionID       string `json:"definitionId"`
	DefinitionRevision int    `json:"definitionRevision"`
}

// WorkflowBinding 严格五选一；JSON 原文保留超出 JavaScript 安全整数的值。
// Object 与 Array 非 nil 即代表相应绑定，允许构造空对象与空数组。
type WorkflowBinding struct {
	LiteralJSON *string                    `json:"literalJson,omitempty"`
	Input       *string                    `json:"input,omitempty"`
	Step        *WorkflowOutputBinding     `json:"step,omitempty"`
	Object      map[string]WorkflowBinding `json:"object,omitempty"`
	Array       []WorkflowBinding          `json:"array,omitempty"`
}

// omitempty 不能区分缺失与空容器，显式保留 object:{} 与 array:[]。
func (b WorkflowBinding) MarshalJSON() ([]byte, error) {
	v := map[string]any{}
	if b.LiteralJSON != nil {
		v["literalJson"] = *b.LiteralJSON
	}
	if b.Input != nil {
		v["input"] = *b.Input
	}
	if b.Step != nil {
		v["step"] = b.Step
	}
	if b.Object != nil {
		v["object"] = b.Object
	}
	if b.Array != nil {
		v["array"] = b.Array
	}
	return json.Marshal(v)
}

// 明确拒绝 null 与多个值来源，避免解码时把它们悄悄当作缺省字段。
func (b *WorkflowBinding) UnmarshalJSON(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') || !decoder.More() {
		return WorkflowBindingError("工作流绑定必须是只含一个值来源的对象")
	}
	if _, err = decoder.Token(); err != nil {
		return WorkflowBindingError("工作流绑定字段名无效")
	}
	var value json.RawMessage
	if decoder.Decode(&value) != nil || decoder.More() {
		return WorkflowBindingError("工作流绑定必须且只能包含一个值来源")
	}
	if _, err = decoder.Token(); err != nil {
		return WorkflowBindingError("工作流绑定对象未正确结束")
	}
	if _, err = decoder.Token(); err != io.EOF {
		return WorkflowBindingError("工作流绑定包含额外JSON值")
	}
	if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
		return WorkflowBindingError("工作流绑定来源不能是null；字面量null必须写成JSON字符串")
	}
	type bindingJSON WorkflowBinding
	var decoded bindingJSON
	decoder = json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&decoded); err != nil {
		return WorkflowBindingError("工作流绑定字段或类型无效")
	}
	*b = WorkflowBinding(decoded)
	return nil
}

type WorkflowOutputBinding struct {
	StepID  string `json:"stepId"`
	Pointer string `json:"pointer"`
}

// 条件只支持有限比较、存在性与逻辑运算，不解释代码或表达式字符串。
type WorkflowCondition struct {
	Op       string              `json:"op"`
	Left     *WorkflowBinding    `json:"left,omitempty"`
	Right    *WorkflowBinding    `json:"right,omitempty"`
	Children []WorkflowCondition `json:"children,omitempty"`
}

// WorkflowBody is a local acyclic graph with its own input/output namespace.
type WorkflowBody struct {
	Entry            string                   `json:"entry"`
	Steps            []WorkflowStepDefinition `json:"steps"`
	OutputSchemaJSON string                   `json:"outputSchemaJson"`
}

type WorkflowParallel struct {
	Join     string           `json:"join"`
	Branches []WorkflowBranch `json:"branches"`
}

type WorkflowBranch struct {
	ID    string          `json:"id"`
	Input WorkflowBinding `json:"input"`
	Body  WorkflowBody    `json:"body"`
}

type WorkflowForeach struct {
	Items WorkflowBinding `json:"items"`
	Body  WorkflowBody    `json:"body"`
}

type WorkflowLimits struct {
	ActiveMilliseconds int64 `json:"activeMilliseconds"`
	ModelRequests      int   `json:"modelRequests"`
	Calls              int   `json:"calls"`
	Tokens             int   `json:"tokens"`
	ResultBytes        int   `json:"resultBytes"`
	Attempts           int   `json:"attempts"`
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

func WorkflowBindingError(message string) error { return Bad("workflow-binding-invalid", message) }

// 工作流人工确认有独立内容快照，不伪装成一个空操作。
// 普通工具审批继续保持原有 JSON 形状。
func (a Approval) MarshalJSON() ([]byte, error) {
	type approvalJSON Approval
	if a.Kind != "workflow-gate" {
		return json.Marshal(approvalJSON(a))
	}
	return json.Marshal(struct {
		approvalJSON
		Operation   *Operation `json:"operation,omitempty"`
		OperationID *string    `json:"operationId,omitempty"`
	}{approvalJSON: approvalJSON(a)})
}

type WorkflowScope struct {
	ID                      string       `json:"id"`
	WorkflowID              string       `json:"workflowId"`
	ParentScopeID           string       `json:"parentScopeId,omitempty"`
	ParentNodeID            string       `json:"parentNodeId,omitempty"`
	Path                    string       `json:"path"`
	Kind                    string       `json:"kind"`
	TaskID                  string       `json:"taskId"`
	ParentWorkspaceRevision int          `json:"parentWorkspaceRevision"`
	ParentMemoryRevision    int          `json:"parentMemoryRevision"`
	Depth                   int          `json:"depth"`
	Ordinal                 int          `json:"ordinal"`
	Status                  string       `json:"status"`
	CurrentStepID           string       `json:"currentStepId"`
	InputJSON               string       `json:"inputJson"`
	OutputJSON              string       `json:"outputJson,omitempty"`
	Body                    WorkflowBody `json:"body"`
	CreatedAt               string       `json:"createdAt"`
	EndedAt                 string       `json:"endedAt,omitempty"`
}

type WorkflowNodeExecution struct {
	ID                    string   `json:"id"`
	WorkflowID            string   `json:"workflowId"`
	ScopeID               string   `json:"scopeId"`
	StepID                string   `json:"stepId"`
	StableKey             string   `json:"stableKey"`
	Kind                  string   `json:"kind"`
	Ordinal               int      `json:"ordinal"`
	Status                string   `json:"status"`
	TaskID                string   `json:"taskId"`
	RunID                 string   `json:"runId,omitempty"`
	Attempt               int      `json:"attempt"`
	Revision              int      `json:"revision"`
	InputJSON             string   `json:"inputJson"`
	OutputJSON            string   `json:"outputJson,omitempty"`
	Expanded              bool     `json:"expanded"`
	JoinWorkspaceRevision int      `json:"joinWorkspaceRevision"`
	Error                 *Failure `json:"error,omitempty"`
	CreatedAt             string   `json:"createdAt"`
	EndedAt               string   `json:"endedAt,omitempty"`
	AllowedActions        []string `json:"allowedActions"`
}

type WorkflowExecutionTree struct {
	RootScopeID string                  `json:"rootScopeId"`
	Scopes      []WorkflowScope         `json:"scopes"`
	Nodes       []WorkflowNodeExecution `json:"nodes"`
}
