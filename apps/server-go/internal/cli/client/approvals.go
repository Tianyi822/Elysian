package client

import (
	"context"
	"encoding/json"
	"net/url"
)

// 审批、运行时授权、会话授权与等待用户输入的消费契约（harness/capability_types.go、
// runtime_access_types.go、user_input.go 的公开形状子集；宽松解析忽略未消费字段）。

// Approval 待审批操作（pending/approved/denied/expired/revoked；kind=workflow-gate
// 属已退役工作流，TUI 过滤不展示）。Access 非空即运行时授权卡（once/denied；旧决定保留 session 兼容
// 三选），否则为普通审批（approved/denied）。
type Approval struct {
	ID          string     `json:"id"`
	RunID       string     `json:"runId"`
	OperationID string     `json:"operationId"`
	Status      string     `json:"status"`
	Kind        string     `json:"kind,omitempty"`
	Decision    string     `json:"decision,omitempty"`
	CreatedAt   string     `json:"createdAt"`
	ExpiresAt   string     `json:"expiresAt"`
	Access      *AccessReq `json:"access,omitempty"`
	Operation   Operation  `json:"operation"`
}

// Operation 审批关联的操作事实（参数、文件变更、资源声明与执行镜像）。
type Operation struct {
	ID                string                `json:"id"`
	Status            string                `json:"status"`
	ArgumentsJSON     string                `json:"argumentsJson"`
	Capability        Capability            `json:"capability"`
	FileChanges       []OperationFileChange `json:"fileChanges,omitempty"`
	ResourceClaims    []ResourceClaim       `json:"resourceClaims,omitempty"`
	Execution         *ExecutionPlan        `json:"execution,omitempty"`
	WorkspaceRevision int                   `json:"workspaceRevision"`
}

// Capability 操作能力描述（危险判定：Source builtin 且非只读、或目录 rw 授权）。
type Capability struct {
	Name         string `json:"name"`
	Source       string `json:"source"`
	ReadOnly     bool   `json:"readOnly"`
	OriginalName string `json:"originalName,omitempty"`
}

// OperationFileChange 文件变更（before/after 按摘要核对，文本内容存在时展示）。
type OperationFileChange struct {
	Path   string                `json:"path"`
	Before *OperationFileContent `json:"before,omitempty"`
	After  *OperationFileContent `json:"after,omitempty"`
}

type OperationFileContent struct {
	Bytes  *int    `json:"bytes,omitempty"`
	Digest string  `json:"digest"`
	Text   *string `json:"text,omitempty"`
}

// ResourceClaim 操作目标声明。
type ResourceClaim struct {
	Kind      string `json:"kind"`
	Authority string `json:"authority"`
	Key       string `json:"key"`
	Access    string `json:"access"`
	Subtree   bool   `json:"subtree,omitempty"`
}

// ExecutionPlan 执行镜像与授权（消费子集：镜像与目录/网络授权）。
type ExecutionPlan struct {
	Profile ExecutionProfile `json:"profile"`
	Grant   *ExecutionGrant  `json:"grant,omitempty"`
}

