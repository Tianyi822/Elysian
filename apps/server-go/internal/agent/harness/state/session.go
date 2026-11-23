package state

import (
	"elysian/server/internal/agent/harness/model"
)

// Session 固定用户选择的模型版本；登录 Cookie 不属于会话历史。
type Session struct {
	ActiveWorkflowID string       `json:"activeWorkflowId,omitempty"`
	ID               string       `json:"id"`
	Title            string       `json:"title"`
	CreatedAt        string       `json:"createdAt"`
	LastActivityAt   string       `json:"lastActivityAt"`
	ModelProfileID   string       `json:"modelProfileId"`
	ModelRevision    int          `json:"modelRevision"`
	ActiveRunID      string       `json:"activeRunId,omitempty"`
	LastSeq          string       `json:"lastSeq"`
	Notices          []string     `json:"notices,omitempty"`
	ModelChange      *ModelChange `json:"modelChange,omitempty"`
}

type ModelChange struct {
	Before      *model.Profile `json:"before,omitempty"`
	After       model.Profile  `json:"after"`
	Differences []string       `json:"differences"`
	Notices     []string       `json:"notices"`
}

type CreateSessionInput struct {
	Title          string `json:"title"`
	ModelProfileID string `json:"modelProfileId"`
	ModelRevision  int    `json:"modelRevision"`
}

type SwitchModelInput struct {
	ModelProfileID string `json:"modelProfileId"`
	ModelRevision  int    `json:"modelRevision"`
}

type RenameSessionInput struct {
	Title string `json:"title"`
}

type AgentInput struct {
	ContinueFromRunID string          `json:"continueFromRunId,omitempty"`
	AuthorizationMode string          `json:"authorizationMode,omitempty"`
	ExtensionMode     string          `json:"extensionMode,omitempty"`
	PermissionMode    PermissionMode  `json:"permissionMode,omitempty"`
	ReplaceMessageID  string          `json:"replaceMessageId,omitempty"`
	ReasoningLevel    string          `json:"reasoningLevel,omitempty"`
	Skills            []RevisionRef   `json:"skills,omitempty"`
	Resources         []ResourceRef   `json:"resources,omitempty"`
	Prompts           []PromptRef     `json:"prompts,omitempty"`
	Attachments       []AttachmentRef `json:"attachments,omitempty"`
	RequestID         string          `json:"requestId"`
	Content           string          `json:"content"`
}

// AttachmentRef 只引用已上传附件；字节经独立上传端点先行入库。
type AttachmentRef struct {
	ID string `json:"id"`
}

// MessageAttachment 是公开消息携带的附件描述符，只含引用与摘要，不含字节。
type MessageAttachment struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	MimeType string `json:"mimeType"`
	Bytes    int    `json:"bytes"`
	Width    int    `json:"width"`
	Height   int    `json:"height"`
}

// MessageRunConfig 是消息所属 Run 固定下来的模型与思考等级快照，用于在公开历史中
// 展示轮次边界上的切换；它只是展示事实，不参与会话续轮或能力判定。
type MessageRunConfig struct {
	ModelName      string `json:"modelName"`
	ModelService   string `json:"modelService,omitempty"`
	ModelProfileID string `json:"modelProfileId"`
	ModelRevision  int    `json:"modelRevision"`
	ReasoningLevel string `json:"reasoningLevel,omitempty"`
}

// Message 只含公开用户输入和助手答复，不承载工具过程或工作记忆。
type Message struct {
	Origin            string              `json:"origin,omitempty"`
	ReplacesMessageID string              `json:"replacesMessageId,omitempty"`
	Quarantined       bool                `json:"quarantined,omitempty"`
	Attachments       []MessageAttachment `json:"attachments,omitempty"`
	RunConfig         *MessageRunConfig   `json:"runConfig,omitempty"`
	ID                string              `json:"id"`
	SessionID         string              `json:"sessionId"`
	TaskID            string              `json:"taskId"`
	RunID             string              `json:"runId"`
	Seq               string              `json:"seq"`
	Role              string              `json:"role"`
	Content           string              `json:"content"`
	CreatedAt         string              `json:"createdAt"`
	RunStatus         string              `json:"runStatus,omitempty"`
}

type MemoryCursor struct {
	RunNumber int    `json:"runNumber"`
	EventSeq  string `json:"eventSeq"`
}

type EvidenceRef struct {
	RunID    string `json:"runId"`
	EventSeq string `json:"eventSeq"`
}

type MemoryFact struct {
	Text    string        `json:"text"`
	Sources []EvidenceRef `json:"sources"`
}

