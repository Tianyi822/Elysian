package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
)

const StateWaitingInput = "waiting-input"
const userInputTool = "request_user_input"
const userInputSource = "user-input"

const userInputSchema = `CREATE TABLE user_inputs (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 model_request_id TEXT NOT NULL, model_call_id TEXT NOT NULL, state TEXT NOT NULL,
 document TEXT NOT NULL, UNIQUE(run_id,model_request_id,model_call_id));
 CREATE UNIQUE INDEX user_inputs_pending ON user_inputs(run_id) WHERE state='pending';`

type UserInputOption struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Description string `json:"description"`
}
type UserInputQuestion struct {
	ID                  string            `json:"id"`
	Header              string            `json:"header"`
	Question            string            `json:"question"`
	Options             []UserInputOption `json:"options"`
	RecommendedOptionID string            `json:"recommendedOptionId,omitempty"`
}
type UserInputAnswer struct {
	OptionID string `json:"optionId,omitempty"`
	Text     string `json:"text,omitempty"`
}
type AnswerUserInput struct {
	RequestID string                     `json:"requestId"`
	Answers   map[string]UserInputAnswer `json:"answers"`
}
type UserInputRequest struct {
	ID              string                     `json:"id"`
	RunID           string                     `json:"runId"`
	ModelRequestID  string                     `json:"modelRequestId"`
	ModelCallID     string                     `json:"modelCallId"`
	CallID          string                     `json:"callId"`
	Status          string                     `json:"status"`
	Questions       []UserInputQuestion        `json:"questions"`
	Answers         map[string]UserInputAnswer `json:"answers,omitempty"`
	AnswerRequestID string                     `json:"answerRequestId,omitempty"`
	CreatedAt       string                     `json:"createdAt"`
	EndedAt         string                     `json:"endedAt,omitempty"`
}
type UserInputReceipt struct {
	UserInput UserInputRequest `json:"userInput"`
	Run       Run              `json:"run"`
}

func userInputCapability() Capability {
	return Capability{Name: userInputTool, Source: userInputSource, ReadOnly: true,
		Description: "缺少会影响结论或操作的目标、范围或偏好时，请用户选择后继续原任务。一次 1–3 题，每题 2–3 个单选项，用户也可自行填写。必须单独调用，不能与其他工具混批；已有明确默认值、可通过工具查询的信息和模型服务错误不应提问。用户回答不授予额外执行权限。",
		Parameters:  json.RawMessage(`{"type":"object","properties":{"questions":{"type":"array","minItems":1,"maxItems":3,"items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":64},"header":{"type":"string","minLength":1,"maxLength":40},"question":{"type":"string","minLength":1,"maxLength":1000},"recommendedOptionId":{"type":"string","maxLength":64},"options":{"type":"array","minItems":2,"maxItems":3,"items":{"type":"object","properties":{"id":{"type":"string","minLength":1,"maxLength":64},"label":{"type":"string","minLength":1,"maxLength":100},"description":{"type":"string","minLength":1,"maxLength":300}},"required":["id","label","description"],"additionalProperties":false}}},"required":["id","header","question","options"],"additionalProperties":false}}},"required":["questions"],"additionalProperties":false}`),
		Metadata:    tools.Metadata{Domain: "agent", Action: "request-user-input", Effect: "read", ReadOnly: true, Exposure: "agent", Version: "1"}}
}

func parseUserInput(raw json.RawMessage) ([]UserInputQuestion, error) {
	if err := mcp.Validate(userInputCapability().Parameters, raw); err != nil {
		return nil, bad("invalid-user-input", "请提供 1–3 个问题，每题包含 2–3 个不同选项")
	}
	var args struct {
		Questions []UserInputQuestion `json:"questions"`
	}
	if json.Unmarshal(raw, &args) != nil {
		return nil, bad("invalid-user-input", "问题格式无效")
	}
	ids := map[string]bool{}
	for _, q := range args.Questions {
		if !requestPattern.MatchString(q.ID) || ids[q.ID] || strings.TrimSpace(q.Header) == "" || strings.TrimSpace(q.Question) == "" {
			return nil, bad("invalid-user-input", "问题编号必须唯一，标题和问题不能为空")
		}
		ids[q.ID] = true
		options := map[string]bool{}
		for _, o := range q.Options {
			if !requestPattern.MatchString(o.ID) || options[o.ID] || strings.TrimSpace(o.Label) == "" || strings.TrimSpace(o.Description) == "" {
				return nil, bad("invalid-user-input", "选项编号必须唯一，名称和解释不能为空")
			}
			options[o.ID] = true
		}
		if q.RecommendedOptionID != "" && !options[q.RecommendedOptionID] {
			return nil, bad("invalid-user-input", "推荐项必须属于问题的选项")
		}
	}
	return args.Questions, nil
}