type ExecutionProfile struct {
	Image          string `json:"image"`
	Runtime        string `json:"runtime"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
	CPUMillis      int    `json:"cpuMillis"`
	MemoryBytes    int64  `json:"memoryBytes"`
	PIDs           int    `json:"pids"`
}

type ExecutionGrant struct {
	Name        string            `json:"name"`
	Directories []AccessDirectory `json:"directories"`
	Network     []AccessEndpoint  `json:"network"`
}

type AccessDirectory struct {
	Path   string `json:"path"`
	Access string `json:"access"`
}

type AccessEndpoint struct {
	Scheme string `json:"scheme"`
	Host   string `json:"host"`
	Port   int    `json:"port"`
}

// AccessReq 运行时授权申请：expectedRevision/expectedDigest 是幂等与并发裁决键。
type AccessReq struct {
	Revision       int               `json:"revision"`
	Digest         string            `json:"digest"`
	Kind           string            `json:"kind"`
	Reason         string            `json:"reason,omitempty"`
	SessionAllowed bool              `json:"sessionAllowed"`
	Directories    []AccessDirectory `json:"directories"`
	Network        []AccessEndpoint  `json:"network"`
	Runtime        *AccessRuntime    `json:"runtime,omitempty"`
}

type AccessRuntime struct {
	Name             string `json:"name"`
	Image            string `json:"image"`
	Platform         string `json:"platform"`
	RequiresDownload bool   `json:"requiresDownload"`
}

// AccessDecisionInput 运行时授权决定（once/denied；旧决定保留 session 兼容；requestId 与
// expectedRevision/expectedDigest 幂等重试）。
type AccessDecisionInput struct {
	RequestID        string `json:"requestId"`
	ExpectedRevision int    `json:"expectedRevision"`
	ExpectedDigest   string `json:"expectedDigest"`
	Decision         string `json:"decision"`
}

// PlanStep 计划步骤（pending/in_progress/completed，最多一个进行中）。
type PlanStep struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

// RunPlan 模型确认的计划快照（不代表外部操作已获授权或执行成功）。
type RunPlan struct {
	Revision  int        `json:"revision"`
	UpdatedAt string     `json:"updatedAt"`
	Steps     []PlanStep `json:"steps"`
}

// UserInputOption 单选题选项（推荐项不预选）。
type UserInputOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}

// UserInputQuestion 单选题（1–3 题、每题 2–3 项＋可选自定义文本）。
type UserInputQuestion struct {
	ID                  string            `json:"id"`
	Header              string            `json:"header"`
	Question            string            `json:"question"`
	Options             []UserInputOption `json:"options"`
	RecommendedOptionID string            `json:"recommendedOptionId,omitempty"`
}

// UserInputAnswer 单题答案：选项或自定义文本二选一。
type UserInputAnswer struct {
	OptionID string `json:"optionId,omitempty"`
	Text     string `json:"text,omitempty"`
}

// AnswerUserInputInput 回答提交（requestId 幂等）。
type AnswerUserInputInput struct {
	RequestID string                     `json:"requestId"`
	Answers   map[string]UserInputAnswer `json:"answers"`
}

// UserInputRequest 等待用户输入的问题组（timeline 条目 kind=user-input 携带）。
type UserInputRequest struct {
	ID        string              `json:"id"`
	RunID     string              `json:"runId"`
	Status    string              `json:"status"`
	Questions []UserInputQuestion `json:"questions"`
}

// UserInputReceipt 回答回执（问题组终态与恢复后的 Run）。
type UserInputReceipt struct {
	UserInput UserInputRequest `json:"userInput"`
	Run       Run              `json:"run"`
}

// Call 工具执行结果（按需分页读取）。
type Call struct {
	ID        string          `json:"id"`
	RunID     string          `json:"runId"`
	Tool      string          `json:"tool"`
	Status    string          `json:"status"`
	StartedAt string          `json:"startedAt,omitempty"`
	EndedAt   string          `json:"endedAt,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *Failure        `json:"error,omitempty"`
	Truncated bool            `json:"truncated"`
}

// ListApprovalsByRun 拉取运行的全部审批（pending/approved 优先；调用方过滤
// workflow-gate 与终态）。
func (c *Client) ListApprovalsByRun(ctx context.Context, runID string) ([]Approval, error) {
	var out []Approval
	_, err := c.do(ctx, "GET", "/api/agent/approvals", map[string]string{"runId": runID}, nil, &out, "")
	return out, err
}

// DecideApproval 普通审批决定（approved 重新排队恢复执行／denied 终态失败）。
func (c *Client) DecideApproval(ctx context.Context, id, decision string) (Approval, error) {
	body := struct {
		Decision string `json:"decision"`
	}{Decision: decision}
	var approval Approval
	_, err := c.do(ctx, "POST", "/api/agent/approvals/"+url.PathEscape(id)+"/decision", nil, body, &approval, "")
	return approval, err
}

// DecideAccess 运行时授权决定（once/denied；旧决定保留 session 兼容；幂等键防重复决定）。
func (c *Client) DecideAccess(ctx context.Context, id string, input AccessDecisionInput) (Approval, error) {
	var approval Approval
	_, err := c.do(ctx, "POST", "/api/agent/approvals/"+url.PathEscape(id)+"/access-decision", nil, input, &approval, "")
	return approval, err
}

// AnswerUserInput 回答等待输入的问题组（原子完成工具结果并重新入队原 Run）。
func (c *Client) AnswerUserInput(ctx context.Context, runID, inputID string, input AnswerUserInputInput) (UserInputReceipt, error) {
	var receipt UserInputReceipt
	_, err := c.do(ctx, "POST", "/api/agent/runs/"+url.PathEscape(runID)+"/user-inputs/"+url.PathEscape(inputID)+"/answer", nil, input, &receipt, "")
	return receipt, err
}

// ListCalls 工具执行结果分页（按需加载）。
func (c *Client) ListCalls(ctx context.Context, runID, cursor string) (Page[Call], error) {
	query := map[string]string{"limit": "100"}
	if cursor != "" {
		query["cursor"] = cursor
	}
	var page Page[Call]
	_, err := c.do(ctx, "GET", "/api/agent/runs/"+url.PathEscape(runID)+"/calls", query, nil, &page, "")
	return page, err
}
