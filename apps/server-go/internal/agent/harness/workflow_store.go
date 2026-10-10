package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

type workflowQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readWorkflow(ctx context.Context, q workflowQuery, id string) (WorkflowInstance, error) {
	var w WorkflowInstance
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM workflow_instances WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return w, notFound()
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &w)
	}
	return w, err
}
func readWorkflowDefinition(ctx context.Context, q workflowQuery, id string, revision int) (WorkflowDefinition, error) {
	var d WorkflowDefinition
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM workflow_definitions WHERE id=? AND (?=0 OR revision=?) ORDER BY revision DESC LIMIT 1", id, revision, revision).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return d, notFound()
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &d)
	}
	return d, err
}
func saveWorkflow(ctx context.Context, tx *sql.Tx, w *WorkflowInstance) error {
	w.Revision++
	w.AllowedActions = []string{} // 可行动作依赖当前屏障与运行位置，只在查询时计算。
	raw, err := json.Marshal(w)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE workflow_instances SET state=?,ready_at=?,document=? WHERE id=?", w.Status, w.ReadyAt, string(raw), w.ID)
	return err
}
func readWorkflowAttempt(ctx context.Context, q workflowQuery, runID string) (WorkflowAttempt, error) {
	var a WorkflowAttempt
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM workflow_attempts WHERE run_id=?", runID).Scan(&raw)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &a)
	}
	return a, err
}
func saveWorkflowAttempt(ctx context.Context, tx *sql.Tx, a WorkflowAttempt) error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO workflow_attempts(workflow_id,step_id,number,run_id,state,document) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state,document=excluded.document`, a.WorkflowID, a.StepID, a.Number, a.RunID, a.Status, string(raw))
	return err
}
func workflowStep(d WorkflowDefinition, id string) (WorkflowStepDefinition, error) {
	for _, s := range d.Steps {
		if s.ID == id {
			return s, nil
		}
	}
	return WorkflowStepDefinition{}, bad("workflow-step", "工作流步骤不存在")
}
func (s *store) workflowEvent(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, kind, detail string) error {
	w.LastSeq = nextSeq(w.LastSeq)
	w.UpdatedAt = stamp(s.now())
	e := WorkflowEvent{WorkflowID: w.ID, Seq: w.LastSeq, Type: kind, StepID: w.CurrentStepID, RunID: w.ActiveRunID, At: w.UpdatedAt, Detail: detail}
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	n, _ := strconv.ParseInt(w.LastSeq, 10, 64)
	if _, err = tx.ExecContext(ctx, "INSERT INTO workflow_events(workflow_id,seq,document) VALUES(?,?,?)", w.ID, n, string(raw)); err != nil {
		return err
	}
	return saveWorkflow(ctx, tx, w)
}
func workflowOutput(ctx context.Context, q workflowQuery, a WorkflowAttempt) (string, error) {
	if a.OutputCallID != "" {
		var raw string
		var c Call
		err := q.QueryRowContext(ctx, "SELECT document FROM calls WHERE id=?", a.OutputCallID).Scan(&raw)
		if err != nil {
			return "", err
		}
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			return "", err
		}
		if len(c.Result) == 0 {
			return "null", nil
		}
		return string(c.Result), nil
	}
	if a.OutputRequestID != "" {
		var raw string
		var r ModelRequestRecord
		err := q.QueryRowContext(ctx, "SELECT document FROM model_requests WHERE id=?", a.OutputRequestID).Scan(&raw)
		if err != nil {
			return "", err
		}
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			return "", err
		}
		if r.Response == nil || len(r.Response.ToolCalls) != 1 {
			return "", bad("workflow-output", "步骤结构化结果缺失")
		}
		return string(r.Response.ToolCalls[0].Arguments), nil
	}
	return a.OutputJSON, nil
}
func workflowOutputs(ctx context.Context, tx *sql.Tx, id string) (map[string]string, error) {
	attempts, err := readDocuments[WorkflowAttempt](ctx, tx, "SELECT document FROM workflow_attempts WHERE workflow_id=? AND state='succeeded' ORDER BY number", id)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, a := range attempts {
		v, e := workflowOutput(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		out[a.StepID] = v
	}
	return out, nil
}
func (s *store) finishWorkflowRun(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if workflowV2(w) {
		return s.finishWorkflowV2Run(ctx, tx, r)
	}
	if terminal(w.Status) || w.ActiveRunID != r.ID {
		return nil
	}
	a, err := readWorkflowAttempt(ctx, tx, r.ID)
	if err != nil {
		return err
	}
	if a.Status == StateSucceeded {
		return nil
	}
	a.Status = r.Status
	a.EndedAt = r.EndedAt
	a.EventSeq = r.LastSeq
	if r.Status == StateSucceeded {
		a.OutputJSON = r.WorkflowOutputJSON
		a.OutputCallID = r.WorkflowOutputCallID
		a.OutputRequestID = r.WorkflowOutputRequestID
		a.CompletionSource = "execution"
		if a.OutputRequestID != "" {
			a.OutputJSON = ""
			r.WorkflowOutputJSON = ""
		}
		v, e := readWorkspaceVersion(ctx, tx, r.TaskID)
		if e != nil {
			return e
		}
		a.WorkspaceRevision = v.Revision
		if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
			return err
		}
		if err = s.advanceWorkflow(ctx, tx, &w, a, r.WorkflowNext); err != nil {
			return err
		}
	} else {
		if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
			return err
		}
		w.Status = StateRecoveryRequired
		w.Error = r.Error
		if w.Error == nil {
			w.Error = &Failure{Code: r.EndReason, Message: "步骤未完成，需要人工恢复"}
		}
		if r.Status == StateCancelled || w.CancelRequestedAt != "" {
			w.Status = StateCancelled
		}
		if r.EndReason == "approval-denied" || r.EndReason == "workflow-budget" {
			w.Status = StateFailed
		}
		if terminal(w.Status) {
			w.EndedAt = stamp(s.now())
		}
		if err = s.workflowEvent(ctx, tx, &w, "workflow/"+w.Status, w.Error.Message); err != nil {
			return err
		}
	}
	return saveRun(ctx, tx, r)
}
func (s *store) advanceWorkflow(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, a WorkflowAttempt, next string) error {
	d, err := readWorkflowDefinition(ctx, tx, w.DefinitionID, w.DefinitionRevision)
	if err != nil {
		return err
	}
	step, err := workflowStep(d, a.StepID)
	if err != nil {
		return err
	}
	w.Error = nil
	if step.Finish != nil {
		outputs, e := workflowOutputs(ctx, tx, w.ID)
		if e != nil {
			return e
		}
		output, e := evaluateWorkflowBinding(*step.Finish, w.InputJSON, outputs)
		if e == nil {
			e = validateWorkflowJSON(d.OutputSchemaJSON, output)
		}
		if e != nil {
			w.Status = StateRecoveryRequired
			w.Error = &Failure{Code: "workflow-output", Message: "流程最终输出不符合固定契约"}
			return s.workflowEvent(ctx, tx, w, "workflow/recovery-required", w.Error.Message)
		}
		w.OutputJSON = output
		w.Status = StateSucceeded
		w.EndedAt = stamp(s.now())
		w.ActiveRunID = ""
		if err = s.enqueueWikiWorkflowExtraction(ctx, tx, w); err != nil {
			return err
		}
	} else {
		if step.Kind != "condition" {
			next = step.Next
		}
		if next == "" {
			return bad("workflow-next", "工作流后继步骤缺失")
		}
		w.CurrentStepID = next
		w.ActiveRunID = ""
		w.Status = StateReady
		w.ReadyAt = stamp(s.now())
	}
	return s.workflowEvent(ctx, tx, w, "workflow/"+w.Status, "")
}
func (s *store) syncWorkflowRun(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.WorkflowID == "" || terminal(r.Status) {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if workflowV2(w) {
		return s.syncWorkflowV2Run(ctx, tx, r)
	}
	if terminal(w.Status) || w.ActiveRunID != r.ID {
		return nil
	}
	a, err := readWorkflowAttempt(ctx, tx, r.ID)
	if err != nil {
		return err
	}
	a.Status = r.Status
	if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
		return err
	}
	if w.Status == r.Status {
		return nil
	}
	w.Status = r.Status
	return s.workflowEvent(ctx, tx, &w, "workflow/"+r.Status, "")
}
func (m *Manager) workflowReserveModel(ctx context.Context, tx *sql.Tx, r *Run, estimated int) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if w.Usage.ModelRequests >= w.Limits.ModelRequests || w.Usage.Tokens+estimated > w.Limits.Tokens {
		return bad("workflow-budget", "工作流模型请求或 token 预算不足")
	}
	if w.GateClosed || terminal(w.Status) || w.Status == StateRecoveryRequired {
		return bad("workflow-dispatch-closed", "流程派发已冻结，等待在途操作收尾与人工恢复")
	}
	w.Usage.ModelRequests++
	w.Usage.Tokens += estimated
	return saveWorkflow(ctx, tx, &w)
}
func (m *Manager) workflowSettleModel(ctx context.Context, tx *sql.Tx, r *Run, reserved, charge int) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	w.Usage.Tokens += charge - reserved
	return saveWorkflow(ctx, tx, &w)
}
func (m *Manager) workflowReserveCall(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if w.GateClosed || terminal(w.Status) || w.Status == StateRecoveryRequired {
		return bad("workflow-dispatch-closed", "流程派发已冻结，等待在途操作收尾与人工恢复")
	}
	if w.Usage.Calls >= w.Limits.Calls || w.Usage.ResultBytes+r.Limits.ResultBytes > w.Limits.ResultBytes {
		return bad("workflow-budget", "工作流能力调用或结果预算不足")
	}
	w.Usage.Calls++
	w.Usage.ResultBytes += r.Limits.ResultBytes
	return saveWorkflow(ctx, tx, &w)
}
func (m *Manager) workflowSettleCall(ctx context.Context, tx *sql.Tx, r *Run, resultBytes int) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	w.Usage.ResultBytes += resultBytes - r.Limits.ResultBytes
	return saveWorkflow(ctx, tx, &w)
}
func (m *Manager) workflowReserveTime(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if w.GateClosed || terminal(w.Status) || w.Status == StateRecoveryRequired {
		return bad("workflow-dispatch-closed", "流程派发已冻结，等待人工恢复")
	}
	available := w.Limits.ActiveMilliseconds - w.Usage.ActiveMilliseconds - w.Usage.ReservedMilliseconds
	if available <= 0 {
		return bad("workflow-budget", "工作流累计活动时间已耗尽")
	}
	reserve := int64(r.Limits.RunTimeoutSeconds)*1000 - r.ActiveMilliseconds
	if reserve > available {
		reserve = available
	}
	r.WorkflowActiveReserved = reserve
	w.Usage.ReservedMilliseconds += reserve
	return saveWorkflow(ctx, tx, &w)
}
func (m *Manager) workflowSettleTime(ctx context.Context, tx *sql.Tx, r *Run, elapsed time.Duration) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	w.Usage.ReservedMilliseconds -= r.WorkflowActiveReserved
	w.Usage.ActiveMilliseconds += elapsed.Milliseconds()
	r.WorkflowActiveReserved = 0
	if err = saveWorkflow(ctx, tx, &w); err != nil {
		return err
	}
	if err = m.store.failWorkflowActiveBudget(ctx, tx, &w, r); err != nil {
		return err
	}
	if workflowV2(w) && terminal(w.Status) {
		for _, execution := range m.executions {
			if execution.rootID == "workflow:"+w.ID {
				execution.cancel()
			}
		}
	}
	return nil
}

// 活动时间是所有后续步骤都需要的额度。只在已经结算耗尽后关闭实例，
// 不把模型或工具额度恰好用完推广为整个工作流失败。
func (s *store) failWorkflowActiveBudget(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, current *Run) error {
	if terminal(w.Status) || w.CancelRequestedAt != "" || w.Usage.ActiveMilliseconds < w.Limits.ActiveMilliseconds {
		return nil
	}
	if current != nil && current.CancelRequestedAt != "" {
		return nil
	}
	failure := &Failure{Code: "workflow-budget", Message: "工作流累计活动时间已耗尽，无法继续或恢复"}
	if workflowV2(*w) {
		return s.failWorkflowV2Budget(ctx, tx, w, current, failure)
	}
	endedAt := stamp(s.now())
	if w.ActiveRunID != "" {
		if current == nil || current.ID != w.ActiveRunID {
			r, err := readRun(ctx, tx, w.ActiveRunID)
			if err != nil {
				return err
			}
			current = &r
		}
		if !terminal(current.Status) {
			current.Status = StateFailed
			current.EndReason = failure.Code
			current.Error = failure
			current.EndedAt = endedAt
			current.MemoryStatus = "stale"
			if err := s.event(ctx, tx, current, "run/failed", "", nil, failure); err != nil {
				return err
			}
			a, err := readWorkflowAttempt(ctx, tx, current.ID)
			if err != nil {
				return err
			}
			a.Status = current.Status
			a.EndedAt = current.EndedAt
			a.EventSeq = current.LastSeq
			if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
				return err
			}
		}
		approvals, err := readDocuments[Approval](ctx, tx, "SELECT document FROM approvals WHERE run_id=? AND state IN ('pending','approved')", w.ActiveRunID)
		if err != nil {
			return err
		}
		for _, a := range approvals {
			a.Status = "revoked"
			if err = saveApproval(ctx, tx, a); err != nil {
				return err
			}
		}
	}
	w.Status = StateFailed
	w.Error = failure
	w.EndedAt = endedAt
	if err := s.workflowEvent(ctx, tx, w, "workflow/failed", failure.Message); err != nil {
		return err
	}
	return s.releaseWorkflowSession(ctx, tx, *w)
}