func saveUserInput(ctx context.Context, tx *sql.Tx, q UserInputRequest) error {
	b, err := json.Marshal(q)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO user_inputs(id,run_id,model_request_id,model_call_id,state,document) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, q.ID, q.RunID, q.ModelRequestID, q.ModelCallID, q.Status, string(b))
	return err
}

// 澄清是父进程内部交互，不占用外部操作租约；回答仍作为原工具调用的结果。
func (a *agentExecution) executeUserInput(ctx context.Context, index int, proposal model.ToolCall, rejection string) error {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || ctx.Err() != nil || m.store.recordsFault() != nil {
		return context.Canceled
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			return err
		}
	}
	now := stamp(m.deps.Now())
	_, err := m.store.change(ctx, a.run.ID, "user-input", func(tx *sql.Tx, r *Run) error {
		if r.Status != StateRunning || r.CancelRequestedAt != "" {
			return context.Canceled
		}
		if r.Usage.Calls >= r.Limits.MaxSteps {
			return bad("call-limit", "工具调用次数已达上限")
		}
		call := Call{ID: m.deps.NewID(), RunID: r.ID, Tool: proposal.Name, ModelRequestID: a.pending.ID, ModelCallID: proposal.ID, ArgumentsJSON: string(proposal.Arguments), StepIndex: r.Usage.Calls, StartedAt: now, Status: StateWaitingInput}
		r.Usage.Calls++
		if rejection != "" {
			call.Status, call.EndedAt = StateFailed, now
			call.Error = &Failure{Code: "invalid-user-input", Message: rejection}
			r.Resume = &RecoveryCursor{ResponseID: a.pending.ID, CallIndex: index + 1}
		} else {
			questions, e := parseUserInput(proposal.Arguments)
			if e != nil {
				return e
			}
			q := UserInputRequest{ID: m.deps.NewID(), RunID: r.ID, ModelRequestID: a.pending.ID, ModelCallID: proposal.ID, CallID: call.ID, Questions: questions, Status: "pending", CreatedAt: now}
			if e := saveUserInput(ctx, tx, q); e != nil {
				return e
			}
			r.Status, r.Phase = StateWaitingInput, StateWaitingInput
			r.Resume = &RecoveryCursor{ResponseID: a.pending.ID, CallIndex: index}
		}
		if e := saveCall(ctx, tx, call); e != nil {
			return e
		}
		return m.store.event(ctx, tx, r, "user-input/request", call.ID, &call.StepIndex, nil)
	})
	if err != nil {
		if _, ok := err.(*Error); !ok && ctx.Err() == nil {
			m.storageFailedLocked()
		}
		return storageFailure(err)
	}
	if rejection != "" {
		return nil
	}
	return worker.ErrSuspended
}

