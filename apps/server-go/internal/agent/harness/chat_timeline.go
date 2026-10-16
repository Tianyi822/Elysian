package harness

import (
	"context"
	"math"

	"elysian/server/internal/agent/harness/model"
)

type ChatTimelineEntry struct {
	ID             string   `json:"id"`
	Kind           string   `json:"kind"`
	ModelRequestID string   `json:"modelRequestId"`
	RequestIndex   int      `json:"requestIndex"`
	StartedAt      string   `json:"startedAt"`
	EndedAt        string   `json:"endedAt,omitempty"`
	Status         string   `json:"status"`
	Text           string   `json:"text,omitempty"`
	Incomplete     bool     `json:"incomplete"`
	Tool           string   `json:"tool,omitempty"`
	ModelCallID    string   `json:"modelCallId,omitempty"`
	CallIndex      int      `json:"callIndex"`
	ArgumentsJSON  string   `json:"argumentsJson,omitempty"`
	CallID         string   `json:"callId,omitempty"`
	Error          *Failure `json:"error,omitempty"`
	Truncated      bool     `json:"truncated"`
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
	RunID           string              `json:"runId"`
	Status          string              `json:"status"`
	Done            bool                `json:"done"`
	Usage           Usage               `json:"usage"`
	ContextUsage    *ChatContextUsage   `json:"contextUsage,omitempty"`
	CacheHitUsage   *ChatCacheHitUsage  `json:"cacheHitUsage,omitempty"`
	FinalResponseID string              `json:"finalResponseId,omitempty"`
	Entries         []ChatTimelineEntry `json:"entries"`
}

// ChatSnapshot 在同一把运行锁内读取事实与当前增量，避免终态和请求记录跨拍。
func (m *Manager) ChatSnapshot(ctx context.Context, id string) (ChatOutput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return ChatOutput{}, closedError()
	}
	run, err := m.store.get(ctx, id)
	if err != nil {
		return ChatOutput{}, storageFailure(err)
	}
	records, err := readDocuments[ModelRequestRecord](ctx, m.store.db, "SELECT document FROM model_requests WHERE run_id=? ORDER BY request_index", id)
	if err != nil {
		return ChatOutput{}, storageFailure(err)
	}
	if execution := m.executionLocked(id); execution != nil && execution.agent != nil {
		a := execution.agent
		for i := range records {
			if records[i].ID == a.reasoningRequestID && records[i].Status == StateRunning {
				records[i].Reasoning, records[i].Content = a.reasoning, a.content
			}
		}
	}
	operations, err := readDocuments[Operation](ctx, m.store.db, "SELECT json_remove(document,'$.pendingResult') FROM operations WHERE run_id=? ORDER BY rowid", id)
	if err != nil {
		return ChatOutput{}, storageFailure(err)
	}
	// 工具结果仅在展开详情时经 Calls 读取，避免每 100ms 重传大结果。
	calls, err := readDocuments[Call](ctx, m.store.db, "SELECT json_remove(document,'$.result','$.args','$.argumentsJson') FROM calls WHERE run_id=? ORDER BY step_index", id)
	if err != nil {
		return ChatOutput{}, storageFailure(err)
	}
	approvals, err := readDocuments[Approval](ctx, m.store.db, "SELECT json_remove(document,'$.operation') FROM approvals WHERE run_id=? ORDER BY rowid", id)
	if err != nil {
		return ChatOutput{}, storageFailure(err)
	}
	out := chatOutput(run, records)
	timeline := projectChatTimeline(run, records, operations, calls, approvals)
	out.Timeline = &timeline
	return out, nil
}

