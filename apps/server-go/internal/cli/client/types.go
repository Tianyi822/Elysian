// Package client 是 ely TUI 与面板后端通信的唯一网络出口（CLI 方案 §6.1）：
// 只经 127.0.0.1 回环 HTTP 消费既有 /api/auth 与 /api/agent 接口，全部请求统一
// 携带与 Host 逐字一致的回环 Origin（§3.2 契约），错误按五态分类（§3.1）归因，
// 不做任何业务裁决。本文件钉死 TUI 消费的响应契约形状；后端对应权威类型见
// internal/agent/harness（agent_types.go、model/types.go、types.go）。
package client

// Session 会话公开形状（harness.Session 的消费子集）。
type Session struct {
	ID               string   `json:"id"`
	Title            string   `json:"title"`
	CreatedAt        string   `json:"createdAt"`
	LastActivityAt   string   `json:"lastActivityAt"`
	ModelProfileID   string   `json:"modelProfileId"`
	ModelRevision    int      `json:"modelRevision"`
	ActiveRunID      string   `json:"activeRunId,omitempty"`
	ActiveWorkflowID string   `json:"activeWorkflowId,omitempty"`
	LastSeq          string   `json:"lastSeq"`
	Notices          []string `json:"notices,omitempty"`
}

// Page 分页统一形状（harness.Page）。
type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"nextCursor"`
	HasMore    bool   `json:"hasMore"`
}

// CreateSessionInput POST /api/agent/sessions 请求体（字段与服务端精确一致，
// 服务端 DisallowUnknownFields）。
type CreateSessionInput struct {
	Title          string `json:"title"`
	ModelProfileID string `json:"modelProfileId"`
	ModelRevision  int    `json:"modelRevision"`
}

// SwitchModelInput PUT /api/agent/sessions/{id}/model 请求体。
type SwitchModelInput struct {
	ModelProfileID string `json:"modelProfileId"`
	ModelRevision  int    `json:"modelRevision"`
}

// ModelCapabilities 模型能力声明（harness/model.Capabilities 的消费子集）。
type ModelCapabilities struct {
	Text                  bool     `json:"text"`
	Tools                 bool     `json:"tools"`
	Image                 bool     `json:"image,omitempty"`
	ReasoningLevels       []string `json:"reasoningLevels,omitempty"`
	DefaultReasoningLevel string   `json:"defaultReasoningLevel,omitempty"`
}

// ModelServiceRef 模型所属服务的公开引用。
type ModelServiceRef struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
	Name     string `json:"name"`
	Active   bool   `json:"active"`
	Enabled  bool   `json:"enabled"`
}

// ModelProfile 模型配置公开形状（Credential 永不下发；Model 同时是上送 ID 与显示名）。
type ModelProfile struct {
	ID            string            `json:"id"`
	Revision      int               `json:"revision"`
	Provider      string            `json:"provider"`
	APIFormat     string            `json:"apiFormat"`
	BaseURL       string            `json:"baseUrl"`
	Model         string            `json:"model"`
	ContextTokens int               `json:"contextTokens"`
	OutputTokens  int               `json:"outputTokens"`
	Capabilities  ModelCapabilities `json:"capabilities"`
	Active        bool              `json:"active"`
	HasCredential bool              `json:"hasCredential"`
	Service       *ModelServiceRef  `json:"service,omitempty"`
}

// Failure 服务端结构化失败（harness.Failure）。
type Failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Run 运行公开形状的消费子集（状态、终态归因与失败详情）。
type Run struct {
	RequestID string   `json:"requestId,omitempty"`
	ID        string   `json:"id"`
	TaskID    string   `json:"taskId,omitempty"`
	SessionID string   `json:"sessionId,omitempty"`
	RunNumber int      `json:"runNumber,omitempty"`
	Status    string   `json:"status"`
	Phase     string   `json:"phase,omitempty"`
	EndReason string   `json:"endReason,omitempty"`
	Error     *Failure `json:"error,omitempty"`
	CreatedAt string   `json:"createdAt"`
	StartedAt string   `json:"startedAt,omitempty"`
	EndedAt   string   `json:"endedAt,omitempty"`
}

// Task 任务公开形状的消费子集；LatestRun 支撑会话详情的运行状态展示。
type Task struct {
	LatestRun *Run   `json:"latestRun,omitempty"`
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Goal      string `json:"goal,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// RuntimeInfo GET /api/agent/runtime 的可用性探测子集（该端点不依赖服务可用）。
type RuntimeInfo struct {
	Available bool   `json:"available"`
	Worker    string `json:"worker"`
	Storage   string `json:"storage"`
	Reason    string `json:"reason,omitempty"`
}

// 会话标题上限（服务端 RenameSession 同口径：TrimSpace 非空且 ≤200 字节）。
const MaxTitleBytes = 200
