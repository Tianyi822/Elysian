package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

const resourceBudgetPolicy = "resource-budget/v1"

// 新普通聊天显式返回零次数限额；批次与旧快照保留既有的可选字段形状。
func (l Limits) MarshalJSON() ([]byte, error) {
	type limitsJSON Limits
	if l.MaxModelRequests == 0 && l.MaxSteps == 0 && l.TokenBudget > 0 {
		return json.Marshal(struct {
			MaxModelRequests int `json:"maxModelRequests"`
			limitsJSON
		}{0, limitsJSON(l)})
	}
	return json.Marshal(limitsJSON(l))
}

// BudgetStop 保存本轮资源边界，不表示任务已完成或外部操作已停止。
// 活动时间的 used/limit 使用毫秒，其余分别为 token 和字节。
type BudgetStop struct {
	Resource string `json:"resource"`
	Used     int64  `json:"used"`
	Limit    int64  `json:"limit"`
}

type Continuation struct {
	SourceRunID   string `json:"sourceRunId"`
	Allowed       bool   `json:"allowed"`
	BlockedReason string `json:"blockedReason,omitempty"`
}

func resourceBudgetRun(r Run) bool {
	return r.BudgetPolicy == resourceBudgetPolicy && r.SessionID != "" && r.WorkflowID == "" && r.DriverVersion == "v2"
}

func callLimitReached(r Run) bool {
	return !(resourceBudgetRun(r) && r.Limits.MaxSteps == 0) && r.Usage.Calls >= r.Limits.MaxSteps
}

func modelLimitReached(r Run, additional, reserve int) bool {
	return !(resourceBudgetRun(r) && r.Limits.MaxModelRequests == 0) && r.Usage.ModelRequests+additional > r.Limits.MaxModelRequests-reserve
}

func toolTokenBudget(r Run) error {
	if resourceBudgetRun(r) && r.Usage.Tokens >= r.Limits.TokenBudget {
		return bad("token-budget", "本轮 token 额度已用完")
	}
	return nil
}

// 每个已派发调用在自身回执中预留容量，暂停、重启和异步结算均可恢复。
// 内部同步工具按实际结果检查；等待用户回答与外部调用按单次上限预留。
func ensureResultBudget(ctx context.Context, q rowReader, r Run, size int) error {
	if !resourceBudgetRun(r) {
		return nil
	}
	var reserved int64
	if err := q.QueryRowContext(ctx, `SELECT COALESCE(SUM(COALESCE(json_extract(document,'$.reservedResultBytes'),0)),0) FROM calls WHERE run_id=?`, r.ID).Scan(&reserved); err != nil {
		return err
	}
	if int64(r.Usage.ResultBytes)+reserved+int64(size) > int64(r.Limits.RunResultBytes) {
		return bad("result-budget", "本轮剩余结果容量不足以接受下一次工具回执")
	}
	return nil
}

func budgetStopFor(r Run, reason string) *BudgetStop {
	if !resourceBudgetRun(r) {
		return nil
	}
	switch reason {
	case "token-budget", "model-budget":
		return &BudgetStop{Resource: "tokens", Used: int64(r.Usage.Tokens), Limit: int64(r.Limits.TokenBudget)}
	case "run-timeout":
		return &BudgetStop{Resource: "active-time", Used: r.ActiveMilliseconds, Limit: int64(r.Limits.RunTimeoutSeconds) * 1000}
	case "result-budget":
		return &BudgetStop{Resource: "results", Used: int64(r.Usage.ResultBytes), Limit: int64(r.Limits.RunResultBytes)}
	}
	return nil
}

