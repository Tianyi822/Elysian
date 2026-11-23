package harness

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
)

func (m *Manager) CancelWorkflow(ctx context.Context, id string) (WorkflowInstance, error) {
	guardErr := m.checkDispatchGuard()
	m.mu.Lock()
	defer m.mu.Unlock()
	var w WorkflowInstance
	if err := m.agentWritableLocked(guardErr); err != nil {
		return w, err
	}
	err := writeStore(m.store, ctx, "workflow-cancel", func(tx sessionstore.Tx) error {
		var e error
		w, e = readWorkflow(ctx, tx, id)
		if e != nil {
			return e
		}
		if state.Terminal(w.Status) {
			return nil
		}
		if state.WorkflowV2(w) {
			return m.cancelWorkflowV2(ctx, tx, &w)
		}
		w.CancelRequestedAt = stamp(m.deps.Now())
		if e = tx.WorkflowEvent(ctx, &w, "workflow/cancel-requested", ""); e != nil {
			return e
		}
		if w.ActiveRunID != "" {
			r, e := readRun(ctx, tx, w.ActiveRunID)
			if e != nil {
				return e
			}
			r.CancelRequestedAt = w.CancelRequestedAt
			approvals, e := tx.NodeApprovals(ctx, r.ID)
			if e != nil {
				return e
			}
			for _, a := range approvals {
				if a.Status == "pending" || a.Status == "approved" {
					a.Status = "revoked"
					if e = saveApproval(ctx, tx, a); e != nil {
						return e
					}
				}
			}
			if r.Status == StateRunning {
				return tx.Event(ctx, &r, "run/cancel-requested", "", nil, nil)
			}
			if !state.Terminal(r.Status) {
				r.Status = StateCancelled
				r.EndedAt = w.CancelRequestedAt
				r.EndReason = "cancelled"
				if e = tx.Event(ctx, &r, "run/cancelled", "", nil, nil); e != nil {
					return e
				}
				if e = tx.ReleaseSession(ctx, &r); e != nil {
					return e
				}
				w, e = readWorkflow(ctx, tx, id)
				return e
			}
		}
		w.Status = StateCancelled
		w.EndedAt = w.CancelRequestedAt
		if e = tx.WorkflowEvent(ctx, &w, "workflow/cancelled", ""); e != nil {
			return e
		}
		return tx.ReleaseWorkflowSession(ctx, w)
	})
	if execution := m.executionLocked(w.ActiveRunID); err == nil && execution != nil {
		execution.cancel()
	}
	if err == nil && state.WorkflowV2(w) {
		for _, execution := range m.executions {
			if execution.rootID == "workflow:"+w.ID {
				execution.cancel()
			}
		}
	}
	if err == nil {
		w, err = readWorkflow(ctx, m.store, id)
	}
	m.signal()
	return w, storageFailure(err)
}
func (m *Manager) RecoverWorkflow(ctx context.Context, id string, input WorkflowRecoveryInput) (WorkflowInstance, bool, error) {
	guardErr := m.checkDispatchGuard()
	m.mu.Lock()
	defer m.mu.Unlock()
	var w WorkflowInstance
	if m.closed {
		return w, false, closedError()
	}
	if !requestPattern.MatchString(input.RequestID) {
		return w, false, bad("invalid-request-id", "恢复请求标识无效")
	}
	raw, _ := json.Marshal(input)
	canonical := string(raw)
	var prior, document string
	err := readView(ctx, m.store).WorkflowRecoveryRequest(ctx, id, input.RequestID, &prior, &document)
	if err == nil {
		if prior != canonical {
			return w, false, &Error{Status: 409, Code: "request-conflict", Message: "相同恢复请求标识对应不同输入"}
		}
		err = json.Unmarshal([]byte(document), &w)
		return w, true, err
	}
	if !errors.Is(err, sessionstore.ErrNotFound) {
		return w, false, storageFailure(err)
	}
	if err = m.agentWritableLocked(guardErr); err != nil {
		return w, false, err
	}
	if err = recoveryEvidence(input); err != nil {
		return w, false, err
	}
	w, err = readWorkflow(ctx, m.store, id)
	if err != nil {
		return w, false, storageFailure(err)
	}
	if w.Revision != input.ExpectedRevision {
		return w, false, &Error{Status: 409, Code: "revision-conflict", Message: "工作流状态版本已变化"}
	}
	if w.Status != StateRecoveryRequired || w.CancelRequestedAt != "" {
		return w, false, &Error{Status: 409, Code: "workflow-state", Message: "流程不处于可恢复状态"}
	}
	var count int
	if err = readView(ctx, m.store).UnresolvedBarrierCount(ctx, &count); err != nil {
		return w, false, storageFailure(err)
	}
	if count > 0 {
		return w, false, &Error{Status: 409, Code: "execution-barrier", Message: "必须先核实全部未知执行屏障"}
	}
	if m.executionLocked(w.ActiveRunID) != nil {
		return w, false, &Error{Status: 409, Code: "workflow-active", Message: "原执行尚未确认停止"}
	}
	if state.WorkflowV2(w) {
		return m.recoverWorkflowV2(ctx, w, input, canonical)
	}
	d, err := readWorkflowDefinition(ctx, m.store, w.DefinitionID, w.DefinitionRevision)
	if err != nil {
		return w, false, storageFailure(err)
	}
	step, err := state.WorkflowStep(d, w.CurrentStepID)
	if err != nil {
		return w, false, err
	}
	var r Run
	if w.ActiveRunID != "" {
		r, err = readRun(ctx, m.store, w.ActiveRunID)
		if err != nil {
			return w, false, storageFailure(err)
		}
	}
	// 固定环境不能通过人工恢复规避显式撤销。
	if err = m.checkWorkflowEnvironment(ctx, w); err != nil {
		return w, false, err
	}
	err = writeStore(m.store, ctx, "workflow-recovery", func(tx sessionstore.Tx) error {
		if err := validateWorkflowV1RecoverySources(ctx, tx, w); err != nil {
			return err
		}
		if w.Usage.ActiveMilliseconds+w.Usage.ReservedMilliseconds >= w.Limits.ActiveMilliseconds || w.Usage.ModelRequests >= w.Limits.ModelRequests || w.Usage.Tokens >= w.Limits.Tokens || w.Usage.Calls >= w.Limits.Calls || w.Usage.ResultBytes >= w.Limits.ResultBytes {
			return bad("workflow-budget", "流程累计预算已耗尽，不能恢复")
		}
		switch input.Action {
		case "continue":
			if w.Error == nil || w.Error.Code != "maintenance-recovery" {
				return &Error{Status: 409, Code: "unsafe-resume", Message: "只能从维护冻结的已确认边界继续"}
			}
			if r.ID == "" {
				w.Status = StateReady
				w.ReadyAt = stamp(m.deps.Now())
				break
			}
			if r.WorkflowFrozenFrom != StateQueued {
				return &Error{Status: 409, Code: "unsafe-resume", Message: "该步骤不是未派发边界，应重新审批、重试或补录"}
			}
			var approvals int
			if e := tx.PendingWorkflowApprovalCount(ctx, r.ID, &approvals); e != nil {
				return e
			}
			if approvals > 0 {
				return &Error{Status: 409, Code: "unsafe-resume", Message: "原审批已经撤销，应明确重新申请"}
			}
			var operations int
			if e := tx.DispatchedOperationCount(ctx, r.ID, &operations); e != nil {
				return e
			}
			if operations > 0 {
				return &Error{Status: 409, Code: "unsafe-resume", Message: "保存的操作需要重新核对审批"}
			}
			r.Status = StateQueued
			r.WorkflowFrozenFrom = ""
			if e := saveRun(ctx, tx, &r); e != nil {
				return e
			}
			w.Status = StateQueued
		case "renew-approval":
			if r.ID == "" || state.Terminal(r.Status) {
				return &Error{Status: 409, Code: "unsafe-resume", Message: "只能重新申请尚未派发步骤的审批"}
			}
			approvals, e := tx.NodeApprovals(ctx, r.ID)
			if e != nil {
				return e
			}
			if len(approvals) == 0 {
				return bad("approval-missing", "没有可重新申请的审批")
			}
			old := approvals[len(approvals)-1]
			var pending int
			if e = tx.PendingApprovalCount(ctx, &pending); e != nil {
				return e
			}
			if pending >= 32 {
				return &Error{Status: 429, Code: "approvals-full", Message: "待审批运行已达上限"}
			}
			for _, a := range approvals {
				if a.Status == "pending" || a.Status == "approved" {
					a.Status = "revoked"
					if e = saveApproval(ctx, tx, a); e != nil {
						return e
					}
				}
			}
			renewed := old
			renewed.ID = m.deps.NewID()
			renewed.Status = "pending"
			renewed.Decision = ""
			renewed.DecidedAt = ""
			renewed.CreatedAt = stamp(m.deps.Now())
			renewed.ExpiresAt = stamp(m.deps.Now().Add(24 * time.Hour))
			if old.OperationID != "" {
				o, e := readOperation(ctx, tx, old.OperationID)
				if e != nil {
					return e
				}
				if o.DispatchID != "" || o.Status == "completed" || o.Status == "unknown" {
					return &Error{Status: 409, Code: "operation-dispatched", Message: "已派发操作不能重新申请原审批"}
				}
				v, e := readWorkspaceVersion(ctx, tx, w.TaskID)
				if e != nil {
					return e
				}
				if v.Revision != o.WorkspaceRevision {
					return &Error{Status: 409, Code: "workspace-conflict", Message: "工作区版本与原操作审批基线不同"}
				}
				o.ApprovalID = renewed.ID
				o.Status = StateWaitingApproval
				renewed.Operation = o
				if e = saveOperation(ctx, tx, o); e != nil {
					return e
				}
			}
			if e = saveApproval(ctx, tx, renewed); e != nil {
				return e
			}
			r.Status = StateWaitingApproval
			r.EndedAt = ""
			r.EndReason = ""
			r.Error = nil
			r.Phase = StateWaitingApproval
			if e = tx.Event(ctx, &r, "approval/renewed", "", nil, map[string]string{"approvalId": renewed.ID}); e != nil {
				return e
			}
			w, e = readWorkflow(ctx, tx, id)
			if e != nil {
				return e
			}
			w.Status = StateWaitingApproval
		case "retry":
			if r.ID != "" {
				a, e := readWorkflowAttempt(ctx, tx, r.ID)
				if e != nil {
					return e
				}
				if a.Status == StateSucceeded {
					return &Error{Status: 409, Code: "already-completed", Message: "已提交完成凭据的步骤不能重做"}
				}
			}

			if r.ID != "" && !state.Terminal(r.Status) {
				return &Error{Status: 409, Code: "unsafe-retry", Message: "尚未派发的暂停步骤应继续或重新申请审批"}
			}
			var attempts int
			if e := tx.WorkflowStepAttemptCount(ctx, w.ID, step.ID, &attempts); e != nil {
				return e
			}
			if attempts >= w.Limits.Attempts {
				return bad("attempt-budget", "步骤尝试次数已耗尽")
			}
			w.ActiveRunID = ""
			w.Status = StateReady
			w.ReadyAt = stamp(m.deps.Now())
		case "accept-result":
			barriers, e := tx.NodeBarriers(ctx, r.ID)
			if e != nil {
				return e
			}
			for _, b := range barriers {
				if b.Status == "reconciled" && b.Decision != "confirmed-completed" {
					return &Error{Status: 409, Code: "resolution-conflict", Message: "该尝试已核实为停止，只能明确重试，不能补录为完成"}
				}
			}

			if r.ID == "" || !state.Terminal(r.Status) || step.Kind == "approval" || step.Kind == "condition" {
				return &Error{Status: 409, Code: "invalid-resolution", Message: "只能补录已终止 Agent 或操作步骤的外部结果"}
			}
			if len(input.OutputJSON) > r.Limits.ResultBytes || w.Usage.ResultBytes+len(input.OutputJSON) > w.Limits.ResultBytes {
				return &Error{Status: 413, Code: "output-too-large", Message: "补录结果超过容量或流程预算"}
			}
			if e := state.ValidateWorkflowJSON(step.OutputSchemaJSON, input.OutputJSON); e != nil {
				return e
			}
			a, e := readWorkflowAttempt(ctx, tx, r.ID)
			if e != nil {
				return e
			}
			if a.Status == StateSucceeded {
				return &Error{Status: 409, Code: "already-completed", Message: "步骤已经有完成凭据"}
			}
			a.Status = StateSucceeded
			a.OutputJSON = input.OutputJSON
			a.OutputCallID = ""
			a.OutputRequestID = ""
			a.CompletionSource = "operator"
			a.Evidence = input.Evidence
			a.EndedAt = stamp(m.deps.Now())
			if e = tx.Event(ctx, &r, "workflow/result-recorded", "", nil, map[string]string{"evidence": input.Evidence}); e != nil {
				return e
			}
			a.EventSeq = r.LastSeq
			v, e := readWorkspaceVersion(ctx, tx, w.TaskID)
			if e != nil {
				return e
			}
			a.WorkspaceRevision = v.Revision
			// 补录字节与 v2 一样计入实例累计预算，避免多次补录游离于 8 MiB 上限之外。
			w.Usage.ResultBytes += len(input.OutputJSON)
			if e = saveWorkflowAttempt(ctx, tx, a); e != nil {
				return e
			}
			if e = tx.AdvanceWorkflow(ctx, &w, a, ""); e != nil {
				return e
			}
		default:
			return bad("invalid-recovery", "未知工作流恢复动作")
		}
		if w.Status != StateRecoveryRequired {
			w.Error = nil
		}
		if e := tx.WorkflowEvent(ctx, &w, "workflow/recovered", input.Action+"："+input.Evidence); e != nil {
			return e
		}
		if e := tx.ReleaseWorkflowSession(ctx, w); e != nil {
			return e
		}
		b, _ := json.Marshal(w)
		_, e := tx.InsertWorkflowRecovery(ctx, id, input.RequestID, canonical, string(b))
		return e
	})
	if err == nil {
		m.signal()
	}
	return w, false, storageFailure(err)
}
func (m *Manager) recoverWorkflows(ctx context.Context) error {
	fence, err := readWorkflowRecoveryFence(m.deps.WorkflowRecoveryFence)
	if err != nil {
		return err
	}
	err = writeStore(m.store, ctx, "workflow-startup", func(tx sessionstore.Tx) error {
		runs, e := tx.WorkflowRuns(ctx)
		if e != nil {
			return e
		}
		for index, r := range runs {
			if r.WorkflowActiveReserved > 0 {
				w, e := readWorkflow(ctx, tx, r.WorkflowID)
				if e != nil {
					return e
				}
				w.Usage.ReservedMilliseconds -= r.WorkflowActiveReserved
				w.Usage.ActiveMilliseconds += r.WorkflowActiveReserved
				r.ActiveMilliseconds += r.WorkflowActiveReserved
				r.WorkflowActiveReserved = 0
				if e = saveWorkflow(ctx, tx, &w); e != nil {
					return e
				}
				if e = saveRun(ctx, tx, &r); e != nil {
					return e
				}
				runs[index] = r
			}
		}
		list, e := tx.ActiveWorkflows(ctx)
		if e != nil {
			return e
		}
		for _, w := range list {
			excluded, err := contextExcluded(ctx, tx, "workflow", w.ID)
			if err != nil {
				return err
			}
			if excluded {
				continue
			}
			if e = tx.FailWorkflowActiveBudget(ctx, &w, nil); e != nil {
				return e
			}
			if state.WorkflowV2(w) {
				if e = m.recoverWorkflowV2Startup(ctx, tx, &w, fence); e != nil {
					return e
				}
				continue
			}
			if state.Terminal(w.Status) || !fence {
				continue
			}
			w.Status = StateRecoveryRequired
			w.Error = &Failure{Code: "maintenance-recovery", Message: "面板数据经过维护恢复，工作流需人工核实后继续"}
			for _, run := range runs {
				if run.WorkflowID == w.ID && (run.Status == StateQueued || run.Status == StateWaitingApproval) {
					run.WorkflowFrozenFrom = run.Status
					run.Status = StateRecoveryRequired
					if e = saveRun(ctx, tx, &run); e != nil {
						return e
					}
				}
			}
			approvals, e := tx.WorkflowApprovals(ctx, w.ID)
			if e != nil {
				return e
			}
			for _, a := range approvals {
				a.Status = "revoked"
				if e = saveApproval(ctx, tx, a); e != nil {
					return e
				}
			}
			if e = tx.WorkflowEvent(ctx, &w, "workflow/recovery-required", w.Error.Message); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if fence {
		return removeWorkflowRecoveryFence(m.deps.WorkflowRecoveryFence)
	}
	return nil
}
