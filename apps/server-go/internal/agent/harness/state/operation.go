package state

import (
	"encoding/json"
	"sort"
	"strings"
	"unicode"

	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

type RevisionRef struct {
	ID       string `json:"id"`
	Revision int    `json:"revision"`
	Digest   string `json:"digest,omitempty"`
}

type ResourceRef struct {
	ServerID string `json:"serverId"`
	URI      string `json:"uri"`
}

type PromptRef struct {
	ServerID  string          `json:"serverId"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type Environment struct {
	SessionID         string        `json:"sessionId"`
	Revision          int           `json:"revision"`
	Skills            []RevisionRef `json:"skills"`
	Servers           []RevisionRef `json:"servers"`
	Tools             []string      `json:"tools"`
	Resources         []ResourceRef `json:"resources"`
	ExecutionProfiles []RevisionRef `json:"executionProfiles"`
	Grants            []RevisionRef `json:"grants"`
	TrustedReadOnly   []string      `json:"trustedReadOnly"`
	ResourceRules     []RevisionRef `json:"resourceRules,omitempty"`
}

type Capability struct {
	SearchNames   []string        `json:"searchNames,omitempty"`
	Metadata      tools.Metadata  `json:"metadata,omitempty"`
	Name          string          `json:"name"`
	Description   string          `json:"description"`
	Parameters    json.RawMessage `json:"parameters"`
	Source        string          `json:"source"`
	Ref           RevisionRef     `json:"ref"`
	OriginalName  string          `json:"originalName,omitempty"`
	CatalogDigest string          `json:"catalogDigest,omitempty"`
	OutputSchema  json.RawMessage `json:"outputSchema,omitempty"`
	ReadOnly      bool            `json:"readOnly"`
}

func (c Capability) MarshalJSON() ([]byte, error) {
	type plain Capability
	var metadata *tools.Metadata
	if c.Metadata != (tools.Metadata{}) {
		value := c.Metadata
		metadata = &value
	}
	return json.Marshal(struct {
		plain
		Metadata *tools.Metadata `json:"metadata,omitempty"`
	}{plain(c), metadata})
}

type CapabilitySnapshot struct {
	RecoveryPolicy    string               `json:"recoveryPolicy,omitempty"`
	AuthorizationMode string               `json:"authorizationMode,omitempty"`
	Automatic         *AutomaticExtensions `json:"automatic,omitempty"`
	LoadingBudget     *LoadingBudget       `json:"loadingBudget,omitempty"`
	EagerTools        []string             `json:"eagerTools,omitempty"`
	PermissionMode    PermissionMode       `json:"permissionMode,omitempty"`
	PolicyVersion     string               `json:"policyVersion,omitempty"`
	ToolLoading       string               `json:"toolLoading,omitempty"`
	Environment       Environment          `json:"environment"`
	Tools             []Capability         `json:"tools"`
	Materials         []Capability         `json:"materials,omitempty"`
	SkillSummaries    []SkillSummary       `json:"skillSummaries,omitempty"`
	Profiles          []execconfig.Profile `json:"executionProfiles,omitempty"`
	Grants            []execconfig.Grant   `json:"grants,omitempty"`
	ResourceRules     []ResourceRule       `json:"resourceRules,omitempty"`
	Digest            string               `json:"digest"`
}

type SkillSummary struct {
	Ref         RevisionRef `json:"ref"`
	Name        string      `json:"name"`
	Description string      `json:"description"`
}

type ExecutionPlan struct {
	Profile      execconfig.Profile `json:"profile"`
	Grant        *execconfig.Grant  `json:"grant,omitempty"`
	ScriptDigest string             `json:"scriptDigest"`
}

type RecoveryCursor struct {
	ResponseID string `json:"responseId"`
	CallIndex  int    `json:"callIndex"`
}

type OperationFileContent struct {
	Bytes  *int    `json:"bytes,omitempty"`
	Digest string  `json:"digest"`
	Text   *string `json:"text,omitempty"`
}

type OperationFileChange struct {
	Path   string                `json:"path"`
	Before *OperationFileContent `json:"before,omitempty"`
	After  *OperationFileContent `json:"after,omitempty"`
}

type Operation struct {
	Recovery                *RunRecovery            `json:"recovery,omitempty"`
	Preparation             *RuntimePreparation     `json:"preparation,omitempty"`
	Access                  *AccessRequest          `json:"access,omitempty"`
	Authorization           *OperationAuthorization `json:"authorization,omitempty"`
	FileRoot                *FileRootIdentity       `json:"fileRoot,omitempty"`
	FileChanges             []OperationFileChange   `json:"fileChanges,omitempty"`
	Task                    *tools.TaskReference    `json:"task,omitempty"`
	PendingResult           json.RawMessage         `json:"pendingResult,omitempty"`
	TaskObservationFailedAt string                  `json:"taskObservationFailedAt,omitempty"`
	ResourceWait            *ResourceWait           `json:"resourceWait,omitempty"`
	ScopeID                 string                  `json:"scopeId,omitempty"`
	NodeID                  string                  `json:"nodeId,omitempty"`
	Source                  string                  `json:"source,omitempty"`
	WorkflowID              string                  `json:"workflowId,omitempty"`
	WorkflowStepID          string                  `json:"workflowStepId,omitempty"`
	WorkflowAttempt         int                     `json:"workflowAttempt,omitempty"`

	ID                string          `json:"id"`
	RunID             string          `json:"runId"`
	TaskID            string          `json:"taskId"`
	ModelRequestID    string          `json:"modelRequestId"`
	CallIndex         int             `json:"callIndex"`
	ModelCallID       string          `json:"modelCallId"`
	ArgumentsJSON     string          `json:"argumentsJson"`
	Capability        Capability      `json:"capability"`
	SnapshotDigest    string          `json:"snapshotDigest"`
	WorkspaceRevision int             `json:"workspaceRevision"`
	Execution         *ExecutionPlan  `json:"execution,omitempty"`
	ResourceClaims    []ResourceClaim `json:"resourceClaims,omitempty"`
	ResourceRules     []RevisionRef   `json:"resourceRules,omitempty"`
	ClaimsDigest      string          `json:"claimsDigest,omitempty"`
	Policy            string          `json:"policy"`
	PermissionMode    PermissionMode  `json:"permissionMode,omitempty"`
	PolicyVersion     string          `json:"policyVersion,omitempty"`
	DecisionSource    string          `json:"decisionSource,omitempty"`
	Status            string          `json:"status"`
	ApprovalID        string          `json:"approvalId,omitempty"`
	CallID            string          `json:"callId"`
	DispatchID        string          `json:"dispatchId,omitempty"`
	CreatedAt         string          `json:"createdAt"`
	DispatchedAt      string          `json:"dispatchedAt,omitempty"`
	EndedAt           string          `json:"endedAt,omitempty"`
	Error             *Failure        `json:"error,omitempty"`
}

type Approval struct {
	Access          *AccessRequest  `json:"access,omitempty"`
	AccessDecision  *AccessDecision `json:"accessDecision,omitempty"`
	ScopeID         string          `json:"scopeId,omitempty"`
	NodeID          string          `json:"nodeId,omitempty"`
	Kind            string          `json:"kind,omitempty"`
	WorkflowID      string          `json:"workflowId,omitempty"`
	WorkflowStepID  string          `json:"workflowStepId,omitempty"`
	WorkflowAttempt int             `json:"workflowAttempt,omitempty"`
	ContentDigest   string          `json:"contentDigest,omitempty"`
	Instruction     string          `json:"instruction,omitempty"`
	InputJSON       string          `json:"inputJson,omitempty"`

	ID          string    `json:"id"`
	RunID       string    `json:"runId"`
	OperationID string    `json:"operationId"`
	Status      string    `json:"status"`
	CreatedAt   string    `json:"createdAt"`
	ExpiresAt   string    `json:"expiresAt"`
	DecidedAt   string    `json:"decidedAt,omitempty"`
	Decision    string    `json:"decision,omitempty"`
	Operation   Operation `json:"operation"`
}

type ExecutionBarrier struct {
	ScopeID        string                    `json:"scopeId,omitempty"`
	NodeID         string                    `json:"nodeId,omitempty"`
	WorkflowID     string                    `json:"workflowId,omitempty"`
	ID             string                    `json:"id"`
	RunID          string                    `json:"runId"`
	OperationID    string                    `json:"operationId"`
	Status         string                    `json:"status"`
	CreatedAt      string                    `json:"createdAt"`
	Evidence       string                    `json:"evidence,omitempty"`
	Decision       string                    `json:"decision,omitempty"`
	ReconciledAt   string                    `json:"reconciledAt,omitempty"`
	Reconciliation *tools.TaskReconciliation `json:"reconciliation,omitempty"`
}

type ContextItem struct {
	ID        string      `json:"id"`
	RunID     string      `json:"runId"`
	TaskID    string      `json:"taskId"`
	Source    string      `json:"source"`
	Ref       RevisionRef `json:"ref"`
	Path      string      `json:"path,omitempty"`
	Digest    string      `json:"digest"`
	Content   string      `json:"content"`
	CreatedAt string      `json:"createdAt"`
	EventSeq  string      `json:"eventSeq"`
	CallID    string      `json:"callId,omitempty"`
}

func (s CapabilitySnapshot) ModelTools() []model.Tool {
	return s.VisibleModelTools(nil)
}

func (s CapabilitySnapshot) VisibleModelTools(loaded map[string]bool) []model.Tool {
	return s.VisibleModelToolsInOrder(loaded, nil)
}

// toolFixed 判定定义不依赖动态加载集合：常驻入口与 eager 内置定义始终在前，按目录顺序稳定排列。
func (s CapabilitySnapshot) ToolFixed(c Capability) bool {
	if ResidentCapability(c) {
		return true
	}
	return s.ToolLoading == OnDemandToolsV2 && Contains(s.EagerTools, c.Name)
}

// visibleModelToolsInOrder 按“常驻与 eager 稳定前缀 + 动态定义尾部追加”返回最终可见定义。
// tool_search 新增定义只追加到尾部、淘汰只移除尾部集合，已加载定义保持加载顺序；
// 供应商自动前缀缓存（DeepSeek、智谱要求完全一致前缀）不会因一次动态加载打断整个工具段。
// order 为空时动态定义按快照目录顺序追加，保证重启、旧快照与未记录加载顺序时输出确定。
func (s CapabilitySnapshot) VisibleModelToolsInOrder(loaded map[string]bool, order []string) []model.Tool {
	if s.ToolLoading != OnDemandTools && s.ToolLoading != OnDemandToolsV2 {
		out := make([]model.Tool, 0, len(s.Tools))
		for _, c := range s.Tools {
			out = append(out, model.Tool{Name: c.Name, Description: c.Description, Parameters: c.Parameters})
		}
		return out
	}
	// on-demand/v1 保持旧快照原有的按目录顺序过滤语义，不引入 v2 的分组重排。
	if s.ToolLoading == OnDemandTools {
		out := make([]model.Tool, 0, len(s.Tools))
		for _, c := range s.Tools {
			if !ResidentCapability(c) && !loaded[c.Name] {
				continue
			}
			out = append(out, model.Tool{Name: c.Name, Description: c.Description, Parameters: c.Parameters})
		}
		return out
	}
	fixed := make([]model.Tool, 0, len(s.Tools))
	dynamic := make(map[string]model.Tool, len(order))
	for _, c := range s.Tools {
		if s.ToolLoading == OnDemandToolsV2 && !s.ToolFixed(c) && !loaded[c.Name] {
			continue
		}
		if s.ToolLoading == OnDemandTools && !ResidentCapability(c) && !loaded[c.Name] {
			continue
		}
		tool := model.Tool{Name: c.Name, Description: c.Description, Parameters: c.Parameters}
		if s.ToolFixed(c) {
			fixed = append(fixed, tool)
			continue
		}
		dynamic[c.Name] = tool
	}
	added := make(map[string]bool, len(dynamic))
	for _, name := range order {
		tool, ok := dynamic[name]
		if !ok || added[name] {
			continue
		}
		added[name] = true
		fixed = append(fixed, tool)
	}
	// 没有加载顺序记录的动态定义按快照目录顺序兜底，输出与进程重启无关。
	for _, c := range s.Tools {
		tool, ok := dynamic[c.Name]
		if !ok || added[c.Name] {
			continue
		}
		added[c.Name] = true
		fixed = append(fixed, tool)
	}
	return fixed
}

// FileRootIdentity is supplied by the injected file-domain seam and rechecked at dispatch.
type FileRootIdentity struct {
	Path     string `json:"path"`
	Writable bool   `json:"writable"`
	Device   uint64 `json:"device"`
	Inode    uint64 `json:"inode"`
}

// AccessRequest is a proposal owned by the harness, never authority supplied by a model.
type AccessRequest struct {
	Revision       int                          `json:"revision"`
	Digest         string                       `json:"digest"`
	ScopeKey       string                       `json:"scopeKey"`
	Kind           string                       `json:"kind"`
	Directories    []execconfig.Directory       `json:"directories"`
	Network        []execconfig.NetworkEndpoint `json:"network"`
	PrivateCIDRs   []string                     `json:"privateCidrs"`
	Resources      []execconfig.Resource        `json:"resources"`
	Runtime        *AccessRuntime               `json:"runtime,omitempty"`
	SessionAllowed bool                         `json:"sessionAllowed"`
	Reason         string                       `json:"reason,omitempty"`
}

type AccessRuntime struct {
	Name             string `json:"name"`
	Image            string `json:"image"`
	Platform         string `json:"platform"`
	RequiresDownload bool   `json:"requiresDownload"`
}

type AccessDecision struct {
	RequestID        string `json:"requestId"`
	ExpectedRevision int    `json:"expectedRevision"`
	ExpectedDigest   string `json:"expectedDigest"`
	Decision         string `json:"decision"`
}

type OperationAuthorization struct {
	ID                     string `json:"id"`
	Digest                 string `json:"digest"`
	Decision               string `json:"decision"`
	SessionAuthorizationID string `json:"sessionAuthorizationId,omitempty"`
	CreatedAt              string `json:"createdAt"`
}

type SessionAuthorization struct {
	ExecutionProfile *execconfig.Profile `json:"executionProfile,omitempty"`
	ID               string              `json:"id"`
	SessionID        string              `json:"sessionId"`
	Revision         int                 `json:"revision"`
	Status           string              `json:"status"`
	CreatedAt        string              `json:"createdAt"`
	RevokedAt        string              `json:"revokedAt,omitempty"`
	RevokeRequestID  string              `json:"revokeRequestId,omitempty"`
	Tool             string              `json:"tool"`
	Access           AccessRequest       `json:"access"`
}

type RevokeAuthorizationInput struct {
	RequestID        string `json:"requestId"`
	ExpectedRevision int    `json:"expectedRevision"`
}

type RuntimePreparation struct {
	State   string `json:"state"`
	Current int64  `json:"current,omitempty"`
	Total   int64  `json:"total,omitempty"`
	Error   string `json:"error,omitempty"`
}

// ResourceClaim 的资源身份不包含规则修订；同一资源在配置更新后仍相互冲突。
type ResourceClaim struct {
	Kind      string `json:"kind"`
	Authority string `json:"authority"`
	Key       string `json:"key"`
	Access    string `json:"access"`
	Subtree   bool   `json:"subtree,omitempty"`
}

type ResourceSelector struct {
	Source        string      `json:"source"`
	Ref           RevisionRef `json:"ref"`
	OriginalName  string      `json:"originalName,omitempty"`
	CatalogDigest string      `json:"catalogDigest,omitempty"`
}

type ResourceMapping struct {
	Kind      string  `json:"kind"`
	Authority string  `json:"authority"`
	Access    string  `json:"access"`
	Subtree   bool    `json:"subtree,omitempty"`
	Literal   *string `json:"literal,omitempty"`
	Pointer   *string `json:"pointer,omitempty"`
}

type ResourceRuleInput struct {
	Name     string            `json:"name"`
	Enabled  bool              `json:"enabled"`
	Complete bool              `json:"complete"`
	Selector ResourceSelector  `json:"selector"`
	Mappings []ResourceMapping `json:"mappings"`
}

type ResourceRule struct {
	ResourceRuleInput
	ID        string `json:"id"`
	Revision  int    `json:"revision"`
	Digest    string `json:"digest"`
	CreatedAt string `json:"createdAt"`
}

type ResourceLease struct {
	Probe          *ProbeAccessRequest `json:"probe,omitempty"`
	Source         string              `json:"source,omitempty"`
	ServerID       string              `json:"serverId,omitempty"`
	ServerRevision int                 `json:"serverRevision,omitempty"`
	ContainerID    string              `json:"containerId,omitempty"`
	ID             string              `json:"id"`
	RunID          string              `json:"runId,omitempty"`
	OperationID    string              `json:"operationId,omitempty"`
	ScopeID        string              `json:"scopeId"`
	State          string              `json:"state"`
	Claims         []ResourceClaim     `json:"claims"`
	CreatedAt      string              `json:"createdAt"`
	EndedAt        string              `json:"endedAt,omitempty"`
	Evidence       string              `json:"evidence,omitempty"`
	Decision       string              `json:"decision,omitempty"`
}

// ResourceWait is a bounded explanation, not a new resource authorization.
type ResourceWait struct {
	Resource       string `json:"resource"`
	RunID          string `json:"runId,omitempty"`
	OperationID    string `json:"operationId,omitempty"`
	Since          string `json:"since"`
	ElapsedSeconds int    `json:"elapsedSeconds"`
	Message        string `json:"message"`
	Unknown        bool   `json:"unknown"`
}

type LoadingBudget struct {
	Estimator            string `json:"estimator"`
	SkillIndexTokens     int    `json:"skillIndexTokens"`
	ToolDefinitionTokens int    `json:"toolDefinitionTokens"`
	SkillBodyTokens      int    `json:"skillBodyTokens"`
}

func (s CapabilitySnapshot) ResidentDefinitionTokens() int {
	count := 0
	for _, c := range s.Tools {
		if ResidentCapability(c) || Contains(s.EagerTools, c.Name) {
			count += DefinitionTokens(c)
		}
	}
	return count
}

// 目录仅用于排序，未展示项仍在不可变目录中，可被搜索。
func (s CapabilitySnapshot) SkillIndex(input string) json.RawMessage {
	if s.ToolLoading != OnDemandToolsV2 || s.LoadingBudget == nil {
		raw, _ := json.Marshal(s.SkillSummaries)
		return raw
	}
	type entry struct {
		Name        string `json:"name"`
		Revision    int    `json:"revision"`
		Description string `json:"description"`
	}
	type candidate struct {
		entry entry
		score int
		id    string
	}
	candidates := []candidate{}
	terms := SearchTerms(strings.ToLower(input))
	for _, skill := range s.SkillSummaries {
		score := 0
		for _, term := range terms {
			if strings.Contains(strings.ToLower(skill.Name), term) {
				score += 20
			}
			if strings.Contains(strings.ToLower(skill.Description), term) {
				score += 4
			}
		}
		description := []rune(skill.Description)
		if len(description) > 160 {
			description = description[:160]
		}
		candidates = append(candidates, candidate{entry{skill.Name, skill.Ref.Revision, string(description)}, score, skill.Ref.ID})
	}
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].score != candidates[j].score {
			return candidates[i].score > candidates[j].score
		}
		return candidates[i].id < candidates[j].id
	})
	entries := []entry{}
	raw := json.RawMessage(`[]`)
	for _, c := range candidates {
		next, _ := json.Marshal(append(entries, c.entry))
		if EstimateContextText(string(next)) > s.LoadingBudget.SkillIndexTokens {
			continue
		}
		entries = append(entries, c.entry)
		raw = next
	}
	return raw
}

const OnDemandToolsV2 = "on-demand/v2"

func ResidentCapability(c Capability) bool {
	return c.Source == ToolDiscoverySource || c.Source == UserInputSource || c.Source == PlanSource || c.Source == TaskHistorySource
}

func DefinitionTokens(c Capability) int {
	return EstimateContextText(c.Name) + EstimateContextText(c.Description) + EstimateContextText(string(c.Parameters)) + 8
}

func (s CapabilitySnapshot) ToolInventory() ToolInventory {
	result := ToolInventory{Domains: map[string]int{}, Notes: map[string]string{}}
	for _, c := range s.Tools {
		if c.Source == ToolDiscoverySource || c.Source == UserInputSource || c.Source == PlanSource || c.Source == TaskHistorySource {
			continue
		}
		domain := c.Metadata.Domain
		if domain == "" {
			domain = c.Source
		}
		result.Total++
		result.Domains[domain]++
	}
	for domain := range result.Domains {
		if note, ok := DomainBoundaries[domain]; ok {
			result.Notes[domain] = note
		}
	}
	return result
}

// DomainBoundaries 是各域能力的固定边界说明，供模型判断某项能力是否存在，避免在目录中
// 反复搜索不提供的能力。只写领域级能力与不提供的能力，不含工具名或描述明细；未登记的域只报数量。
var DomainBoundaries = map[string]string{
	"workspace":     "任务工作区文件清单与文本读写",
	"docker":        "本机容器和镜像、详情与日志、服务创建及启停删除、受控容器内执行；受管数据库登记、逻辑库与诊断共用 Docker 入口；不含逐容器资源统计（stats）",
	"database":      "受管数据库实例与逻辑库的登记、状态、固定指标与写操作",
	"files":         "面板文件页的文件与目录读写",
	"security":      "SSH 状态、账号、登录记录与密钥指纹",
	"firewall":      "防火墙规则、连接与统计快照、业务端口放行",
	"logs":          "平台日志读取",
	"platform":      "面板进程内存、本机内存/CPU 使用率/负载/磁盘挂载采样、Docker 与 Caddy 依赖状态",
	"panel":         "面板自身信息与上游更新检查",
	"website":       "网站项目的登记、运行时版本、来源分析、部署与启停",
	"web":           "公网 URL 的 HTML、纯文本、Markdown 与 JSON 读取；正文有界截断，不执行 JavaScript、不登录、不访问内网、不读取 PDF、不提供搜索引擎",
	"container-app": "容器应用工作区与镜像构建",
	"skill-load":    "已选技能的资料加载",
	"mcp-tool":      "已接入 MCP 工具的搜索与调用",
	"mcp-resource":  "MCP 资源读取",
	"wiki":          "知识库页面检索",
	"script":        "技能脚本执行（非只读）",
	"bash":          "受控命令执行（非只读）",
}

func SearchTerms(query string) []string {
	terms := map[string]bool{query: true}
	for _, token := range strings.FieldsFunc(query, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		terms[token] = true
		// 中文不依赖分词服务；连续汉字二元组支持自然语言中的领域和动作。
		runes := []rune(token)
		for i := 0; i+1 < len(runes); i++ {
			if unicode.Is(unicode.Han, runes[i]) && unicode.Is(unicode.Han, runes[i+1]) {
				terms[string(runes[i:i+2])] = true
			}
		}
	}
	result := make([]string, 0, len(terms))
	for term := range terms {
		result = append(result, term)
	}
	sort.Strings(result)
	return result
}

type ToolInventory struct {
	Total   int               `json:"total"`
	Domains map[string]int    `json:"domains"`
	Notes   map[string]string `json:"notes"`
}

const ToolDiscoverySource = "tool-discovery"
const OnDemandTools = "on-demand/v1"

type PermissionMode string

const (
	PermissionAsk           PermissionMode = "ask"
	PermissionAssist        PermissionMode = "assist"
	PermissionFull          PermissionMode = "full"
	PermissionPolicyVersion                = "permission-modes/v2"
)

// ProbeAccessRequest lives in the existing lease document and JSONL ledger.
// Pending requests hold no resources. Accepting one atomically claims its
// unique lease, so a retry or a restart can never launch a second probe.
type ProbeAccessRequest struct {
	ID                string                        `json:"id"`
	Version           int                           `json:"version"`
	RequestID         string                        `json:"requestId"`
	ServerID          string                        `json:"serverId"`
	ServerRevision    int                           `json:"serverRevision"`
	ServerName        string                        `json:"serverName"`
	State             string                        `json:"state"`
	Digest            string                        `json:"digest"`
	CreatedAt         string                        `json:"createdAt"`
	Access            AccessRequest                 `json:"access"`
	Command           []string                      `json:"command"`
	Environment       *execution.RuntimeEnvironment `json:"environment,omitempty"`
	Progress          *execution.RuntimeProgress    `json:"progress,omitempty"`
	Error             string                        `json:"error,omitempty"`
	Catalog           *MCPCatalogProjection         `json:"catalog,omitempty"`
	DecisionRequestID string                        `json:"decisionRequestId,omitempty"`
	Decision          string                        `json:"decision,omitempty"`
	CancelRequestID   string                        `json:"cancelRequestId,omitempty"`
}
type MCPCatalogProjection struct {
	mcp.Catalog
	ModelAliases    map[string]string `json:"modelAliases"`
	ResourceAliases map[string]string `json:"resourceAliases"`
	PromptAliases   map[string]string `json:"promptAliases"`
}

type ExtensionUnavailable struct {
	Kind     string `json:"kind"`
	ID       string `json:"id,omitempty"`
	Revision int    `json:"revision,omitempty"`
	Code     string `json:"code"`
	Reason   string `json:"reason"`
}

type AutomaticExtensions struct {
	Source      string                 `json:"source"`
	Skills      []RevisionRef          `json:"skills"`
	Servers     []RevisionRef          `json:"servers"`
	Unavailable []ExtensionUnavailable `json:"unavailable"`
}

func Contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
