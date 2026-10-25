package client

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
)

// 聊天链路消费（harness/agent_routes.go 的 sessions/{id}/tasks、tasks/{id}/runs、
// runs/{id}/* 与 sessions/{id}/messages）：提交字段与 AgentInput 精确一致
// （DisallowUnknownFields），requestId 遵循 ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$、
// 每轮生成并幂等重试复用；消息按 seq 升序分页（after 为数字游标）。

// UserBytes 单轮用户输入上限（服务端 sessions.go 同值）。
const UserBytes = 32768

// MessageRunConfig 消息所属 Run 固定的模型与思考档快照（模型已删或旧记录无快照
// 时字段为空，按未知处理）。
type MessageRunConfig struct {
	ModelName      string `json:"modelName"`
	ModelService   string `json:"modelService,omitempty"`
	ModelProfileID string `json:"modelProfileId"`
	ModelRevision  int    `json:"modelRevision"`
	ReasoningLevel string `json:"reasoningLevel,omitempty"`
}

// Message 公开历史消息（用户输入与助手最终答复；工具过程经 timeline 呈现）。
type Message struct {
	Attachments       []MessageAttachment `json:"attachments,omitempty"`
	ReplacesMessageID string              `json:"replacesMessageId,omitempty"`
	ID                string              `json:"id"`
	SessionID         string              `json:"sessionId"`
	TaskID            string              `json:"taskId"`
	RunID             string              `json:"runId"`
	Seq               string              `json:"seq"`
	Role              string              `json:"role"`
	Content           string              `json:"content"`
	CreatedAt         string              `json:"createdAt"`
	RunStatus         string              `json:"runStatus,omitempty"`
	RunConfig         *MessageRunConfig   `json:"runConfig,omitempty"`
}

// TimelineEntry 运行过程条目：kind ∈ reasoning／content／tool／user-input（等待
// 输入的问题组挂在 UserInput，答题向导由此驱动）。
type TimelineEntry struct {
	ID             string            `json:"id"`
	Kind           string            `json:"kind"`
	Status         string            `json:"status"`
	Text           string            `json:"text,omitempty"`
	Tool           string            `json:"tool,omitempty"`
	ArgumentsJSON  string            `json:"argumentsJson,omitempty"`
	CallID         string            `json:"callId,omitempty"`
	StartedAt      string            `json:"startedAt"`
	EndedAt        string            `json:"endedAt,omitempty"`
	Error          *Failure          `json:"error,omitempty"`
	Truncated      bool              `json:"truncated"`
	RequestIndex   int               `json:"requestIndex"`
	ModelRequestID string            `json:"modelRequestId"`
	UserInput      *UserInputRequest `json:"userInput,omitempty"`
}

// ChatContextUsage 最近一次确认推理的上下文用量（harness.ChatContextUsage 的消费
// 子集）：容量 ContextTokens 来自 Run 固定模型快照，TotalTokens 未报告时为 nil
// （不补零，与 Web ChatUsageIndicator 同语义）；EstimatedBreakdown 是六项互斥来源
// 的分类占用（本地估算，装配期计算）。
type ChatContextUsage struct {
	ModelRequestID     string                `json:"modelRequestId"`
	Model              string                `json:"model"`
	TotalTokens        *int                  `json:"totalTokens,omitempty"`
	ContextTokens      int                   `json:"contextTokens"`
	EstimatedBreakdown *ChatContextBreakdown `json:"estimatedBreakdown,omitempty"`
}

// ChatContextBreakdown 实际请求装配时的分类占用估算（消息／系统工具／其他／技能／
// 系统提示词／MCP 工具），展示须标注本地估算。
type ChatContextBreakdown struct {
	Messages     int `json:"messages"`
	SystemTools  int `json:"systemTools"`
	Other        int `json:"other"`
	Skills       int `json:"skills"`
	SystemPrompt int `json:"systemPrompt"`
	MCPTools     int `json:"mcpTools"`
}

// ChatRunUsage Run 累计用量（harness.Usage 的消费子集）：Tokens 为预算计账 token，
// ActualTokens／CachedTokens 的 nil 表示未报告；Tokens 仅供预算计账，不展示为实际用量。
type ChatRunUsage struct {
	ModelRequests int  `json:"modelRequests,omitempty"`
	Tokens        int  `json:"tokens,omitempty"`
	ActualTokens  *int `json:"actualTokens,omitempty"`
	CachedTokens  *int `json:"cachedTokens,omitempty"`
}

// ChatCacheHitUsage 平均缓存命中（全部已完成请求按输入 token 加权；InputTokens 为 0
// 时无有效分母，不绘制比例）。
type ChatCacheHitUsage struct {
	InputTokens  int `json:"inputTokens"`
	CachedTokens int `json:"cachedTokens"`
}

// ChatTimeline 运行过程快照（GET /runs/{id}/timeline 与 SSE 帧内嵌同形）；Plan 为
// 模型确认的计划快照（折叠条展示），ContextUsage／Usage／CacheHitUsage 驱动状态栏
// 上下文用量文本与 Ctrl+O 执行详情的分节。
type ChatTimeline struct {
	RunID         string             `json:"runId"`
	Status        string             `json:"status"`
	Done          bool               `json:"done"`
	Plan          *RunPlan           `json:"plan,omitempty"`
	Error         *Failure           `json:"error,omitempty"`
	ContextUsage  *ChatContextUsage  `json:"contextUsage,omitempty"`
	Usage         *ChatRunUsage      `json:"usage,omitempty"`
	CacheHitUsage *ChatCacheHitUsage `json:"cacheHitUsage,omitempty"`
	Entries       []TimelineEntry    `json:"entries"`
}

