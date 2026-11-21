package state

import (
	"encoding/json"
	"fmt"
	"strings"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
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
	RetryAfterSeconds int                      `json:"retryAfterSeconds,omitempty"`
	Retryable         bool                     `json:"retryable,omitempty"`
	Code              string                   `json:"code"`
	Message           string                   `json:"message"`
	Evidence          *tools.ExecutionEvidence `json:"evidence,omitempty"`
}

// Run 的取消请求与终态分开：提出取消不表示执行已停止。
type Run struct {
	WorkerRestarts   int               `json:"workerRestarts,omitempty"`
	WorkerProgress   int               `json:"workerProgress,omitempty"`
	PolicyFrozen     bool              `json:"policyFrozen,omitempty"`
	PolicyCheckpoint *PolicyCheckpoint `json:"policyCheckpoint,omitempty"`
	Diagnosis        *RunDiagnosis     `json:"diagnosis,omitempty"`
	CompletionChecks int               `json:"completionChecks,omitempty"`
	Wait             *RunWait          `json:"wait,omitempty"`
	Report           *RunReport        `json:"report,omitempty"`
	FailureAnalysis  string            `json:"failureAnalysis,omitempty"`
	RecoveryPolicy   string            `json:"recoveryPolicy,omitempty"`
	Recovery         *RunRecovery      `json:"recovery,omitempty"`
	BudgetPolicy     string            `json:"budgetPolicy,omitempty"`
	BudgetStop       *BudgetStop       `json:"budgetStop,omitempty"`
	Continuation     *Continuation     `json:"continuation,omitempty"` // 只读投影，不作为持久授权。
	WikiStrategy     string            `json:"wikiStrategy,omitempty"`
	Plan             *RunPlan          `json:"plan,omitempty"`

	SupersededByRunID        string `json:"supersededByRunId,omitempty"`
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
	ModelContent        string                   `json:"modelContent,omitempty"`
	Evidence            *tools.ExecutionEvidence `json:"evidence,omitempty"`
	Attempts            []ToolAttempt            `json:"attempts,omitempty"`
	ReservedResultBytes int                      `json:"reservedResultBytes,omitempty"`
	ArgumentsJSON       string                   `json:"argumentsJson,omitempty"`
	OperationID         string                   `json:"operationId,omitempty"`
	ModelRequestID      string                   `json:"modelRequestId,omitempty"`
	ModelCallID         string                   `json:"modelCallId,omitempty"`
	ID                  string                   `json:"id"`
	RunID               string                   `json:"runId"`
	Tool                string                   `json:"tool"`
	Status              string                   `json:"status"`
	StartedAt           string                   `json:"startedAt,omitempty"`
	EndedAt             string                   `json:"endedAt,omitempty"`
	StepIndex           int                      `json:"stepIndex"`
	Args                map[string]any           `json:"args"`
	Result              json.RawMessage          `json:"result,omitempty"`
	Error               *Failure                 `json:"error,omitempty"`
	Truncated           bool                     `json:"truncated"`
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
	// OutputTokens 为 0 表示未设置：单次输出上限按思考模式取官方默认（见 outputLimit）。
	OutputTokens       int `json:"outputTokens,omitempty"`
	TokenBudget        int `json:"tokenBudget,omitempty"`
	UserBytes          int `json:"userBytes,omitempty"`
	MemoryBytes        int `json:"memoryBytes,omitempty"`
	ModelResponseBytes int `json:"modelResponseBytes,omitempty"`
	// 单文件字节为 0 表示不开放图片；张数为 0 表示不设置数量限制。
	// Agent 新配置必须设置正数总字节上限，最多 8 MiB；旧快照的正数张数与总量
	// 继续按原值校验，总量为 0 的旧快照保留不设置独立总量限制的语义。
	ImageCountPerMessage int `json:"imageCountPerMessage,omitempty"`
	ImageBytesPerFile    int `json:"imageBytesPerFile,omitempty"`
	ImageBytesPerMessage int `json:"imageBytesPerMessage,omitempty"`
	Concurrency          int `json:"concurrency"`
	QueueCapacity        int `json:"queueCapacity"`
	MaxSteps             int `json:"maxSteps"`
	InputBytes           int `json:"inputBytes"`
	CallTimeoutSeconds   int `json:"callTimeoutSeconds"`
	RunTimeoutSeconds    int `json:"runTimeoutSeconds"`
	ResultBytes          int `json:"resultBytes"`
	RunResultBytes       int `json:"runResultBytes"`
	LogBytes             int `json:"logBytes"`
	FrameBytes           int `json:"frameBytes"`
	RetentionDays        int `json:"retentionDays"`
	CancelGraceSeconds   int `json:"cancelGraceSeconds"`
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

const (
	StateWaitingModel   = "waiting-model"
	StateWaitingStorage = "waiting-storage"
	StateQueued         = "queued"
	StateRunning        = "running"
	StateSucceeded      = "succeeded"
	StateFailed         = "failed"
	StateCancelled      = "cancelled"
	StateInterrupted    = "interrupted"
)

// 新普通聊天显式返回零次数限额；批次与旧快照保留既有的可选字段形状。
func (l Limits) MarshalJSON() ([]byte, error) {
	type limitsJSON Limits
	if l.MaxModelRequests == 0 && l.MaxSteps == 0 && l.TokenBudget > 0 {
		return json.Marshal(struct {
			MaxModelRequests int `json:"maxModelRequests"`
			limitsJSON
		}{0, limitsJSON(l)})
	}
	return json.Marshal(limitsJSON(l))
}

// BudgetStop 保存本轮资源边界，不表示任务已完成或外部操作已停止。
// 活动时间的 used/limit 使用毫秒，其余分别为 token 和字节。
type BudgetStop struct {
	Resource string `json:"resource"`
	Used     int64  `json:"used"`
	Limit    int64  `json:"limit"`
}

type Continuation struct {
	SourceRunID   string `json:"sourceRunId"`
	Allowed       bool   `json:"allowed"`
	BlockedReason string `json:"blockedReason,omitempty"`
}

type RunWait struct {
	Kind      string   `json:"kind"`
	NextAt    string   `json:"nextAt"`
	Attempts  int      `json:"attempts"`
	RequestID string   `json:"requestId,omitempty"`
	Reason    *Failure `json:"reason,omitempty"`
}

type PolicyCheckpoint struct {
	Status string   `json:"status"`
	Phase  string   `json:"phase"`
	Error  *Failure `json:"error,omitempty"`
}

type BlockedMethod struct {
	Key    string `json:"key"`
	Tool   string `json:"tool"`
	Target string `json:"target"`
	Reason string `json:"reason"`
}

type RunDiagnosis struct {
	Methods     []BlockedMethod `json:"methods"`
	Rounds      int             `json:"rounds"`
	LastRequest int             `json:"lastRequest"`
	Message     string          `json:"message"`
}

// BlockingRecovery is a current projection, separate from the immutable wait
// history. It exposes only the operation identity needed for explicit recovery.
type BlockingRecovery struct {
	RunID       string `json:"runId"`
	OperationID string `json:"operationId"`
	LeaseID     string `json:"leaseId,omitempty"`
	Tool        string `json:"tool"`
	Message     string `json:"message"`
	Verifiable  bool   `json:"verifiable"`
}

type RunRecovery struct {
	OperationID string `json:"operationId"`
	Tool        string `json:"tool"`
	StartedAt   string `json:"startedAt"`
	Deadline    string `json:"deadline"`
	NextCheckAt string `json:"nextCheckAt,omitempty"`
	Checks      int    `json:"checks"`
	Status      string `json:"status"` // verifying | recovered | unresolved
	Message     string `json:"message"`
}

type ToolAttempt struct {
	Number int      `json:"number"`
	Error  *Failure `json:"error,omitempty"`
}

type StorageHealth struct {
	Read     string `json:"read"`
	Write    string `json:"write"`
	Records  string `json:"records"`
	Recovery string `json:"recovery,omitempty"`
}

// TerminalResult 是运行内核生成的公开结果，不代表模型答复或已完成的外部操作。
type TerminalResult struct {
	Origin  string     `json:"origin"`
	Content string     `json:"content"`
	Report  *RunReport `json:"report,omitempty"`
}

type ReportStep struct {
	CallID   string   `json:"callId"`
	Tool     string   `json:"tool"`
	Status   string   `json:"status"`
	Attempts int      `json:"attempts"`
	Error    *Failure `json:"error,omitempty"`
}

type RunReport struct {
	Objective   string       `json:"objective,omitempty"`
	Stage       string       `json:"stage,omitempty"`
	Outcome     string       `json:"outcome"`
	Reason      string       `json:"reason"`
	Completed   int          `json:"completed"`
	Failed      int          `json:"failed"`
	Unconfirmed int          `json:"unconfirmed"`
	Steps       []ReportStep `json:"steps"`
	Remaining   []string     `json:"remaining"`
	Next        string       `json:"next"`
	Analysis    string       `json:"analysis,omitempty"`
}

func (r *RunReport) Text() string {
	text := r.Outcome + "\n\n问题：" + r.Reason + fmt.Sprintf("\n\n执行情况：%d 项调用已确认成功，%d 项失败，%d 项结果未确认。", r.Completed, r.Failed, r.Unconfirmed)
	if r.Objective != "" {
		text = "目标：" + r.Objective + "\n\n" + text
	}
	if r.Stage != "" {
		text += "\n停止阶段：" + r.Stage
	}
	if len(r.Steps) > 0 {
		text += "\n\n处理记录："
		for _, s := range r.Steps {
			state := map[string]string{StateSucceeded: "已确认成功", StateFailed: "失败", "unknown": "结果未确认", "not-executed": "未执行"}[s.Status]
			if state == "" {
				state = "未确认完成"
			}
			text += fmt.Sprintf("\n- `%s`：%s", s.Tool, state)
			if s.Attempts > 1 {
				text += fmt.Sprintf("，尝试 %d 次", s.Attempts)
			}
			if s.Error != nil {
				text += "；" + s.Error.Message
			}
		}
	}
	if len(r.Remaining) > 0 {
		text += "\n\n未完成：" + strings.Join(r.Remaining, "；") + "。"
	}
	if r.Analysis != "" {
		text += "\n\n原因分析（模型根据以上事实生成）：" + r.Analysis
	}
	return text + "\n\n下一步：" + r.Next
}