func projectChatTimeline(run Run, records []ModelRequestRecord, operations []Operation, calls []Call, approvals []Approval) ChatTimelineSnapshot {
	out := ChatTimelineSnapshot{RunID: run.ID, Status: run.Status, Done: terminal(run.Status), Usage: run.Usage, ContextUsage: projectChatContextUsage(run, records), CacheHitUsage: projectChatCacheHitUsage(records), Entries: []ChatTimelineEntry{}}
	ops := map[string]Operation{}
	for _, o := range operations {
		ops[o.ModelRequestID+":"+o.ModelCallID] = o
	}
	actual := map[string]Call{}
	for _, c := range calls {
		actual[c.ModelRequestID+":"+c.ModelCallID] = c
	}
	decisions := map[string]Approval{}
	for _, a := range approvals {
		decisions[a.ID] = a
	}
	for _, r := range records {
		if r.Purpose != "inference" {
			continue
		}
		thought, content := r.Reasoning, r.Content
		if r.Response != nil {
			thought, content = r.Response.Reasoning, r.Response.Content
		}
		base := ChatTimelineEntry{ModelRequestID: r.ID, RequestIndex: r.Index, StartedAt: r.StartedAt, EndedAt: r.EndedAt, Status: r.Status,
			Incomplete: r.Status != StateRunning && r.Status != StateSucceeded}
		if r.Response != nil && len(r.Response.ToolCalls) == 0 {
			base.Incomplete = base.Incomplete || r.Response.FinishReason != "stop"
			if r.Response.FinishReason == "stop" && content != "" {
				out.FinalResponseID = r.ID
			}
		}
		if thought != "" {
			entry := base
			entry.ID, entry.Kind, entry.Text = r.ID+":reasoning", "reasoning", thought
			out.Entries = append(out.Entries, entry)
		}
		if content != "" {
			entry := base
			entry.ID, entry.Kind, entry.Text = r.ID+":content", "content", content
			out.Entries = append(out.Entries, entry)
		}
		if r.Response == nil {
			continue
		}
		for i, proposal := range r.Response.ToolCalls {
			entry := ChatTimelineEntry{ID: r.ID + ":tool:" + proposal.ID, Kind: "tool", ModelRequestID: r.ID, RequestIndex: r.Index,
				StartedAt: r.EndedAt, Tool: proposal.Name, ModelCallID: proposal.ID, CallIndex: i, ArgumentsJSON: string(proposal.Arguments), Status: "planned"}
			operation, hasOperation := ops[r.ID+":"+proposal.ID]
			call, hasCall := actual[r.ID+":"+proposal.ID]
			if hasOperation {
				if operation.ArgumentsJSON != "" {
					entry.ArgumentsJSON = operation.ArgumentsJSON
				}
				entry.Status, entry.Error = operation.Status, operation.Error
				entry.StartedAt, entry.EndedAt = operation.CreatedAt, operation.EndedAt
				switch operation.Status {
				case "dispatched":
					entry.Status = StateRunning
				case "completed":
					entry.Status = "unknown"
				}
			}
			if hasCall {
				entry.CallID, entry.Truncated = call.ID, call.Truncated
				entry.StartedAt, entry.EndedAt, entry.Error = call.StartedAt, call.EndedAt, call.Error
				if !hasOperation || (operation.Status != StateWaitingTask && operation.Status != StateWaitingResource && operation.Status != "unknown") {
					entry.Status = call.Status
				}
				if entry.Status == StateInterrupted || entry.Status == StateRecoveryRequired {
					entry.Status = "unknown"
				}
			} else {
				approval := decisions[operation.ApprovalID]
				switch approval.Status {
				case "denied", "expired", "revoked":
					entry.Status, entry.EndedAt = approval.Status, approval.DecidedAt
				default:
					if out.Done && (!hasOperation || operation.Status == "planned" || operation.Status == StateWaitingApproval || operation.Status == StateWaitingResource) {
						entry.Status = "not-executed"
					}
					if out.Done && hasOperation && operation.Status == "dispatched" {
						entry.Status = "unknown"
					}
				}
			}
			out.Entries = append(out.Entries, entry)
		}
	}
	if run.Status == StateCancelled {
		legacy := chatOutput(run, records)
		out.FinalResponseID = ""
		if legacy.Content != "" {
			out.FinalResponseID = legacy.ResponseID
		}
	}
	return out
}

func projectChatContextUsage(run Run, records []ModelRequestRecord) *ChatContextUsage {
	if run.Model == nil {
		return nil
	}
	var latest *ModelRequestRecord
	for i := range records {
		record := &records[i]
		if record.Purpose == "inference" && record.Status == StateSucceeded && record.Response != nil && (latest == nil || record.Index > latest.Index) {
			latest = record
		}
	}
	if latest == nil {
		return nil
	}
	out := &ChatContextUsage{ModelRequestID: latest.ID, Model: run.Model.Model, ContextTokens: run.Model.ContextTokens, EstimatedBreakdown: projectContextBreakdown(*latest)}
	usage := latest.Response.Usage
	const maxSafeTokens int64 = 1<<53 - 1
	if usage.TotalTokens != nil {
		if *usage.TotalTokens >= 0 && int64(*usage.TotalTokens) <= maxSafeTokens {
			out.TotalTokens = usage.TotalTokens
		}
	} else if usage.PromptTokens != nil && usage.CompletionTokens != nil && *usage.PromptTokens >= 0 && *usage.CompletionTokens >= 0 && *usage.PromptTokens <= math.MaxInt-*usage.CompletionTokens && int64(*usage.PromptTokens) <= maxSafeTokens-int64(*usage.CompletionTokens) {
		total := *usage.PromptTokens + *usage.CompletionTokens
		out.TotalTokens = &total
	}
	return out
}

func projectChatCacheHitUsage(records []ModelRequestRecord) *ChatCacheHitUsage {
	if len(records) == 0 {
		return nil
	}
	const maxSafeTokens int64 = 1<<53 - 1
	maxTokens := int64(math.MaxInt)
	if maxTokens > maxSafeTokens {
		maxTokens = maxSafeTokens
	}
	out := &ChatCacheHitUsage{}
	completed := 0
	for _, record := range records {
		if record.Status == StateQueued || record.Status == StateRunning {
			continue
		}
		if record.Status != StateSucceeded || record.Response == nil {
			return nil
		}
		usage := record.Response.Usage
		if usage.PromptTokens == nil || usage.CachedTokens == nil {
			return nil
		}
		input, cached := int64(*usage.PromptTokens), int64(*usage.CachedTokens)
		if input < 0 || cached < 0 || cached > input || input > maxTokens-int64(out.InputTokens) || cached > maxTokens-int64(out.CachedTokens) {
			return nil
		}
		out.InputTokens += *usage.PromptTokens
		out.CachedTokens += *usage.CachedTokens
		completed++
	}
	if completed == 0 {
		return nil
	}
	return out
}
