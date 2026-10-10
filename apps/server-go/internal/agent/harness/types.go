// Package harness 管理真实工具任务的持久运行状态，不复用仪表盘演示运行模型。
package harness

import (
	"encoding/json"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

const (
	StateQueued      = "queued"
	StateRunning     = "running"
	StateSucceeded   = "succeeded"
	StateFailed      = "failed"
	StateCancelled   = "cancelled"
	StateInterrupted = "interrupted"
)

// Step 是经过白名单校验的一个顺序工具步骤。
type Step struct {
	Tool string         `json:"tool"`
	Args map[string]any `json:"args"`
}

type SubmitInput struct {
	RequestID string `json:"requestId"`
	Kind      string `json:"kind"`
	Steps     []Step `json:"steps"`
}

// Task 保存已接受的输入快照；驱动版本与输入一起固定。
type Task struct {
	LatestRun     *Run   `json:"latestRun,omitempty"`
	MemoryStatus  string `json:"memoryStatus,omitempty"`
	SessionID     string `json:"sessionId,omitempty"`
	Goal          string `json:"goal,omitempty"`
	ID            string `json:"id"`
	RequestID     string `json:"requestId"`
	Kind          string `json:"kind"`
	DriverVersion string `json:"driverVersion"`
	CreatedAt     string `json:"createdAt"`
	Steps         []Step `json:"steps"`
}

type Failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Run 的取消请求与终态分开：提出取消不表示执行已停止。
type Run struct {
	ScopeID                  string `json:"scopeId,omitempty"`
	NodeID                   string `json:"nodeId,omitempty"`
	WorkflowFrozenFrom       string `json:"workflowFrozenFrom,omitempty"`
	Driver                   string `json:"driver,omitempty"`
	WorkflowID               string `json:"workflowId,omitempty"`
	WorkflowStepID           string `json:"workflowStepId,omitempty"`
	WorkflowAttempt          int    `json:"workflowAttempt,omitempty"`
	WorkflowOutputSchemaJSON string `json:"workflowOutputSchemaJson,omitempty"`
	WorkflowOutputJSON       string `json:"workflowOutputJson,omitempty"`
	WorkflowOutputRequestID  string `json:"workflowOutputRequestId,omitempty"`
	WorkflowOutputCallID     string `json:"workflowOutputCallId,omitempty"`
	WorkflowNext             string `json:"workflowNext,omitempty"`
	WorkflowActiveReserved   int64  `json:"workflowActiveReserved,omitempty"`

	DriverVersion         string              `json:"driverVersion,omitempty"`
	Snapshot              *CapabilitySnapshot `json:"snapshot,omitempty"`
	Selection             *AgentInput         `json:"selection,omitempty"`
	Resume                *RecoveryCursor     `json:"resume,omitempty"`
	ActiveMilliseconds    int64               `json:"activeMilliseconds,omitempty"`
	SessionID             string              `json:"sessionId,omitempty"`
	RunNumber             int                 `json:"runNumber,omitempty"`
	RequestID             string              `json:"requestId,omitempty"`
	Input                 string              `json:"input,omitempty"`
	Model                 *model.Profile      `json:"model,omitempty"`
	HistorySeq            string              `json:"historySeq,omitempty"`
	InitialMemoryRevision int                 `json:"initialMemoryRevision,omitempty"`
	Phase                 string              `json:"phase,omitempty"`
	MemoryStatus          string              `json:"memoryStatus,omitempty"`
	Warning               *Failure            `json:"warning,omitempty"`
	ID                    string              `json:"id"`
	TaskID                string              `json:"taskId"`
	Status                string              `json:"status"`
	CreatedAt             string              `json:"createdAt"`
	StartedAt             string              `json:"startedAt,omitempty"`
	EndedAt               string              `json:"endedAt,omitempty"`
	CancelRequestedAt     string              `json:"cancelRequestedAt,omitempty"`
	EndReason             string              `json:"endReason,omitempty"`
	Error                 *Failure            `json:"error,omitempty"`
	Task                  *Task               `json:"task,omitempty"`
	Limits                Limits              `json:"limits"`
	Usage                 Usage               `json:"usage"`
	LastSeq               string              `json:"lastSeq"`
}

// Call 的 ID 由运行内核持久分配，不使用工具注册表的进程内计数器。
type Call struct {
	ArgumentsJSON  string          `json:"argumentsJson,omitempty"`
	OperationID    string          `json:"operationId,omitempty"`
	ModelRequestID string          `json:"modelRequestId,omitempty"`
	ModelCallID    string          `json:"modelCallId,omitempty"`
	ID             string          `json:"id"`
	RunID          string          `json:"runId"`
	Tool           string          `json:"tool"`
	Status         string          `json:"status"`
	StartedAt      string          `json:"startedAt,omitempty"`
	EndedAt        string          `json:"endedAt,omitempty"`
	StepIndex      int             `json:"stepIndex"`
	Args           map[string]any  `json:"args"`
	Result         json.RawMessage `json:"result,omitempty"`
	Error          *Failure        `json:"error,omitempty"`
	Truncated      bool            `json:"truncated"`
}

// Event 只保存状态与摘要，完整工具结果通过 calls 分页读取。Seq 为十进制字符串。
type Event struct {
	RunID     string          `json:"runId"`
	Seq       string          `json:"seq"`
	Type      string          `json:"type"`
	At        string          `json:"at"`
	CallID    string          `json:"callId,omitempty"`
	StepIndex *int            `json:"stepIndex,omitempty"`
	Data      json.RawMessage `json:"data,omitempty"`
}

type Usage struct {
	ModelRequests   int  `json:"modelRequests,omitempty"`
	Tokens          int  `json:"tokens,omitempty"`
	EstimatedTokens int  `json:"estimatedTokens,omitempty"`
	ActualTokens    *int `json:"actualTokens,omitempty"`
	CachedTokens    *int `json:"cachedTokens,omitempty"`
	Calls           int  `json:"calls"`
	ResultBytes     int  `json:"resultBytes"`
}

type Limits struct {
	MaxModelRequests    int `json:"maxModelRequests,omitempty"`
	ModelTimeoutSeconds int `json:"modelTimeoutSeconds,omitempty"`
	OutputTokens        int `json:"outputTokens,omitempty"`
	TokenBudget         int `json:"tokenBudget,omitempty"`
	UserBytes           int `json:"userBytes,omitempty"`
	MemoryBytes         int `json:"memoryBytes,omitempty"`
	ModelResponseBytes  int `json:"modelResponseBytes,omitempty"`
	Concurrency         int `json:"concurrency"`
	QueueCapacity       int `json:"queueCapacity"`
	MaxSteps            int `json:"maxSteps"`
	InputBytes          int `json:"inputBytes"`
	CallTimeoutSeconds  int `json:"callTimeoutSeconds"`
	RunTimeoutSeconds   int `json:"runTimeoutSeconds"`
	ResultBytes         int `json:"resultBytes"`
	RunResultBytes      int `json:"runResultBytes"`
	LogBytes            int `json:"logBytes"`
	FrameBytes          int `json:"frameBytes"`
	RetentionDays       int `json:"retentionDays"`
	CancelGraceSeconds  int `json:"cancelGraceSeconds"`
}

func DefaultLimits() Limits {
	return Limits{
		Concurrency: 2, QueueCapacity: 32, MaxSteps: 16, InputBytes: 65536,
		CallTimeoutSeconds: 30, RunTimeoutSeconds: 300, ResultBytes: 262144,
		RunResultBytes: 2097152, LogBytes: 1048576, FrameBytes: 524288,
		RetentionDays: 30, CancelGraceSeconds: 5,
	}
}

type RuntimeCapability struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
}

