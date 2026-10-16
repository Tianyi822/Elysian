package harness

import "context"

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

type ChatTimelineSnapshot struct {
	RunID           string              `json:"runId"`
	Status          string              `json:"status"`
	Done            bool                `json:"done"`
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
	out := ChatTimelineSnapshot{RunID: run.ID, Status: run.Status, Done: terminal(run.Status), Entries: []ChatTimelineEntry{}}
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
