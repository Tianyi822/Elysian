package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

const taskHistoryTool = "task_history"
const taskHistorySource = "task-history"

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
	cursor, err := numberCursor(input.Cursor)
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
		seq, err = numberCursor(parts[1])
		if err != nil || seq < 1 {
			return page, bad("invalid-history-reference", "证据引用序号无效")
		}
	}
	rows, err := q.QueryContext(ctx, `SELECT e.rowid,e.document,
 COALESCE(json_object('tool',json_extract(c.document,'$.tool'),'status',c.state,'result',json_extract(c.document,'$.result'),'error',json_extract(c.document,'$.error'),'originalModelContent',json_extract(c.document,'$.modelContent')),'null'),
 COALESCE(json_object('purpose',json_extract(m.document,'$.purpose'),'response',json_remove(json_extract(m.document,'$.response'),'$.reasoning'),'error',json_extract(m.document,'$.error')),'null')
 FROM run_events e JOIN runs r ON r.id=e.run_id
 LEFT JOIN calls c ON c.run_id=e.run_id AND c.id=json_extract(e.document,'$.callId')
 LEFT JOIN model_requests m ON m.run_id=e.run_id AND m.id=json_extract(e.document,'$.data.modelRequestId')
 WHERE r.task_id=? AND COALESCE(json_extract(r.document,'$.supersededByRunId'),'')='' AND e.rowid>?
 AND (?='' OR (e.run_id=? AND e.seq=?)) AND (?='' OR instr(e.document,?)>0 OR instr(c.document,?)>0 OR instr(m.document,?)>0)
 ORDER BY e.rowid LIMIT 21`, taskID, cursor, runID, runID, seq, input.Keyword, input.Keyword, input.Keyword, input.Keyword)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	size := 0
	for rows.Next() {
		var rowID int64
		var raw, call, reply string
		if err = rows.Scan(&rowID, &raw, &call, &reply); err != nil {
			return page, err
		}
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
	return page, rows.Err()
}

func (a *agentExecution) executeTaskHistory(ctx context.Context, index int, proposal model.ToolCall) error {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	capability, ok := a.capability(taskHistoryTool)
	if !continuousRun(a.run) || !ok || capability.Source != taskHistorySource {
		return bad("tool-denied", "该运行不支持任务历史检索")
	}
	if err := a.validateVisibleProposal(*a.pending, taskHistoryTool); err != nil {
		return err
	}
	_, err := m.store.change(ctx, a.run.ID, "task-history", func(tx *sql.Tx, r *Run) error {
		if r.Status != StateRunning || r.CancelRequestedAt != "" {
			return context.Canceled
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM calls WHERE run_id=? AND json_extract(document,'$.modelRequestId')=? AND json_extract(document,'$.modelCallId')=?)", r.ID, a.pending.ID, proposal.ID).Scan(&exists); err != nil {
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
		return m.store.event(ctx, tx, r, "history/read", call.ID, &call.StepIndex, nil)
	})
	return storageFailure(err)
}
