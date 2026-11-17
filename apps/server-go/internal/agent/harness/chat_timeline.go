package harness

import (
	"context"
	"math"

	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/tools"
)

// ChatSnapshot 在同一把运行锁内读取事实与当前增量，避免终态和请求记录跨拍。
func (m *Manager) ChatSnapshot(ctx context.Context, id string) (hstate.ChatOutput, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return hstate.ChatOutput{}, closedError()
	}
	value, readErr := storeRead(ctx, m.store, "ChatSnapshot", func(ctx context.Context) (hstate.ChatOutput, error) {
		run, err := readView(ctx, m.store).Get(ctx, id)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		records, err := readView(ctx, m.store).SessionModelRequests(ctx, id)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		if execution := m.executionLocked(id); execution != nil && execution.agent != nil {
			a := execution.agent
			for i := range records {
				if records[i].ID == a.reasoningRequestID && records[i].Status == StateRunning {
					records[i].Reasoning, records[i].Content = a.reasoning, a.content
				}
			}
		}
		operations, err := readView(ctx, m.store).SessionOperations(ctx, id)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		// 工具结果仅在展开详情时经 Calls 读取，避免每 100ms 重传大结果。
		calls, err := readView(ctx, m.store).SessionCalls(ctx, id)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		approvals, err := readView(ctx, m.store).SessionApprovals(ctx, id)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		out := hstate.ProjectChatOutput(run, records)
		timeline := projectChatTimeline(run, records, operations, calls, approvals)
		timeline.BlockingRecovery, err = m.blockingRecovery(ctx, run)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		timeline.BudgetPolicy, timeline.BudgetStop = run.BudgetPolicy, run.BudgetStop
		timeline.Continuation, err = continuation(ctx, m.store, run)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		if err = projectCurrentReport(ctx, m.store, &run); err != nil {
			return hstate.ChatOutput{}, err
		}
		timeline.CurrentReport = run.CurrentReport
		if !hstate.Terminal(run.Status) {
			timeline.Wait = run.Wait
		}
		timeline.TerminalResult, err = readView(ctx, m.store).TerminalResult(ctx, run)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		questions, err := readView(ctx, m.store).SessionUserInputs(ctx, id)
		if err != nil {
			return hstate.ChatOutput{}, err
		}
		for i := range timeline.Entries {
			entry := &timeline.Entries[i]
			if entry.Kind == "tool" && entry.Status == "unknown" {
				message := "任务结果未确认，须核实实际状态"
				if entry.Error != nil {
					message = entry.Error.Message
				}
				entry.Progress = &tools.TaskProgress{State: "unknown", Message: message}
				continue // Persisted uncertainty takes precedence over stale running progress.
			}
			if entry.Kind == "tool" && (entry.Status == StateWaitingTask || entry.Status == "unknown") {
				for _, operation := range operations {
					if operation.ModelRequestID == entry.ModelRequestID && operation.ModelCallID == entry.ModelCallID && operation.Task != nil {
						if observation, ok := m.taskProgress[operation.ID]; ok && observation.Task == *operation.Task {
							entry.Progress = cloneTaskProgress(observation.Progress)
						}
					}
				}
			}
			for _, question := range questions {
				if entry.Kind == "tool" && entry.ModelRequestID == question.ModelRequestID && entry.ModelCallID == question.ModelCallID {
					copy := question
					entry.Kind, entry.UserInput = "user-input", &copy
				}
			}
		}
		out.Timeline = &timeline
		return out, nil
	})
	return value, storageFailure(readErr)
}

func projectChatTimeline(run Run, records []ModelRequestRecord, operations []Operation, calls []Call, approvals []Approval) hstate.ChatTimelineSnapshot {
	out := hstate.ChatTimelineSnapshot{Recovery: run.Recovery, RecoveryPolicy: run.RecoveryPolicy, Plan: run.Plan, RunID: run.ID, Status: run.Status, Done: hstate.Terminal(run.Status), Error: run.Error, Usage: run.Usage, ContextUsage: projectChatContextUsage(run, records), CacheHitUsage: projectChatCacheHitUsage(records), Entries: []hstate.ChatTimelineEntry{}}
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
		base := hstate.ChatTimelineEntry{ModelRequestID: r.ID, RequestIndex: r.Index, StartedAt: r.StartedAt, EndedAt: r.EndedAt, Status: r.Status,
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
			entry := hstate.ChatTimelineEntry{ID: r.ID + ":tool:" + proposal.ID, Kind: "tool", ModelRequestID: r.ID, RequestIndex: r.Index,
				StartedAt: r.EndedAt, Tool: proposal.Name, ModelCallID: proposal.ID, CallIndex: i, ArgumentsJSON: string(proposal.Arguments), Status: "planned"}
			operation, hasOperation := ops[r.ID+":"+proposal.ID]
			call, hasCall := actual[r.ID+":"+proposal.ID]
			var op *Operation
			var receipt *Call
			if hasOperation {
				op = &operation
				if operation.ArgumentsJSON != "" {
					entry.ArgumentsJSON = operation.ArgumentsJSON
				}
			}
			if hasCall {
				receipt = &call
				entry.CallID, entry.Truncated = call.ID, call.Truncated
				entry.Attempts = call.Attempts
			}
			approval := decisions[operation.ApprovalID]
			fact := hstate.ProjectToolExecution(run, op, receipt, &approval)
			entry.Status, entry.Error = fact.Status, fact.Error
			entry.ResourceWait = fact.ResourceWait
			if fact.StartedAt != "" {
				entry.StartedAt = fact.StartedAt
			}
			entry.EndedAt = fact.EndedAt
			out.Entries = append(out.Entries, entry)
		}
	}
	if run.Status == StateCancelled {
		legacy := hstate.ProjectChatOutput(run, records)
		out.FinalResponseID = ""
		if legacy.Content != "" {
			out.FinalResponseID = legacy.ResponseID
		}
	}
	return out
}

func projectChatContextUsage(run Run, records []ModelRequestRecord) *hstate.ChatContextUsage {
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
	out := &hstate.ChatContextUsage{ModelRequestID: latest.ID, Model: run.Model.Model, ContextTokens: run.Model.ContextTokens, EstimatedBreakdown: projectContextBreakdown(*latest)}
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

func projectChatCacheHitUsage(records []ModelRequestRecord) *hstate.ChatCacheHitUsage {
	if len(records) == 0 {
		return nil
	}
	const maxSafeTokens int64 = 1<<53 - 1
	maxTokens := int64(math.MaxInt)
	if maxTokens > maxSafeTokens {
		maxTokens = maxSafeTokens
	}
	out := &hstate.ChatCacheHitUsage{}
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
