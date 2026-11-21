// 本文件集中运行与恢复共用的事实校验和投影；不进行存储访问或外部派发。
package state

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/tools"
)

const (
	StateWaitingInput          = "waiting-input"
	StateWaitingApproval       = "waiting-approval"
	StateWaitingResource       = "waiting-resource"
	StateWaitingTask           = "waiting-task"
	StateWaitingRecovery       = "waiting-recovery"
	StateRecoveryRequired      = "recovery-required"
	WorkflowV2LanguageVersion  = "workflow/v2"
	continuousBudgetPolicy     = "resource-budget/v2"
	evidenceRecoveryPolicy     = "evidence-recovery/v1"
	continuousRecoveryPolicy   = "evidence-recovery/v2"
	recoveryWindow             = 2 * time.Minute
	maxImageAttachmentSetBytes = 8 * 1024 * 1024
	toolDiscoverySource        = ToolDiscoverySource
)

// imageLimitLabel 把字节限额渲染成中文可读文案：整 MiB 用 MiB，否则按字节。
func ImageLimitLabel(bytes int) string {
	if bytes > 0 && bytes%1048576 == 0 {
		return fmt.Sprintf("%d MiB", bytes/1048576)
	}
	return fmt.Sprintf("%d 字节", bytes)
}

// validateAttachmentSet 按 Limits 复检附件集合：张数、单文件字节与总字节。
// 附件行上传后不可变，提交侧复检无竞态，堵住分批上传攒出超限集合再一次提交的绕过；
// 张数为 0 表示不限制数量；旧快照总量为 0 表示不设置独立总量限制。
func ValidateAttachmentSet(rows []AttachmentRecord, limits Limits) error {
	if len(rows) == 0 {
		return nil
	}
	if limits.ImageCountPerMessage > 0 && len(rows) > limits.ImageCountPerMessage {
		return Bad("attachment-too-many", "一条消息最多 "+fmt.Sprint(limits.ImageCountPerMessage)+" 张图片")
	}
	total := 0
	for _, row := range rows {
		if limits.ImageBytesPerFile > 0 && row.Bytes > limits.ImageBytesPerFile {
			return Bad("attachment-too-large", "单张图片不能超过 "+ImageLimitLabel(limits.ImageBytesPerFile)+"。")
		}
		total += row.Bytes
	}
	if limits.ImageBytesPerMessage > 0 && total > limits.ImageBytesPerMessage {
		if limits.ImageBytesPerMessage == maxImageAttachmentSetBytes {
			return Bad("attachment-message-too-large", "本条消息附件合计超过 8 MiB，请分批发送。")
		}
		return Bad("attachment-message-too-large", "图片总大小不能超过 "+ImageLimitLabel(limits.ImageBytesPerMessage)+"，请分批发送。")
	}
	return nil
}

func ContinuousRun(r Run) bool {
	return r.BudgetPolicy == continuousBudgetPolicy && r.SessionID != "" && r.WorkflowID == "" && r.DriverVersion == "v2"
}

func BudgetTerminalText(r Run) string {
	label := map[string]string{"tokens": "本轮 token 额度", "active-time": "本轮活动时间", "results": "本轮结果容量"}[r.BudgetStop.Resource]
	text := "本轮额度已用完，进度已保存。\n\n原因：" + label + "已达到边界。"
	if r.Plan != nil {
		completed := 0
		var pending []string
		for _, step := range r.Plan.Steps {
			if step.Status == "completed" {
				completed++
			} else {
				pending = append(pending, step.Title)
			}
		}
		text += fmt.Sprintf("\n\n已保存的计划：%d/%d 步标记完成。", completed, len(r.Plan.Steps))
		if len(pending) > 0 {
			text += "\n\n待处理：" + strings.Join(pending, "；") + "。"
		}
	}
	return text + "\n\n可在原会话继续任务；结果未知的操作须先核实。"
}

func BudgetContinuationCandidate(r Run) bool {
	if r.SessionID == "" || r.WorkflowID != "" || r.CancelRequestedAt != "" || r.SupersededByRunID != "" || (r.Status != StateFailed && r.Status != StateInterrupted) {
		return false
	}
	if EvidenceRecoveryRun(r) {
		return true
	}
	if r.BudgetStop != nil {
		return true
	}
	if r.Status == StateInterrupted && (r.EndReason == "outcome-unknown" || r.EndReason == "resource-outcome-unknown") {
		return true
	}
	reason := r.EndReason
	if r.Error != nil {
		reason = r.Error.Code
	}
	switch reason {
	case "no-progress", "recovery-exhausted", "call-budget", "call-limit", "model-budget", "token-budget", "run-timeout", "result-budget", "panel-update":
		return true
	}
	return false
}

