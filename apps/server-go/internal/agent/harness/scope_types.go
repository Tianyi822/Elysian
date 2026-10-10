package harness

const (
	WorkflowV2LanguageVersion = "workflow/v2"
	workflowV2MaxDepth        = 4
	workflowV2MaxNodes        = 256
	workflowV2MaxParallel     = 8
	workflowV2MaxForeach      = 32
)

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

func workflowV2(w WorkflowInstance) bool { return w.LanguageVersion == WorkflowV2LanguageVersion }
func workflowBody(d WorkflowDefinition) WorkflowBody {
	return WorkflowBody{Entry: d.Entry, Steps: d.Steps, OutputSchemaJSON: d.OutputSchemaJSON}
}
