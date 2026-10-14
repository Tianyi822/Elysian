package harness

import "elysian/server/internal/agent/harness/model"

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
	ReplaceMessageID string        `json:"replaceMessageId,omitempty"`
	ReasoningLevel   string        `json:"reasoningLevel,omitempty"`
	Skills           []RevisionRef `json:"skills,omitempty"`
	Resources        []ResourceRef `json:"resources,omitempty"`
	Prompts          []PromptRef   `json:"prompts,omitempty"`
	RequestID        string        `json:"requestId"`
	Content          string        `json:"content"`
}

// Message 只含公开用户输入和助手答复，不承载工具过程或工作记忆。
type Message struct {
	ReplacesMessageID string    `json:"replacesMessageId,omitempty"`
	Quarantined       bool      `json:"quarantined,omitempty"`
	WikiSources       []WikiRef `json:"wikiSources,omitempty"`
	ID                string    `json:"id"`
	SessionID         string    `json:"sessionId"`
	TaskID            string    `json:"taskId"`
	RunID             string    `json:"runId"`
	Seq               string    `json:"seq"`
	Role              string    `json:"role"`
	Content           string    `json:"content"`
	CreatedAt         string    `json:"createdAt"`
	RunStatus         string    `json:"runStatus,omitempty"`
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
	// Reasoning 是本次请求仍在生成的展示文本，不表示已确认响应。
	Reasoning       string          `json:"reasoning,omitempty"`
	Content         string          `json:"content,omitempty"`
	WikiSources     []WikiRef       `json:"wikiSources,omitempty"`
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
