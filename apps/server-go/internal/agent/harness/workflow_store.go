package harness

import (
	"context"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
)

func (m *Manager) workflowReserveModel(ctx context.Context, tx sessionstore.Tx, r *Run, estimated int) error {
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
	if w.GateClosed || hstate.Terminal(w.Status) || w.Status == StateRecoveryRequired {
		return bad("workflow-dispatch-closed", "流程派发已冻结，等待在途操作收尾与人工恢复")
	}
	w.Usage.ModelRequests++
	w.Usage.Tokens += estimated
	return saveWorkflow(ctx, tx, &w)
}
func (m *Manager) workflowSettleModel(ctx context.Context, tx sessionstore.Tx, r *Run, reserved, charge int) error {
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
func (m *Manager) workflowReserveCall(ctx context.Context, tx sessionstore.Tx, r *Run) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if w.GateClosed || hstate.Terminal(w.Status) || w.Status == StateRecoveryRequired {
		return bad("workflow-dispatch-closed", "流程派发已冻结，等待在途操作收尾与人工恢复")
	}
	if w.Usage.Calls >= w.Limits.Calls || w.Usage.ResultBytes+r.Limits.ResultBytes > w.Limits.ResultBytes {
		return bad("workflow-budget", "工作流能力调用或结果预算不足")
	}
	w.Usage.Calls++
	w.Usage.ResultBytes += r.Limits.ResultBytes
	return saveWorkflow(ctx, tx, &w)
}
func (m *Manager) workflowSettleCall(ctx context.Context, tx sessionstore.Tx, r *Run, resultBytes int) error {
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
func (m *Manager) workflowReserveTime(ctx context.Context, tx sessionstore.Tx, r *Run) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if w.GateClosed || hstate.Terminal(w.Status) || w.Status == StateRecoveryRequired {
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
func (m *Manager) workflowSettleTime(ctx context.Context, tx sessionstore.Tx, r *Run, elapsed time.Duration) error {
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
	if err = tx.FailWorkflowActiveBudget(ctx, &w, r); err != nil {
		return err
	}
	if hstate.WorkflowV2(w) && hstate.Terminal(w.Status) {
		for _, execution := range m.executions {
			if execution.rootID == "workflow:"+w.ID {
				execution.cancel()
			}
		}
	}
	return nil
}