type WorkingMemory struct {
	MemoryStatus  string       `json:"memoryStatus,omitempty"`
	TaskID        string       `json:"taskId"`
	Revision      int          `json:"revision"`
	UpdatedAt     string       `json:"updatedAt"`
	Coverage      MemoryCursor `json:"coverage"`
	Objective     string       `json:"objective,omitempty"`
	Constraints   []string     `json:"constraints"`
	Facts         []MemoryFact `json:"facts"`
	Todos         []string     `json:"todos"`
	OpenQuestions []string     `json:"openQuestions"`
	Summary       string       `json:"summary"`
}

type ModelRequestRecord struct {
	LogicalID          string                  `json:"logicalId,omitempty"`
	Attempt            int                     `json:"attempt,omitempty"`
	CorrectionKey      string                  `json:"correctionKey,omitempty"`
	ToolNames          []string                `json:"toolNames,omitempty"`
	EstimatedBreakdown *model.ContextBreakdown `json:"estimatedBreakdown,omitempty"`
	// Reasoning 是本次请求仍在生成的展示文本，不表示已确认响应。
	Reasoning       string          `json:"reasoning,omitempty"`
	Content         string          `json:"content,omitempty"`
	ContextItemIDs  []string        `json:"contextItemIds,omitempty"`
	ID              string          `json:"id"`
	RunID           string          `json:"runId"`
	Index           int             `json:"index"`
	Purpose         string          `json:"purpose"`
	Status          string          `json:"status"`
	StartedAt       string          `json:"startedAt"`
	EndedAt         string          `json:"endedAt,omitempty"`
	ContextRefs     []EvidenceRef   `json:"contextRefs"`
	MemoryRevision  int             `json:"memoryRevision"`
	Response        *model.Response `json:"response,omitempty"`
	Error           *Failure        `json:"error,omitempty"`
	EstimatedTokens int             `json:"estimatedTokens"`
	EventSeq        string          `json:"eventSeq,omitempty"`
	HistorySeq      string          `json:"historySeq"`
}

type AttachmentRecord struct {
	MessageAttachment
	SessionID string
}

// ModelPointerPublic 防止内部凭据对象被快照长期持有。
func (r *Run) ModelPointerPublic() {
	if r.Model != nil {
		public := r.Model.Public()
		r.Model = &public
	}
}

type UserInputOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

type UserInputQuestion struct {
	ID                  string            `json:"id"`
	Header              string            `json:"header"`
	Question            string            `json:"question"`
	Options             []UserInputOption `json:"options"`
	RecommendedOptionID string            `json:"recommendedOptionId,omitempty"`
}

type UserInputAnswer struct {
	OptionID string `json:"optionId,omitempty"`
	Text     string `json:"text,omitempty"`
}

type AnswerUserInput struct {
	RequestID string                     `json:"requestId"`
	Answers   map[string]UserInputAnswer `json:"answers"`
}

type UserInputRequest struct {
	ID              string                     `json:"id"`
	RunID           string                     `json:"runId"`
	ModelRequestID  string                     `json:"modelRequestId"`
	ModelCallID     string                     `json:"modelCallId"`
	CallID          string                     `json:"callId"`
	Status          string                     `json:"status"`
	Questions       []UserInputQuestion        `json:"questions"`
	Answers         map[string]UserInputAnswer `json:"answers,omitempty"`
	AnswerRequestID string                     `json:"answerRequestId,omitempty"`
	CreatedAt       string                     `json:"createdAt"`
	EndedAt         string                     `json:"endedAt,omitempty"`
}

type UserInputReceipt struct {
	UserInput UserInputRequest `json:"userInput"`
	Run       Run              `json:"run"`
}

const UserInputSource = "user-input"

type CapabilityRevocation struct {
	Cursor    string `json:"cursor"`
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	Reason    string `json:"reason"`
	CreatedAt string `json:"createdAt"`
}

type PlanStep struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// RunPlan 是模型确认的步骤快照，不代表外部操作已获授权或执行成功。
type RunPlan struct {
	SourceRunID string     `json:"sourceRunId,omitempty"`
	Revision    int        `json:"revision"`
	UpdatedAt   string     `json:"updatedAt"`
	Steps       []PlanStep `json:"steps"`
}

const PlanSource = "task-plan"

// ASCII 约四字一 token，其他 Unicode 约一字一 token。仅用于组成展示，
// 既有准入预算仍由 estimateRequest 的保守字节估算负责。
func EstimateContextText(text string) int {
	ascii, other := 0, 0
	for _, r := range text {
		if r < 128 {
			ascii++
		} else {
			other++
		}
	}
	return (ascii+3)/4 + other
}

func Bad(code, message string) error { return &Error{Status: 400, Code: code, Message: message} }

const TaskHistorySource = "task-history"
