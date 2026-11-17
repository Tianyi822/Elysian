package harness

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

const taskHistoryTool = "task_history"

func taskHistoryCapability() Capability {
	return Capability{Name: taskHistoryTool, Source: taskHistorySource, ReadOnly: true,
		Description: "只读检索当前任务的持久事件、工具回执和模型回复。支持证据引用 runId:eventSeq、关键词和增量游标；每次最多20项、16KiB。长记录按原引用与 nextOffset 分段读取。用于压缩后追溯原始事实，不能读取其他任务，不授予执行权限。",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"reference":{"type":"string","maxLength":200},"keyword":{"type":"string","maxLength":200},"cursor":{"type":"string","maxLength":32},"offset":{"type":"integer","minimum":0}},"additionalProperties":false}`),
		Metadata:    tools.Metadata{Domain: "agent", Action: "task-history", Effect: "read", ReadOnly: true, Exposure: "agent", Version: "1"}}
}

type taskHistoryPage struct {
	Items      []json.RawMessage `json:"items"`
	NextCursor string            `json:"nextCursor,omitempty"`
	HasMore    bool              `json:"hasMore"`
}

func readTaskHistory(ctx context.Context, q reportReader, taskID string, args json.RawMessage) (taskHistoryPage, error) {
	page := taskHistoryPage{Items: []json.RawMessage{}}
	if err := mcp.Validate(taskHistoryCapability().Parameters, args); err != nil {
		return page, bad("invalid-history-query", "历史查询参数无效")
	}
	var input struct {
		Reference string `json:"reference"`
		Keyword   string `json:"keyword"`
		Cursor    string `json:"cursor"`
		Offset    int    `json:"offset"`
	}
	if err := json.Unmarshal(args, &input); err != nil {
		return page, err
	}
	if input.Offset > 0 && input.Reference == "" {
		return page, bad("invalid-history-reference", "分段读取须指定原证据引用")
	}
	cursor, err := state.NumberCursor(input.Cursor)
	if err != nil {
		return page, err
	}
	runID, seq := "", int64(0)
	if input.Reference != "" {
		parts := strings.Split(input.Reference, ":")
		if len(parts) != 2 {
			return page, bad("invalid-history-reference", "证据引用须为 runId:eventSeq")
		}
		runID = parts[0]
		seq, err = state.NumberCursor(parts[1])
		if err != nil || seq < 1 {
			return page, bad("invalid-history-reference", "证据引用序号无效")
		}
	}
	rows, err := readView(ctx, q).TaskHistory(ctx, taskID, cursor, runID, seq, input.Keyword)
	if err != nil {
		return page, err
	}

	size := 0
	for _, record := range rows {
		var rowID int64
		var raw, call, reply string
		rowID, raw, call, reply = record.Sequence, record.Event, record.Call, record.ModelRequest
		if len(page.Items) == 20 {
			page.HasMore = true
			break
		}
		var event Event
		if err = json.Unmarshal([]byte(raw), &event); err != nil {
			return page, err
		}
		// Oversized individual records remain addressable without exhausting context.
		detail, marshalErr := json.Marshal(map[string]any{"event": json.RawMessage(raw), "call": json.RawMessage(call), "model": json.RawMessage(reply)})
		if marshalErr != nil {
			return page, marshalErr
		}
		entry, _ := json.Marshal(map[string]any{"reference": event.RunID + ":" + event.Seq, "detail": json.RawMessage(detail)})
		if len(entry) > 12000 || input.Offset > 0 {
			start := min(input.Offset, len(detail))
			if start < len(detail) && !utf8.RuneStart(detail[start]) {
				return page, bad("invalid-history-offset", "分段偏移必须位于字符边界")
			}
			end := min(start+1800, len(detail))
			for end < len(detail) && !utf8.RuneStart(detail[end]) {
				end--
			}
			chunk := map[string]any{"reference": event.RunID + ":" + event.Seq, "type": event.Type, "content": string(detail[start:end]), "offset": start, "truncated": end < len(detail)}
			if end < len(detail) {
				chunk["nextOffset"] = end
			}
			entry, _ = json.Marshal(chunk)
		}
		if size+len(entry) > 15000 && len(page.Items) > 0 {
			page.HasMore = true
			break
		}
		page.Items = append(page.Items, entry)
		size += len(entry)
		page.NextCursor = strconv.FormatInt(rowID, 10)
	}
	return page, nil
}

func (a *agentExecution) executeTaskHistory(ctx context.Context, index int, proposal model.ToolCall) error {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	capability, ok := a.capability(taskHistoryTool)
	if !state.ContinuousRun(a.run) || !ok || capability.Source != taskHistorySource {
		return bad("tool-denied", "该运行不支持任务历史检索")
	}
	if err := a.validateVisibleProposal(*a.pending, taskHistoryTool); err != nil {
		return err
	}
	_, err := m.store.ChangeRun(ctx, a.run.ID, "task-history", func(tx sessionstore.Tx, r *Run) error {
		if r.Status != StateRunning || r.CancelRequestedAt != "" {
			return context.Canceled
		}
		var exists bool
		if err := tx.TaskHistoryInvocationExists(ctx, r.ID, a.pending.ID, proposal.ID, &exists); err != nil {
			return err
		}
		if exists {
			return nil
		}
		now := stamp(m.deps.Now())
		call := Call{ID: m.deps.NewID(), RunID: r.ID, Tool: taskHistoryTool, ModelRequestID: a.pending.ID, ModelCallID: proposal.ID, ArgumentsJSON: string(proposal.Arguments), StepIndex: r.Usage.Calls, StartedAt: now, EndedAt: now, Status: StateSucceeded}
		page, err := readTaskHistory(ctx, tx, r.TaskID, proposal.Arguments)
		if err != nil {
			var failure *Error
			if !errors.As(err, &failure) {
				return err
			}
			call.Status = StateFailed
			call.Error = &Failure{Code: failure.Code, Message: failure.Message}
		} else {
			call.Result, _ = json.Marshal(page)
		}
		r.Usage.Calls++
		r.Usage.ResultBytes += len(call.Result)
		r.Resume = &RecoveryCursor{ResponseID: a.pending.ID, CallIndex: index + 1}
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		return tx.Event(ctx, r, "history/read", call.ID, &call.StepIndex, nil)
	})
	return storageFailure(err)
}

const taskHistorySource = state.TaskHistorySource
