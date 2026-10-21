package harness

import "elysian/server/internal/agent/harness/model"

const wikiPageBytes = 16 << 10
const wikiRecallBytes = 16 << 10
const wikiPageLimit = 10000

type WikiSpace struct {
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	CreatedAt string `json:"createdAt"`
}

// WikiRef 指向整页不可变修订；来源依赖由父进程维护。
type WikiRef struct {
	PageID   string `json:"pageId"`
	Revision int    `json:"revision"`
	Digest   string `json:"digest"`
}

type WikiEvidence struct {
	ID              string `json:"id"`
	Kind            string `json:"kind"`
	RunID           string `json:"runId,omitempty"`
	EventSeq        string `json:"eventSeq,omitempty"`
	URI             string `json:"uri,omitempty"`
	Text            string `json:"text"`
	CreatedAt       string `json:"createdAt"`
	Digest          string `json:"digest"`
	OriginalCleared bool   `json:"originalCleared"`
}

type WikiPage struct {
	Maintenance string         `json:"maintenance,omitempty"`
	ID          string         `json:"id"`
	SpaceID     string         `json:"spaceId"`
	Slug        string         `json:"slug"`
	Revision    int            `json:"revision"`
	Title       string         `json:"title"`
	Markdown    string         `json:"markdown"`
	Kind        string         `json:"kind"`
	Status      string         `json:"status"`
	Digest      string         `json:"digest"`
	CreatedAt   string         `json:"createdAt"`
	UpdatedAt   string         `json:"updatedAt"`
	ExpiresAt   string         `json:"expiresAt,omitempty"`
	WithdrawnAt string         `json:"withdrawnAt,omitempty"`
	Evidence    []WikiEvidence `json:"evidence"`
	Sources     []WikiRef      `json:"sources"`
	Links       []string       `json:"links"`
	Tags        []string       `json:"tags,omitempty"`
	Aliases     []string       `json:"aliases,omitempty"`
}

type WikiPageInput struct {
	Maintenance      string         `json:"maintenance,omitempty"`
	ExpectedRevision int            `json:"expectedRevision"`
	Slug             string         `json:"slug"`
	Title            string         `json:"title"`
	Markdown         string         `json:"markdown"`
	Kind             string         `json:"kind"`
	ExpiresAt        string         `json:"expiresAt,omitempty"`
	Evidence         []WikiEvidence `json:"evidence"`
	Sources          []WikiRef      `json:"sources"`
	Tags             []string       `json:"tags,omitempty"`
	Aliases          []string       `json:"aliases,omitempty"`
}

type WikiCandidate struct {
	CurrentPage *WikiPage     `json:"currentPage,omitempty"`
	Reason      string        `json:"reason,omitempty"`
	ID          string        `json:"id"`
	SpaceID     string        `json:"spaceId"`
	PageID      string        `json:"pageId,omitempty"`
	Status      string        `json:"status"`
	OriginKind  string        `json:"originKind"`
	OriginID    string        `json:"originId"`
	CreatedAt   string        `json:"createdAt"`
	DecidedAt   string        `json:"decidedAt,omitempty"`
	Page        WikiPageInput `json:"page"`
}

type WikiSearchHit struct {
	Page   WikiPage `json:"page"`
	Score  float64  `json:"score"`
	Method string   `json:"method"`
}

type WikiSearchResult struct {
	Items    []WikiSearchHit `json:"items"`
	Degraded bool            `json:"degraded"`
	Reason   string          `json:"reason,omitempty"`
}

type WikiCheck struct {
	OrphanPages    []string `json:"orphanPages"`
	BrokenLinks    []string `json:"brokenLinks"`
	ExpiredPages   []string `json:"expiredPages"`
	InvalidSources []string `json:"invalidSources"`
}

type WikiExport struct {
	Files map[string]string `json:"files"`
}

type WikiJob struct {
	Strategy         string            `json:"strategy,omitempty"`
	PublishedRefs    []WikiRef         `json:"publishedRefs,omitempty"`
	ID               string            `json:"id"`
	Kind             string            `json:"kind"`
	OriginKind       string            `json:"originKind"`
	OriginID         string            `json:"originId"`
	SpaceID          string            `json:"spaceId"`
	Status           string            `json:"status"`
	MemoryStatus     string            `json:"memoryStatus,omitempty"`
	TaskID           string            `json:"taskId,omitempty"`
	RunID            string            `json:"runId,omitempty"`
	WorkflowID       string            `json:"workflowId,omitempty"`
	Generation       int               `json:"generation"`
	EmbeddingProfile *EmbeddingProfile `json:"embeddingProfile,omitempty"`
	Model            model.Profile     `json:"model"`
	CreatedAt        string            `json:"createdAt"`
	StartedAt        string            `json:"startedAt,omitempty"`
	EndedAt          string            `json:"endedAt,omitempty"`
	Usage            model.Usage       `json:"usage"`
	EstimatedTokens  int               `json:"estimatedTokens"`
	Error            *Failure          `json:"error,omitempty"`
	CandidateIDs     []string          `json:"candidateIds"`
	Sources          []WikiRef         `json:"sources"`
	Input            string            `json:"-"`
	Response         *model.Response   `json:"-"`
}

type WikiExtractionInput struct {
	RequestID  string `json:"requestId"`
	RunID      string `json:"runId,omitempty"`
	WorkflowID string `json:"workflowId,omitempty"`
}
