// Package harness 管理真实工具任务的持久运行状态，不复用仪表盘演示运行模型。
package harness

import (
	"elysian/server/internal/agent/tools"
)

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

// 单次输出上限按思考模式取 DeepSeek 官方默认（非思考 8K、思考 64K、reasoning_effort=max 128K，
// 其他供应商由模型声明的最大输出收紧）；上限与预算边界给多轮思考请求留出余量。
const (
	outputTokensNonThinking = 8192
	outputTokensThinking    = 65536
	outputTokensMaxEffort   = 131072
	outputTokensCeiling     = 393216
	tokenBudgetCeiling      = 1048576
)

func DefaultAgentLimits() Limits {
	l := DefaultLimits()
	l.RunTimeoutSeconds = 600
	l.MaxModelRequests = 16
	l.ModelTimeoutSeconds = 60
	l.OutputTokens = 0 // 未设置：按思考模式的官方默认取值
	// 单轮预算容纳一次 128K 输出与多轮思考请求，并低于工作流实例预算（256000），步骤超额仍由步骤预算先裁定。
	l.TokenBudget = 196608
	l.UserBytes = 32768
	l.MemoryBytes = 16384
	// 前端按图片独立压缩至 1 MiB，不限制张数，处理后的图片合计最多 8 MiB。
	l.ImageCountPerMessage = 0
	l.ImageBytesPerFile = 1048576
	l.ImageBytesPerMessage = maxImageAttachmentSetBytes
	// 校验后的响应上限覆盖 128K 档长回答的正文（含思考），原始流转上限由模型客户端按输出上限单独放大。
	l.ModelResponseBytes = 2097152
	return l
}

type RuntimeInfo struct {
	StorageHealth     *StorageHealth       `json:"storageHealth,omitempty"`
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