func DigestJSON(v any) string {
	b, _ := json.Marshal(v)
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func NextSeq(s string) string { n, _ := strconv.ParseInt(s, 10, 64); return strconv.FormatInt(n+1, 10) }

// ChatOutput 是可替换的展示快照，最终消息仍以 Messages 为准。
type ChatOutput struct {
	RunID      string                `json:"runId"`
	ResponseID string                `json:"responseId"`
	Reasoning  string                `json:"reasoning"`
	Content    string                `json:"content"`
	Done       bool                  `json:"done"`
	Timeline   *ChatTimelineSnapshot `json:"timeline,omitempty"`
}

func ProjectChatOutput(run Run, records []ModelRequestRecord) ChatOutput {
	out := ChatOutput{RunID: run.ID, Done: Terminal(run.Status)}
	var reasoning []string
	for _, record := range records {
		if record.Purpose != "inference" {
			continue
		}
		out.ResponseID, out.Content = record.ID, ""
		if record.Status == StateRunning || record.Status == StateCancelled {
			reasoning = append(reasoning, record.Reasoning)
			out.Content = record.Content
		} else if record.Response != nil {
			reasoning = append(reasoning, record.Response.Reasoning)
			if len(record.Response.ToolCalls) == 0 && record.Response.FinishReason == "stop" {
				out.Content = record.Response.Content
			}
		}
	}
	out.Reasoning = strings.TrimSpace(strings.Join(reasoning, "\n\n"))
	if out.Done && run.Status != StateSucceeded && run.Status != StateCancelled {
		out.Content = ""
	}
	return out
}

type ChatTimelineEntry struct {
	Attempts       []ToolAttempt       `json:"attempts,omitempty"`
	UserInput      *UserInputRequest   `json:"userInput,omitempty"`
	ID             string              `json:"id"`
	Kind           string              `json:"kind"`
	ModelRequestID string              `json:"modelRequestId"`
	RequestIndex   int                 `json:"requestIndex"`
	StartedAt      string              `json:"startedAt"`
	EndedAt        string              `json:"endedAt,omitempty"`
	Status         string              `json:"status"`
	Text           string              `json:"text,omitempty"`
	Incomplete     bool                `json:"incomplete"`
	Tool           string              `json:"tool,omitempty"`
	ModelCallID    string              `json:"modelCallId,omitempty"`
	CallIndex      int                 `json:"callIndex"`
	ArgumentsJSON  string              `json:"argumentsJson,omitempty"`
	CallID         string              `json:"callId,omitempty"`
	Error          *Failure            `json:"error,omitempty"`
	Truncated      bool                `json:"truncated"`
	Progress       *tools.TaskProgress `json:"progress,omitempty"`
	ResourceWait   *ResourceWait       `json:"resourceWait,omitempty"`
}

type ChatContextUsage struct {
	ModelRequestID     string                  `json:"modelRequestId"`
	Model              string                  `json:"model"`
	TotalTokens        *int                    `json:"totalTokens,omitempty"`
	ContextTokens      int                     `json:"contextTokens"`
	EstimatedBreakdown *model.ContextBreakdown `json:"estimatedBreakdown,omitempty"`
}

type ChatCacheHitUsage struct {
	InputTokens  int `json:"inputTokens"`
	CachedTokens int `json:"cachedTokens"`
}

type ChatTimelineSnapshot struct {
	Wait             *RunWait            `json:"wait,omitempty"`
	BlockingRecovery []BlockingRecovery  `json:"blockingRecovery"`
	Recovery         *RunRecovery        `json:"recovery,omitempty"`
	RecoveryPolicy   string              `json:"recoveryPolicy,omitempty"`
	BudgetPolicy     string              `json:"budgetPolicy,omitempty"`
	BudgetStop       *BudgetStop         `json:"budgetStop,omitempty"`
	Continuation     *Continuation       `json:"continuation,omitempty"`
	TerminalResult   *TerminalResult     `json:"terminalResult,omitempty"`
	Plan             *RunPlan            `json:"plan,omitempty"`
	RunID            string              `json:"runId"`
	Status           string              `json:"status"`
	Done             bool                `json:"done"`
	Error            *Failure            `json:"error,omitempty"`
	Usage            Usage               `json:"usage"`
	ContextUsage     *ChatContextUsage   `json:"contextUsage,omitempty"`
	CacheHitUsage    *ChatCacheHitUsage  `json:"cacheHitUsage,omitempty"`
	FinalResponseID  string              `json:"finalResponseId,omitempty"`
	Entries          []ChatTimelineEntry `json:"entries"`
}

func RandomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("系统随机源不可用")
	}
	return hex.EncodeToString(b[:])
}

