package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	_ "image/jpeg"
	_ "image/png"
	"strings"
	"time"

	"elysian/server/internal/agent/harness/state"
)

// readAttachmentRows 按引用顺序读取附件行；任一 id 不存在即返回 attachment-invalid。
func readAttachmentRows(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, refs []AttachmentRef, sessionID string) ([]attachmentRow, error) {
	placeholders, args := attachmentPlaceholders(func() []string {
		ids := make([]string, 0, len(refs))
		for _, ref := range refs {
			ids = append(ids, ref.ID)
		}
		return ids
	}())
	rows, err := q.QueryContext(ctx, "SELECT id,session_id,mime_type,bytes,width,height,name FROM agent_attachments WHERE id IN ("+placeholders+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := make(map[string]attachmentRow, len(refs))
	for rows.Next() {
		var row attachmentRow
		var sessionID sql.NullString
		if err = rows.Scan(&row.ID, &sessionID, &row.MimeType, &row.Bytes, &row.Width, &row.Height, &row.Name); err != nil {
			return nil, err
		}
		row.SessionID = sessionID.String
		byID[row.ID] = row
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := make([]attachmentRow, 0, len(refs))
	for _, ref := range refs {
		row, ok := byID[ref.ID]
		if !ok || row.SessionID != "" && row.SessionID != sessionID {
			return nil, bad("attachment-invalid", "附件不存在或已被使用，请重新添加")
		}
		out = append(out, row)
	}
	return out, nil
}

// bindAttachments 在事务内把附件行绑定到会话；放行「已绑定本会话」的行以支撑
// 编辑重发复用原轮 id。核对以调用方事务内 SELECT 结果为准，UPDATE 仅执行置位，
// 不依赖驱动 RowsAffected 对「值未变化行」的计数口径。
func bindAttachments(ctx context.Context, tx *sql.Tx, sessionID string, refs []AttachmentRef) error {
	ids := make([]string, 0, len(refs))
	for _, ref := range refs {
		ids = append(ids, ref.ID)
	}
	placeholders, idArgs := attachmentPlaceholders(ids)
	// 参数顺序与 SQL 占位符一致：SET 的会话 id、IN 的引用 id、谓词末尾的会话 id。
	args := append([]any{sessionID}, idArgs...)
	args = append(args, sessionID)
	_, err := tx.ExecContext(ctx, "UPDATE agent_attachments SET session_id=? WHERE id IN ("+placeholders+") AND (session_id IS NULL OR session_id=?)", args...)
	return err
}

// sweepOrphanAttachments 清理上传后从未绑定会话且超过保留期的附件字节。
func (s *store) sweepOrphanAttachments(ctx context.Context, tx *sql.Tx) error {
	cutoff := stamp(s.now().Add(-orphanAttachmentAge))
	_, err := tx.ExecContext(ctx, "DELETE FROM agent_attachments WHERE session_id IS NULL AND julianday(created_at)<julianday(?)", cutoff)
	return err
}

type attachmentRow = state.AttachmentRecord

func attachmentPlaceholders(ids []string) (string, []any) {
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	return placeholders, args
}

// 附件只接受 JPEG 与 PNG：按文件头魔数判定，忽略声明 MIME 与扩展名，
// 取智谱与 DeepSeek 两家交集；单边像素上限同样取两家约束的交集。
const (
	attachmentMIMEJPEG = "image/jpeg"
	attachmentMIMEPNG  = "image/png"
	maxImageEdge       = 6000
	// orphanAttachmentAge 是未绑定附件的保留期：上传后从未随消息发送的字节按此清理。
	orphanAttachmentAge = 24 * time.Hour
	// 单文件配置上限保留旧策略的兼容范围；新消息图片总预算独立于单文件策略。
	maxImageAttachmentFileBytes = 5 * 1024 * 1024
	maxImageAttachmentSetBytes  = 8 * 1024 * 1024
)

func readDocuments[T any](ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, query string, args ...any) ([]T, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		var raw string
		var item T
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &item); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func saveUserInput(ctx context.Context, tx *sql.Tx, q UserInputRequest) error {
	b, err := json.Marshal(q)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO user_inputs(id,run_id,model_request_id,model_call_id,state,document) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, q.ID, q.RunID, q.ModelRequestID, q.ModelCallID, q.Status, string(b))
	return err
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

const StateWaitingInput = "waiting-input"

const userInputTool = "request_user_input"

const userInputSchema = `CREATE TABLE user_inputs (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
 model_request_id TEXT NOT NULL, model_call_id TEXT NOT NULL, state TEXT NOT NULL,
 document TEXT NOT NULL, UNIQUE(run_id,model_request_id,model_call_id));
 CREATE UNIQUE INDEX user_inputs_pending ON user_inputs(run_id) WHERE state='pending';`

type UserInputRequest = state.UserInputRequest

type reportReader interface {
	rowReader
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *store) terminalResult(ctx context.Context, q reportReader, r Run) (*TerminalResult, error) {
	if r.SessionID == "" || r.WorkflowID != "" || r.Status != StateFailed && r.Status != StateInterrupted && r.Status != StateCancelled {
		return nil, nil
	}
	// 旧取消记录缺少来源时保留原行为；系统撤回等明确错误导致的自动终止仍给结果。
	if !state.EvidenceRecoveryRun(r) && r.Status == StateCancelled && (r.CancelRequestedAt == "" || r.Error == nil || r.Error.Code == "cancelled") {
		return nil, nil
	}
	// 自动撤回资料也会设置 CancelRequestedAt；只有明确的取消事件代表操作者停止。
	var stopped bool
	if r.CancelRequestedAt != "" {
		if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND json_extract(document,'$.type')='run/cancel-requested')`, r.ID).Scan(&stopped); err != nil {
			return nil, err
		}
	}
	if stopped && !state.EvidenceRecoveryRun(r) {
		return nil, nil
	}
	if state.EvidenceRecoveryRun(r) {
		report, err := buildRunReport(ctx, q, r)
		if err != nil {
			return nil, err
		}
		content := report.Text()
		if r.BudgetStop != nil {
			content = state.BudgetTerminalText(r) + "\n\n" + content
		}
		return &TerminalResult{Origin: "runtime", Content: content, Report: report}, nil
	}
	if r.BudgetStop != nil {
		return &TerminalResult{Origin: "runtime", Content: state.BudgetTerminalText(r)}, nil
	}
	reason := "运行异常结束，未获得可用结果"
	if r.Error != nil && strings.TrimSpace(r.Error.Message) != "" {
		reason = strings.TrimSpace(r.Error.Message)
	}
	return &TerminalResult{Origin: "runtime", Content: "本轮任务未能完成。\n\n原因：" + reason}, nil
}

// 保存发生在终态事件的同一事务，按 Run 去重；只读快照使用相同生成逻辑兼容旧记录。
func (s *store) saveTerminalResult(ctx context.Context, tx *sql.Tx, r *Run) error {
	result, err := s.terminalResult(ctx, tx, *r)
	if err != nil || result == nil {
		return err
	}
	if result.Report != nil {
		r.Report = result.Report
		if err := saveRun(ctx, tx, r); err != nil {
			return err
		}
	}
	var exists bool
	// 一个 Run 只有一条公开助手消息。取消已保存的片段保持原样，报告
	// 单独留在 Run 和时间线中，不能覆盖片段或插入第二条助手消息。
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM messages WHERE run_id=? AND role='assistant')`, r.ID).Scan(&exists); err != nil || exists {
		return err
	}
	message := Message{ID: state.RandomID(), SessionID: r.SessionID, TaskID: r.TaskID, RunID: r.ID, Role: "assistant", Origin: result.Origin, Content: result.Content, RunStatus: r.Status, CreatedAt: r.EndedAt}
	return s.appendMessage(ctx, tx, &message)
}

type TerminalResult = state.TerminalResult

func buildRunReport(ctx context.Context, q reportReader, r Run) (*RunReport, error) {
	if r.Report != nil {
		return r.Report, nil
	}
	calls, err := readDocuments[Call](ctx, q, "SELECT document FROM calls WHERE run_id=? ORDER BY step_index", r.ID)
	if err != nil {
		return nil, err
	}
	ops, err := readDocuments[Operation](ctx, q, "SELECT document FROM operations WHERE run_id=?", r.ID)
	if err != nil {
		return nil, err
	}
	byCall := map[string]*Operation{}
	for i := range ops {
		byCall[ops[i].CallID] = &ops[i]
	}
	report := &RunReport{Outcome: "本轮任务未全部完成，进度已保存。", Reason: "未取得可确认的结束原因", Steps: []ReportStep{}, Remaining: []string{}, Analysis: r.FailureAnalysis}
	if state.ContinuousRun(r) {
		report.Objective = r.Input
		if task, err := readTask(ctx, q, r.TaskID); err != nil {
			return nil, err
		} else if task.Goal != "" {
			report.Objective = task.Goal
			if r.Input != "" && r.Input != task.Goal {
				report.Objective += "；本轮补充：" + r.Input
			}
		}
		report.Stage = state.ReportStage(r.Phase)
	}
	if r.Error != nil {
		report.Reason = r.Error.Message
	}
	if r.Status == StateSucceeded {
		report.Outcome, report.Reason = "任务已完成。", "已确认结束，执行事实已保存"
	}
	if r.Status == StateCancelled {
		report.Outcome = "本轮任务已停止，已取得的执行事实已保存。"
		if r.Error == nil {
			report.Reason = "用户已停止本轮任务"
		}
	}
	for _, call := range calls {
		if call.Tool == toolSearchName || call.Tool == planTool || call.Tool == userInputTool || call.Tool == taskHistoryTool {
			continue
		}
		fact := state.ProjectToolExecution(r, byCall[call.ID], &call, nil)
		switch fact.Status {
		case StateSucceeded:
			report.Completed++
		case "unknown", StateWaitingTask:
			report.Unconfirmed++
		case StateFailed:
			report.Failed++
		}
		report.Steps = append(report.Steps, ReportStep{CallID: call.ID, Tool: call.Tool, Status: fact.Status, Attempts: max(1, len(call.Attempts)), Error: call.Error})
	}
	if len(report.Steps) > 20 {
		report.Steps = report.Steps[len(report.Steps)-20:]
	}
	if r.Plan != nil {
		for _, s := range r.Plan.Steps {
			if s.Status != "completed" {
				report.Remaining = append(report.Remaining, s.Title)
			}
		}
	}
	report.Next = "可在原会话调整方案后继续；已确认成功的操作不会重放。"
	if report.Unconfirmed > 0 {
		report.Next = "先核实结果未确认的操作；取得可信结束证据并解除保护后才能继续，不能直接重复提交。"
	}
	return report, nil
}

type ReportStep = state.ReportStep

type RunReport = state.RunReport
