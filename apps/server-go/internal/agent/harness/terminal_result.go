package harness

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// TerminalResult 是运行内核生成的公开结果，不代表模型答复或已完成的外部操作。
type TerminalResult struct {
	Origin  string     `json:"origin"`
	Content string     `json:"content"`
	Report  *RunReport `json:"report,omitempty"`
}

type reportReader interface {
	rowReader
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func (s *store) terminalResult(ctx context.Context, q reportReader, r Run) (*TerminalResult, error) {
	if r.SessionID == "" || r.WorkflowID != "" || r.Status != StateFailed && r.Status != StateInterrupted && r.Status != StateCancelled {
		return nil, nil
	}
	// 旧取消记录缺少来源时保留原行为；系统撤回等明确错误导致的自动终止仍给结果。
	if !evidenceRecoveryRun(r) && r.Status == StateCancelled && (r.CancelRequestedAt == "" || r.Error == nil || r.Error.Code == "cancelled") {
		return nil, nil
	}
	// 自动撤回资料也会设置 CancelRequestedAt；只有明确的取消事件代表操作者停止。
	var stopped bool
	if r.CancelRequestedAt != "" {
		if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND json_extract(document,'$.type')='run/cancel-requested')`, r.ID).Scan(&stopped); err != nil {
			return nil, err
		}
	}
	if stopped && !evidenceRecoveryRun(r) {
		return nil, nil
	}
	if evidenceRecoveryRun(r) {
		report, err := buildRunReport(ctx, q, r)
		if err != nil {
			return nil, err
		}
		content := report.text()
		if r.BudgetStop != nil {
			content = budgetTerminalText(r) + "\n\n" + content
		}
		return &TerminalResult{Origin: "runtime", Content: content, Report: report}, nil
	}
	if r.BudgetStop != nil {
		return &TerminalResult{Origin: "runtime", Content: budgetTerminalText(r)}, nil
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
	message := Message{ID: randomID(), SessionID: r.SessionID, TaskID: r.TaskID, RunID: r.ID, Role: "assistant", Origin: result.Origin, Content: result.Content, RunStatus: r.Status, CreatedAt: r.EndedAt}
	return s.appendMessage(ctx, tx, &message)
}

type ReportStep struct {
	CallID   string   `json:"callId"`
	Tool     string   `json:"tool"`
	Status   string   `json:"status"`
	Attempts int      `json:"attempts"`
	Error    *Failure `json:"error,omitempty"`
}
type RunReport struct {
	Outcome     string       `json:"outcome"`
	Reason      string       `json:"reason"`
	Completed   int          `json:"completed"`
	Failed      int          `json:"failed"`
	Unconfirmed int          `json:"unconfirmed"`
	Steps       []ReportStep `json:"steps"`
	Remaining   []string     `json:"remaining"`
	Next        string       `json:"next"`
	Analysis    string       `json:"analysis,omitempty"`
}

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
	if r.Error != nil {
		report.Reason = r.Error.Message
	}
	if r.Status == StateCancelled {
		report.Outcome = "本轮任务已停止，已取得的执行事实已保存。"
		if r.Error == nil {
			report.Reason = "用户已停止本轮任务"
		}
	}
	for _, call := range calls {
		if call.Tool == toolSearchName || call.Tool == planTool || call.Tool == userInputTool {
			continue
		}
		fact := projectToolExecution(r, byCall[call.ID], &call, nil)
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
func (r *RunReport) text() string {
	text := r.Outcome + "\n\n问题：" + r.Reason + fmt.Sprintf("\n\n执行情况：%d 项调用已确认成功，%d 项失败，%d 项结果未确认。", r.Completed, r.Failed, r.Unconfirmed)
	if len(r.Steps) > 0 {
		text += "\n\n处理记录："
		for _, s := range r.Steps {
			state := map[string]string{StateSucceeded: "已确认成功", StateFailed: "失败", "unknown": "结果未确认", "not-executed": "未执行"}[s.Status]
			if state == "" {
				state = "未确认完成"
			}
			text += fmt.Sprintf("\n- `%s`：%s", s.Tool, state)
			if s.Attempts > 1 {
				text += fmt.Sprintf("，尝试 %d 次", s.Attempts)
			}
			if s.Error != nil {
				text += "；" + s.Error.Message
			}
		}
	}
	if len(r.Remaining) > 0 {
		text += "\n\n未完成：" + strings.Join(r.Remaining, "；") + "。"
	}
	if r.Analysis != "" {
		text += "\n\n原因分析（模型根据以上事实生成）：" + r.Analysis
	}
	return text + "\n\n下一步：" + r.Next
}