// approvedOperationMatches preserves pre-v5 approvals without claiming that
// administrators approved resource metadata that did not exist at that time.
// The caller independently derives and validates these three scheduling fields
// from the immutable Run snapshot. Every original approval field still has to
// match exactly; the persisted Approval.Operation is never rewritten.
func ApprovedOperationMatches(approved, current Operation) bool {
	// Waiting is an observation before dispatch, not a change to the approved operation.
	if current.Status == StateWaitingResource && current.DispatchID == "" && current.DispatchedAt == "" && approved.Status == StateWaitingApproval {
		current.Status = approved.Status
		current.ResourceWait = approved.ResourceWait
	}
	if approved.Access != nil {
		current.Authorization = approved.Authorization
		current.Preparation = approved.Preparation
	}
	if approved.ClaimsDigest == "" {
		if len(approved.ResourceClaims) != 0 || len(approved.ResourceRules) != 0 {
			return false // A partially declared claim is not a legacy approval.
		}
		current.ResourceClaims = nil
		current.ResourceRules = nil
		current.ClaimsDigest = ""
	}
	return DigestJSON(approved) == DigestJSON(current)
}

func PageSize(n, def int) (int, error) {
	if n == 0 {
		return def, nil
	}
	if n < 1 || n > 200 {
		return 0, &Error{Status: 400, Code: "invalid-page", Message: "每页条数必须在 1 到 200 之间"}
	}
	return n, nil
}

func NumberCursor(raw string) (int64, error) {
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 || strconv.FormatInt(n, 10) != raw {
		return 0, &Error{Status: 400, Code: "invalid-cursor", Message: "分页游标无效"}
	}
	return n, nil
}

func ValidState(s string) bool {
	if s == StateWaitingInput || s == StateWaitingApproval || s == StateWaitingResource || s == StateWaitingTask || s == StateWaitingRecovery || s == StateWaitingModel || s == StateWaitingStorage || s == StateRecoveryRequired {
		return true
	}
	switch s {
	case StateQueued, StateRunning, StateSucceeded, StateFailed, StateCancelled, StateInterrupted:
		return true
	}
	return false
}

func Terminal(s string) bool {
	return s == StateSucceeded || s == StateFailed || s == StateCancelled || s == StateInterrupted
}

func SupportedRecoveryPolicy(policy string) bool {
	return policy == evidenceRecoveryPolicy || policy == continuousRecoveryPolicy
}

func EvidenceRecoveryRun(r Run) bool {
	return SupportedRecoveryPolicy(r.RecoveryPolicy) && r.SessionID != "" && r.WorkflowID == "" && r.DriverVersion == "v2"
}

func BeginRecovery(r *Run, o *Operation, now time.Time) {
	if o.Recovery == nil {
		o.Recovery = &RunRecovery{OperationID: o.ID, Tool: o.Capability.Name, StartedAt: Stamp(now), Deadline: Stamp(now.Add(recoveryWindow)), Status: "verifying", Message: "正在核实操作是否结束及实际变更，期间不重复提交"}
	}
	r.Status, r.Phase = StateWaitingRecovery, StateWaitingRecovery
	r.Recovery = o.Recovery
}

func ResourceClaimsConflict(a, b ResourceClaim) bool {
	if a.Kind == "global" || b.Kind == "global" {
		return true
	}
	if a.Access == "read" && b.Access == "read" {
		return false
	}
	if a.Kind != b.Kind || a.Authority != b.Authority {
		return false
	}
	if a.Key == b.Key {
		return true
	}
	within := func(parent, child string) bool {
		return parent == "/" || strings.HasPrefix(child, parent+"/")
	}
	return a.Subtree && within(a.Key, b.Key) || b.Subtree && within(b.Key, a.Key)
}