// ChatOutput 输出流帧载荷：可替换的全量展示快照（reasoning 与 content 为累计全文），
// 最终消息以 Messages 为准；Done 为真时流结束。
type ChatOutput struct {
	RunID      string        `json:"runId"`
	ResponseID string        `json:"responseId"`
	Reasoning  string        `json:"reasoning"`
	Content    string        `json:"content"`
	Done       bool          `json:"done"`
	Timeline   *ChatTimeline `json:"timeline,omitempty"`
}

// AgentInput 提交载荷（与服务端 harness.AgentInput 字段精确一致；可选字段缺省
// 即服务端默认：permissionMode 缺省 ask、authorizationMode 缺省不申请、
// extensionMode 缺省不自动接入）。
type AgentInput struct {
	ReplaceMessageID  string          `json:"replaceMessageId,omitempty"`
	Attachments       []AttachmentRef `json:"attachments,omitempty"`
	RequestID         string          `json:"requestId"`
	Content           string          `json:"content"`
	ReasoningLevel    string          `json:"reasoningLevel,omitempty"`
	ExtensionMode     string          `json:"extensionMode,omitempty"`
	PermissionMode    string          `json:"permissionMode,omitempty"`
	AuthorizationMode string          `json:"authorizationMode,omitempty"`
}

// AuthorizationOnDemand 运行时授权开关取值（与服务端 harness.AuthorizationOnDemand
// 同值）：普通聊天提交后按需发现 Bash／技能脚本／文件能力并走统一运行时授权路径
// （与 Web 每轮提交同口径）。
const AuthorizationOnDemand = "on-demand"

// 权限模式取值（服务端 harness.PermissionMode 的同集）：ask 为服务端缺省，
// assist／full 由用户显式选择并随轮提交。
const (
	PermissionAsk    = "ask"
	PermissionAssist = "assist"
	PermissionFull   = "full"
)

// PermissionModeLabel 权限模式中文标签（与 Web PERMISSION_MODES 同表；未知值回原文）。
func PermissionModeLabel(mode string) string {
	labels := map[string]string{
		PermissionAsk:    "请求批准",
		PermissionAssist: "帮我批准",
		PermissionFull:   "完全开放",
	}
	if label, ok := labels[mode]; ok {
		return label
	}
	return mode
}

// NextPermissionMode 循环切换 ask→assist→full→ask（未知值回到 ask）。
func NextPermissionMode(mode string) string {
	switch mode {
	case PermissionAsk:
		return PermissionAssist
	case PermissionAssist:
		return PermissionFull
	default:
		return PermissionAsk
	}
}

// NewRequestID 生成本轮幂等键：ely- 前缀加 16 字节随机 hex，满足
// ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$。
func NewRequestID() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		// crypto/rand 失败属进程级故障，panic 优于可预测幂等键。
		panic(fmt.Sprintf("系统随机源不可用：%v", err))
	}
	return "ely-" + hex.EncodeToString(raw[:])
}

// ValidateUserContent 用户输入本地预检（与服务端同口径）：非空（TrimSpace）且
// ≤32768 字节。
func ValidateUserContent(content string) error {
	if len([]byte(content)) > UserBytes {
		return fmt.Errorf("单条消息不能超过 %d 字节", UserBytes)
	}
	if content == "" {
		return fmt.Errorf("消息不能为空")
	}
	return nil
}

// ListMessages 按 seq 升序分页读取公开消息（after 为空从最旧开始；hasMore 时以
// nextCursor 续拉；增量读取用最新 seq 作 after）。
func (c *Client) ListMessages(ctx context.Context, sessionID, after string) (Page[Message], error) {
	query := map[string]string{"limit": "100"}
	if after != "" {
		query["after"] = after
	}
	var page Page[Message]
	_, err := c.do(ctx, "GET", "/api/agent/sessions/"+url.PathEscape(sessionID)+"/messages", query, nil, &page, "")
	return page, err
}

// CreateTask 在会话内提交新任务（首轮）；202 接受与 200 幂等重复都返回 Run。
func (c *Client) CreateTask(ctx context.Context, sessionID string, input AgentInput) (Run, error) {
	var run Run
	_, err := c.do(ctx, "POST", "/api/agent/sessions/"+url.PathEscape(sessionID)+"/tasks", nil, input, &run, "")
	return run, err
}

// ContinueTask 对既有任务续轮（会话已有任务时沿用 taskID 提交）。
func (c *Client) ContinueTask(ctx context.Context, taskID string, input AgentInput) (Run, error) {
	var run Run
	_, err := c.do(ctx, "POST", "/api/agent/tasks/"+url.PathEscape(taskID)+"/runs", nil, input, &run, "")
	return run, err
}

// GetTask 读取任务（取续轮目标）。
func (c *Client) GetTask(ctx context.Context, taskID string) (Task, error) {
	var task Task
	_, err := c.do(ctx, "GET", "/api/agent/tasks/"+url.PathEscape(taskID), nil, nil, &task, "")
	return task, err
}

// CancelRun 请求停止运行：排队／运行中 202，已终态 200；取消请求与执行停止分开
// （「正在停止」到轮询见 cancelled 收敛）。
func (c *Client) CancelRun(ctx context.Context, runID string) (Run, error) {
	var run Run
	_, err := c.do(ctx, "POST", "/api/agent/runs/"+url.PathEscape(runID)+"/cancel", nil, struct{}{}, &run, "")
	return run, err
}

// TimelineSnapshot 读取运行过程快照（轮询驱动工具条目与等待态展示）。
func (c *Client) TimelineSnapshot(ctx context.Context, runID string) (ChatTimeline, error) {
	var timeline ChatTimeline
	_, err := c.do(ctx, "GET", "/api/agent/runs/"+url.PathEscape(runID)+"/timeline", nil, nil, &timeline, "")
	return timeline, err
}