func (m *Manager) AnswerUserInput(ctx context.Context, runID, inputID string, input AnswerUserInput) (UserInputReceipt, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var receipt UserInputReceipt
	if m.closed {
		return receipt, closedError()
	}
	if !requestPattern.MatchString(input.RequestID) {
		return receipt, bad("invalid-user-input-answer", "回答请求编号无效")
	}
	if err := m.store.recordsFault(); err != nil {
		return receipt, &Error{503, "record-storage-unavailable", "运行记录副本不可用，请稍后重试"}
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			return receipt, err
		}
	}
	run, err := m.store.change(ctx, runID, "user-input-answer", func(tx *sql.Tx, r *Run) error {
		var raw string
		if e := tx.QueryRowContext(ctx, "SELECT document FROM user_inputs WHERE id=? AND run_id=?", inputID, runID).Scan(&raw); e != nil {
			if e == sql.ErrNoRows {
				return &Error{409, "user-input-conflict", "问题不属于当前运行或已不可用"}
			}
			return e
		}
		var q UserInputRequest
		if e := json.Unmarshal([]byte(raw), &q); e != nil {
			return e
		}
		if q.Status == "answered" && q.AnswerRequestID == input.RequestID && digestJSON(q.Answers) == digestJSON(input.Answers) {
			receipt.UserInput = q
			return nil
		}
		if q.Status != "pending" || r.Status != StateWaitingInput || r.CancelRequestedAt != "" {
			return &Error{409, "user-input-conflict", "问题已回答或本轮已取消，请刷新查看"}
		}
		if len(input.Answers) != len(q.Questions) {
			return bad("invalid-user-input-answer", "请回答全部问题")
		}
		for _, question := range q.Questions {
			answer, ok := input.Answers[question.ID]
			if !ok || (answer.OptionID == "") == (strings.TrimSpace(answer.Text) == "") || utf8.RuneCountInString(answer.Text) > 4000 {
				return bad("invalid-user-input-answer", "每题请选择一个选项或填写不超过 4000 字的回答")
			}
			if answer.OptionID != "" {
				found := false
				for _, option := range question.Options {
					found = found || option.ID == answer.OptionID
				}
				if !found || answer.Text != "" {
					return bad("invalid-user-input-answer", "回答选项无效")
				}
			}
		}
		var count int
		if e := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(&count); e != nil {
			return e
		}
		if count >= r.Limits.QueueCapacity {
			return &Error{429, "queue-full", "任务队列已满，问题保持待回答"}
		}
		if e := m.validateWikiRun(ctx, tx, r.ID); e != nil {
			return e
		}
		var call Call
		if e := tx.QueryRowContext(ctx, "SELECT document FROM calls WHERE id=? AND run_id=?", q.CallID, r.ID).Scan(&raw); e != nil {
			return e
		}
		if e := json.Unmarshal([]byte(raw), &call); e != nil {
			return e
		}
		q.Status, q.AnswerRequestID, q.Answers, q.EndedAt = "answered", input.RequestID, input.Answers, stamp(m.deps.Now())
		call.Status, call.EndedAt = StateSucceeded, q.EndedAt
		call.Result, _ = json.Marshal(map[string]any{"questions": q.Questions, "answers": q.Answers})
		if len(call.Result) > r.Limits.ResultBytes || r.Usage.ResultBytes+len(call.Result) > r.Limits.RunResultBytes {
			return bad("result-limit", "回答超过本轮结果容量限制")
		}
		r.Usage.ResultBytes += len(call.Result)
		if e := saveCall(ctx, tx, call); e != nil {
			return e
		}
		if e := saveUserInput(ctx, tx, q); e != nil {
			return e
		}
		r.Status, r.Phase = StateQueued, "queued"
		r.Resume = &RecoveryCursor{ResponseID: q.ModelRequestID, CallIndex: 1}
		receipt.UserInput = q
		return m.store.event(ctx, tx, r, "user-input/answered", call.ID, &call.StepIndex, nil)
	})
	if err != nil {
		if _, ok := err.(*Error); !ok && ctx.Err() == nil {
			m.storageFailedLocked()
		}
		return UserInputReceipt{}, storageFailure(err)
	}
	receipt.Run = run
	m.signal()
	return receipt, nil
}

func cancelUserInputs(ctx context.Context, tx *sql.Tx, runID, endedAt string) error {
	questions, err := readDocuments[UserInputRequest](ctx, tx, "SELECT document FROM user_inputs WHERE run_id=? AND state='pending'", runID)
	if err != nil {
		return err
	}
	for _, q := range questions {
		q.Status, q.EndedAt = "cancelled", endedAt
		if err := saveUserInput(ctx, tx, q); err != nil {
			return err
		}
		var raw string
		if err := tx.QueryRowContext(ctx, "SELECT document FROM calls WHERE id=?", q.CallID).Scan(&raw); err != nil {
			return err
		}
		var call Call
		if err := json.Unmarshal([]byte(raw), &call); err != nil {
			return err
		}
		call.Status, call.EndedAt = StateCancelled, endedAt
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
	}
	return nil
}