func ResourceSetsConflict(a, b []ResourceClaim) bool {
	for _, left := range a {
		for _, right := range b {
			if ResourceClaimsConflict(left, right) {
				return true
			}
		}
	}
	return false
}

func ExternalOperation(o Operation) bool {
	if o.Capability.Source == "builtin" {
		return !o.Capability.ReadOnly
	}
	// Workspace reads/writes are committed through the task workspace CAS in
	// the same parent transaction, so they do not represent an external system
	// side effect. A workspace write still gets a barrier from ReadOnly=false;
	// reads must not become unknown external operations on cancellation.
	return o.Capability.Source != "builtin" && o.Capability.Source != "skill-load" && o.Capability.Source != "wiki" && o.Capability.Source != "workspace" && o.Capability.Source != toolDiscoverySource
}

func ResourceWaitConflict(o Operation, lease ResourceLease) (string, bool) {
	for _, a := range o.ResourceClaims {
		for _, b := range lease.Claims {
			if ResourceClaimsConflict(a, b) {
				resource := b.Kind + ":" + b.Authority + ":" + b.Key
				if len(resource) > 512 {
					resource = resource[:512]
				}
				return resource, true
			}
		}
	}
	return "external:*", false
}

func ResourceWaitSnapshot(wait *ResourceWait, endedAt string) *ResourceWait {
	if wait == nil {
		return nil
	}
	copy := *wait
	if since, err := time.Parse(time.RFC3339Nano, copy.Since); err == nil {
		until := time.Now()
		if ended, err := time.Parse(time.RFC3339Nano, endedAt); err == nil {
			until = ended
		}
		copy.ElapsedSeconds = max(0, int(until.Sub(since).Seconds()))
	}
	return &copy
}

func AccessDigest(o Operation) string {
	if o.Access == nil {
		return ""
	}
	a := *o.Access
	a.Digest = ""
	return DigestJSON(struct {
		ID, RunID, Arguments, Snapshot string
		Capability                     Capability
		Execution                      *ExecutionPlan
		FileRoot                       *FileRootIdentity
		Access                         AccessRequest
	}{o.ID, o.RunID, o.ArgumentsJSON, o.SnapshotDigest, o.Capability, o.Execution, o.FileRoot, a})
}

func WorkflowScopeStep(scope WorkflowScope, id string) (WorkflowStepDefinition, error) {
	return WorkflowStep(WorkflowDefinition{Steps: scope.Body.Steps}, id)
}

func WorkflowV2(w WorkflowInstance) bool { return w.LanguageVersion == WorkflowV2LanguageVersion }

func DefinitionBody(d WorkflowDefinition) WorkflowBody {
	return WorkflowBody{Entry: d.Entry, Steps: d.Steps, OutputSchemaJSON: d.OutputSchemaJSON}
}

func ReportStage(phase string) string {
	switch phase {
	case "queued":
		return "等待执行"
	case "inference", "model", "thinking":
		return "模型分析与方案执行"
	case "executing", "tool", "calling":
		return "工具执行"
	case StateWaitingModel:
		return "等待模型通道恢复"
	case StateWaitingStorage:
		return "等待记录同步恢复"
	case StateWaitingApproval:
		return "等待操作确认"
	case StateWaitingInput:
		return "等待用户补充"
	case StateWaitingTask:
		return "等待后台操作结束"
	case StateWaitingResource:
		return "等待资源释放"
	case StateWaitingRecovery, "recovering":
		return "核实执行结果"
	case "memory", "checkpoint", "consolidating":
		return "整理执行上下文"
	case "policy-frozen":
		return "兼容版本保护"
	default:
		return "任务结果核对与收尾"
	}
}

// toolExecutionFact 同时供时间线和模型上下文投影使用；缺少回执不等于已派发。
type ToolExecutionFact struct {
	Status       string
	StartedAt    string
	EndedAt      string
	Error        *Failure
	ResourceWait *ResourceWait
}