func budgetTerminalText(r Run) string {
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

func budgetContinuationCandidate(r Run) bool {
	if r.SessionID == "" || r.WorkflowID != "" || r.CancelRequestedAt != "" || r.SupersededByRunID != "" || (r.Status != StateFailed && r.Status != StateInterrupted) {
		return false
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
	case "call-budget", "call-limit", "model-budget", "token-budget", "run-timeout", "result-budget", "panel-update":
		return true
	}
	return false
}

// continuation 与接受事务共用判定，避免客户端把过期按钮或未知回执解释成授权。
func continuation(ctx context.Context, q rowReader, r Run) (*Continuation, error) {
	if !budgetContinuationCandidate(r) {
		return nil, nil
	}
	out := &Continuation{SourceRunID: r.ID}
	var latest string
	if err := q.QueryRowContext(ctx, `SELECT id FROM runs WHERE session_id=? AND COALESCE(json_extract(document,'$.supersededByRunId'),'')='' ORDER BY rowid DESC LIMIT 1`, r.SessionID).Scan(&latest); err != nil {
		return nil, err
	}
	if latest != r.ID {
		out.BlockedReason = "会话已有新轮次，请刷新后继续"
		return out, nil
	}
	session, err := readSession(ctx, q, r.SessionID)
	if err != nil {
		return nil, err
	}
	var unknown bool
	if err := q.QueryRowContext(ctx, `SELECT
 EXISTS(SELECT 1 FROM operations o JOIN runs r ON r.id=o.run_id WHERE r.session_id=? AND (o.state IN ('dispatched','waiting-task') OR (o.state='unknown' AND NOT EXISTS(SELECT 1 FROM execution_barriers settled WHERE settled.operation_id=o.id AND settled.state='reconciled')))) OR
 EXISTS(SELECT 1 FROM execution_barriers b JOIN runs r ON r.id=b.run_id WHERE r.session_id=? AND b.state IN ('dispatched','unknown')) OR
 EXISTS(SELECT 1 FROM resource_leases l JOIN runs r ON r.id=l.run_id WHERE r.session_id=? AND l.state IN ('held','unknown')) OR
 EXISTS(SELECT 1 FROM calls c JOIN runs r ON r.id=c.run_id WHERE r.session_id=? AND c.state IN ('running','interrupted','recovery-required') AND NOT EXISTS(SELECT 1 FROM execution_barriers b WHERE b.operation_id=json_extract(c.document,'$.operationId') AND b.state='reconciled'))`, r.SessionID, r.SessionID, r.SessionID, r.SessionID).Scan(&unknown); err != nil {
		return nil, err
	}
	if !unknown {
		if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM operations o JOIN resource_leases l ON l.operation_id=json_extract(o.document,'$.resourceWait.operationId') WHERE o.run_id=? AND l.state IN ('held','unknown')) OR EXISTS(SELECT 1 FROM operations o JOIN execution_barriers b ON b.operation_id=json_extract(o.document,'$.resourceWait.operationId') WHERE o.run_id=? AND b.state IN ('dispatched','unknown'))`, r.ID, r.ID).Scan(&unknown); err != nil {
			return nil, err
		}
	}
	if unknown {
		out.BlockedReason = "存在结果未知或尚未释放的操作，请先核实实际状态"
	} else if session.ActiveRunID != "" || session.ActiveWorkflowID != "" {
		out.BlockedReason = "会话仍有任务运行，请等待结束"
	} else {
		out.Allowed = true
	}
	return out, nil
}

func prepareContinuation(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.Selection == nil || r.Selection.ContinueFromRunID == "" {
		return nil
	}
	source, err := readRun(ctx, tx, r.Selection.ContinueFromRunID)
	if err != nil {
		if isNotFound(err) {
			return &Error{409, "continuation-changed", "原轮次已不存在，请刷新会话"}
		}
		return err
	}
	if source.TaskID != r.TaskID || source.SessionID != r.SessionID || !budgetContinuationCandidate(source) {
		return &Error{409, "continuation-changed", "原轮次不再支持继续，请刷新会话"}
	}
	state, err := continuation(ctx, tx, source)
	if err != nil {
		return err
	}
	if !state.Allowed {
		return &Error{409, "continuation-blocked", state.BlockedReason}
	}
	if source.Plan != nil {
		plan := &RunPlan{SourceRunID: source.ID, Revision: 1, UpdatedAt: r.CreatedAt, Steps: append([]PlanStep(nil), source.Plan.Steps...)}
		for i := range plan.Steps {
			if plan.Steps[i].Status == "in_progress" {
				plan.Steps[i].Status = "pending"
			}
		}
		r.Plan = plan
	}
	return nil
}