func DefaultAgentLimits() Limits {
	l := DefaultLimits()
	l.RunTimeoutSeconds = 600
	l.MaxModelRequests = 16
	l.ModelTimeoutSeconds = 60
	l.OutputTokens = 4096
	l.TokenBudget = 128000
	l.UserBytes = 32768
	l.MemoryBytes = 16384
	l.ModelResponseBytes = 524288
	return l
}

type RuntimeInfo struct {
	Wiki              RuntimeCapability    `json:"wiki"`
	Embedding         RuntimeCapability    `json:"embedding"`
	WorkflowV2        RuntimeCapability    `json:"workflowV2"`
	ResourceLocks     RuntimeCapability    `json:"resourceLocks"`
	ExecutionRuntimes RuntimeCapability    `json:"executionRuntimes"`
	Workflow          RuntimeCapability    `json:"workflow"`
	Skills            RuntimeCapability    `json:"skills"`
	MCP               RuntimeCapability    `json:"mcp"`
	Execution         RuntimeCapability    `json:"containerExecution"`
	Approvals         RuntimeCapability    `json:"approvals"`
	Batch             RuntimeCapability    `json:"batch"`
	Agent             RuntimeCapability    `json:"agent"`
	Available         bool                 `json:"available"`
	Worker            string               `json:"worker"`
	Storage           string               `json:"storage"`
	Reason            string               `json:"reason,omitempty"`
	Tools             []tools.PublicSchema `json:"tools"`
	Limits            Limits               `json:"limits"`
	QueueDepth        int                  `json:"queueDepth"`
}

type ListQuery struct {
	WorkflowID string
	SessionID  string
	TaskID     string
	Status     string
	RequestID  string
	Cursor     string
	Limit      int
}

type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor"`
	HasMore    bool   `json:"hasMore"`
}

// Error 是运行 API 的结构化错误，HTTP 状态不写进正文。
type Error struct {
	Status  int    `json:"-"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Message }