func ProjectToolExecution(run Run, operation *Operation, call *Call, approval *Approval) ToolExecutionFact {
	fact := ToolExecutionFact{Status: "planned"}
	if operation != nil {
		waitEndedAt := operation.EndedAt
		if Terminal(run.Status) {
			waitEndedAt = run.EndedAt
		}
		fact.ResourceWait = ResourceWaitSnapshot(operation.ResourceWait, waitEndedAt)
		fact.Status, fact.Error = operation.Status, operation.Error
		fact.StartedAt, fact.EndedAt = operation.CreatedAt, operation.EndedAt
		switch operation.Status {
		case "dispatched":
			fact.Status = StateRunning
		case "completed":
			fact.Status = "unknown" // 接受或完成标记不能替代实际回执。
		}
	}
	if call != nil {
		fact.StartedAt, fact.EndedAt, fact.Error = call.StartedAt, call.EndedAt, call.Error
		if operation == nil || (operation.Status != StateWaitingTask && operation.Status != StateWaitingResource && operation.Status != "unknown") {
			fact.Status = call.Status
		}
		if fact.Status == StateInterrupted || fact.Status == StateRecoveryRequired || Terminal(run.Status) && !Terminal(fact.Status) {
			fact.Status = "unknown"
		}
		return fact
	}
	// 派发身份优先于过期的审批或计划状态，不能把未知外部结果降为未执行。
	dispatched := operation != nil && (operation.DispatchID != "" || operation.DispatchedAt != "" || operation.Status == "dispatched" || operation.Status == "unknown" || operation.Status == "completed" || operation.Status == StateWaitingTask)
	if dispatched {
		if Terminal(run.Status) {
			fact.Status = "unknown"
		}
		return fact
	}
	if approval != nil {
		switch approval.Status {
		case "denied", "expired", "revoked":
			fact.Status, fact.EndedAt = approval.Status, approval.DecidedAt
			return fact
		}
	}
	if Terminal(run.Status) && (operation == nil || operation.Status == "planned" || operation.Status == StateWaitingApproval || operation.Status == StateWaitingResource) {
		fact.Status = "not-executed"
	}
	return fact
}

func ToolFactContent(fact ToolExecutionFact, call *Call) string {
	var value any
	switch fact.Status {
	case "not-executed":
		value = map[string]any{"error": Failure{Code: "tool-not-executed", Message: "运行已结束，该工具提议未派发、未执行"}, "resourceWait": fact.ResourceWait}
	case StateWaitingResource:
		value = map[string]any{"error": Failure{Code: "resource-waiting", Message: "等待资源，该工具未派发、未执行"}, "resourceWait": fact.ResourceWait}
	case "denied", "expired", "revoked":
		value = map[string]any{"error": Failure{Code: "tool-" + fact.Status, Message: "该工具提议未获有效批准，未执行"}}
	default:
		if call != nil && Terminal(call.Status) && fact.Status != "unknown" {
			if call.Error != nil {
				value = map[string]any{"error": call.Error, "result": call.Result}
			} else {
				value = map[string]any{"result": call.Result, "truncated": call.Truncated}
				if call.Evidence != nil {
					value.(map[string]any)["evidence"] = call.Evidence
				}
			}
		} else {
			unknown := map[string]any{"error": Failure{Code: "outcome-unknown", Message: "调用结果未确认，须核实实际状态，不得直接重放"}}
			if call != nil && call.Result != nil {
				unknown["result"] = call.Result // 保留已确认的接受凭据，不能将其当成最终成功。
			}
			if fact.Error != nil {
				unknown["cause"] = fact.Error
			}
			value = unknown
		}
	}
	if call != nil && len(call.Attempts) > 0 {
		value.(map[string]any)["attempts"] = call.Attempts
	}
	raw, _ := json.Marshal(value)
	return string(raw)
}

func WorkflowStep(d WorkflowDefinition, id string) (WorkflowStepDefinition, error) {
	for _, s := range d.Steps {
		if s.ID == id {
			return s, nil
		}
	}
	return WorkflowStepDefinition{}, Bad("workflow-step", "工作流步骤不存在")
}

func ValidateWorkspaceVersion(version workspace.Version) error {
	digest, err := hex.DecodeString(version.Digest)
	if version.TaskID == "" || version.Revision < 1 || version.BaseRevision < 0 || version.Revision <= version.BaseRevision || version.Bytes < 0 || version.Bytes > workspace.DefaultTaskBytes || version.FileCount < 0 || version.FileCount > workspace.DefaultTaskFiles || err != nil || len(digest) != 32 {
		return Bad("invalid-workspace-version", "工作区候选版本无效")
	}
	return nil
}

func WorkspaceConflict() error {
	return &Error{Status: 409, Code: "workspace-revision-conflict", Message: "任务工作区已变化，请重新读取后重试"}
}
func Stamp(t time.Time) string { return t.UTC().Format(time.RFC3339Nano) }
