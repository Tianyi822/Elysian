package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

func (m *Manager) workflowV2HasActiveExecution(w WorkflowInstance) bool {
	for _, execution := range m.executions {
		if execution.rootID == "workflow:"+w.ID {
			return true
		}
	}
	return false
}

func (m *Manager) cancelWorkflowV2(ctx context.Context, tx *sql.Tx, w *WorkflowInstance) error {
	w.CancelRequestedAt, w.GateClosed = stamp(m.deps.Now()), true
	if err := m.store.workflowEvent(ctx, tx, w, "workflow/cancel-requested", ""); err != nil {
		return err
	}
	approvals, err := readDocuments[Approval](ctx, tx, "SELECT a.document FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.workflow_id=? AND a.state IN ('pending','approved')", w.ID)
	if err != nil {
		return err
	}
	for _, approval := range approvals {
		approval.Status = "revoked"
		if err = saveApproval(ctx, tx, approval); err != nil {
			return err
		}
	}
	nodes, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state NOT IN ('succeeded','cancelled','skipped')", w.ID)
	if err != nil {
		return err
	}
	for _, node := range nodes {
		if node.RunID != "" {
			run, e := readRun(ctx, tx, node.RunID)
			if e != nil {
				return e
			}
			if !terminal(run.Status) {
				run.CancelRequestedAt = w.CancelRequestedAt
				if run.Status == StateRunning {
					if e = m.store.event(ctx, tx, &run, "run/cancel-requested", "", nil, nil); e != nil {
						return e
					}
					continue
				}
				run.Status, run.EndReason, run.EndedAt = StateCancelled, "cancelled", w.CancelRequestedAt
				if e = m.store.event(ctx, tx, &run, "run/cancelled", "", nil, nil); e != nil {
					return e
				}
				a, e := readWorkflowAttempt(ctx, tx, run.ID)
				if e != nil {
					return e
				}
				a.Status, a.EndedAt, a.EventSeq = StateCancelled, run.EndedAt, run.LastSeq
				if e = saveWorkflowAttempt(ctx, tx, a); e != nil {
					return e
				}
				if e = releaseWaitingResourceLeases(ctx, tx, run.ID, run.EndedAt); e != nil {
					return e
				}
			}
		}
		node.Status, node.EndedAt = StateCancelled, w.CancelRequestedAt
		if err = saveWorkflowNode(ctx, tx, &node); err != nil {
			return err
		}
	}
	*w, err = readWorkflow(ctx, tx, w.ID)
	if err != nil {
		return err
	}
	return m.store.refreshWorkflowV2(ctx, tx, w)
}

func (m *Manager) workflowV2AllowedActions(ctx context.Context, w WorkflowInstance) []string {
	node, err := readWorkflowNode(ctx, m.store.db, w.CurrentStepID)
	if err != nil {
		return []string{}
	}
	return m.workflowV2NodeAllowedActions(ctx, w, node)
}

func (m *Manager) workflowV2NodeAllowedActions(ctx context.Context, w WorkflowInstance, node WorkflowNodeExecution) []string {
	out := []string{}
	if w.Status != StateRecoveryRequired || w.CancelRequestedAt != "" || node.Status != StateRecoveryRequired || m.workflowV2HasActiveExecution(w) {
		return out
	}
	if w.Usage.ActiveMilliseconds+w.Usage.ReservedMilliseconds >= w.Limits.ActiveMilliseconds || w.Usage.Tokens >= w.Limits.Tokens || w.Usage.ModelRequests >= w.Limits.ModelRequests || w.Usage.Calls >= w.Limits.Calls || w.Usage.ResultBytes >= w.Limits.ResultBytes || m.checkWorkflowEnvironment(ctx, w) != nil {
		return out
	}
	scope, err := readWorkflowScope(ctx, m.store.db, node.ScopeID)
	if err != nil || validateWorkflowV2RecoverySources(ctx, m.store.db, scope, node) != nil {
		return out
	}
	var barriers int
	if err := m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM execution_barriers WHERE state IN ('dispatched','unknown')").Scan(&barriers); err != nil || barriers != 0 {
		return out
	}
	maintenance := node.Error != nil && node.Error.Code == "maintenance-recovery"
	if node.RunID == "" {
		if maintenance {
			return []string{"continue"}
		}
		if node.Attempt < w.Limits.Attempts {
			return []string{"retry"}
		}
		return out
	}
	run, err := readRun(ctx, m.store.db, node.RunID)
	if err != nil {
		return out
	}
	if !terminal(run.Status) {
		approvals, e := readDocuments[Approval](ctx, m.store.db, "SELECT document FROM approvals WHERE run_id=? ORDER BY rowid", run.ID)
		if e != nil {
			return out
		}
		if len(approvals) > 0 {
			return []string{"renew-approval"}
		}
		if maintenance && run.WorkflowFrozenFrom == StateQueued {
			var operations int
			if e = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM operations WHERE run_id=?", run.ID).Scan(&operations); e == nil && operations == 0 {
				return []string{"continue"}
			}
		}
		return out
	}
	a, err := readWorkflowAttempt(ctx, m.store.db, run.ID)
	if err != nil || a.Status == StateSucceeded {
		return out
	}
	if node.Attempt < w.Limits.Attempts {
		out = append(out, "retry")
	}
	if node.Kind != "agent" && node.Kind != "operation" {
		return out
	}
	resolved, err := readDocuments[ExecutionBarrier](ctx, m.store.db, "SELECT document FROM execution_barriers WHERE run_id=?", run.ID)
	if err != nil {
		return out
	}
	for _, barrier := range resolved {
		if barrier.Status == "reconciled" && barrier.Decision != "confirmed-completed" {
			return out
		}
	}
	return append(out, "accept-result")
}

// Common HTTP/API checks (request id, instance CAS, evidence and global
// barriers) precede this hook. A node id is mandatory so a stale screen cannot
// accidentally recover a different sibling when the primary error changes.
func (m *Manager) recoverWorkflowV2(ctx context.Context, w WorkflowInstance, input WorkflowRecoveryInput, canonical string) (WorkflowInstance, bool, error) {
	if input.NodeID == "" {
		return w, false, bad("workflow-node-required", "恢复 workflow/v2 必须指定 nodeId")
	}
	node, err := readWorkflowNode(ctx, m.store.db, input.NodeID)
	if err != nil {
		return w, false, storageFailure(err)
	}
	if node.WorkflowID != w.ID || node.Status != StateRecoveryRequired {
		return w, false, &Error{409, "workflow-node-state", "节点不属于该流程或不处于可恢复状态"}
	}
	if m.workflowV2HasActiveExecution(w) {
		return w, false, &Error{409, "workflow-active", "流程仍有执行尚未确认停止"}
	}
	if err = m.checkWorkflowEnvironment(ctx, w); err != nil {
		return w, false, err
	}
	scope, err := readWorkflowScope(ctx, m.store.db, node.ScopeID)
	if err != nil {
		return w, false, storageFailure(err)
	}
	step, err := workflowScopeStep(scope, node.StepID)
	if err != nil {
		return w, false, err
	}
	var run Run
	if node.RunID != "" {
		run, err = readRun(ctx, m.store.db, node.RunID)
		if err != nil {
			return w, false, storageFailure(err)
		}
	}
	err = m.store.write(ctx, "workflow-v2-recovery", func(tx *sql.Tx) error {
		if err := validateWorkflowV2RecoverySources(ctx, tx, scope, node); err != nil {
			return err
		}
		if w.Usage.ActiveMilliseconds+w.Usage.ReservedMilliseconds >= w.Limits.ActiveMilliseconds || w.Usage.ModelRequests >= w.Limits.ModelRequests || w.Usage.Tokens >= w.Limits.Tokens || w.Usage.Calls >= w.Limits.Calls || w.Usage.ResultBytes >= w.Limits.ResultBytes {
			return bad("workflow-budget", "流程累计预算已耗尽，不能恢复")
		}
		switch input.Action {
		case "continue":
			if node.Error == nil || node.Error.Code != "maintenance-recovery" {
				return &Error{409, "unsafe-resume", "只能继续维护冻结的已确认节点边界"}
			}
			if run.ID != "" {
				if run.WorkflowFrozenFrom != StateQueued {
					return &Error{409, "unsafe-resume", "该节点应重新审批、重试或补录"}
				}
				var count int
				if err := tx.QueryRowContext(ctx, "SELECT (SELECT COUNT(*) FROM approvals WHERE run_id=?)+(SELECT COUNT(*) FROM operations WHERE run_id=?)", run.ID, run.ID).Scan(&count); err != nil {
					return err
				}
				if count != 0 {
					return &Error{409, "unsafe-resume", "节点已有操作或审批，应重新核实审批"}
				}
				run.Status, run.WorkflowFrozenFrom, node.Status = StateQueued, "", StateQueued
				if err := saveRun(ctx, tx, &run); err != nil {
					return err
				}
			} else if node.Expanded {
				node.Status = StateRunning
			} else {
				node.Status = StateReady
			}
		case "retry":
			if run.ID != "" {
				a, err := readWorkflowAttempt(ctx, tx, run.ID)
				if err != nil {
					return err
				}
				if a.Status == StateSucceeded || !terminal(run.Status) {
					return &Error{409, "unsafe-retry", "已完成或尚未终止的节点不能重试"}
				}
			}
			if node.Attempt >= w.Limits.Attempts {
				return bad("attempt-budget", "节点尝试次数已耗尽")
			}
			node.Status, node.RunID, node.EndedAt = StateReady, "", ""
			if node.Expanded {
				node.Attempt++
				node.Status = StateRunning
			}
		case "renew-approval":
			if run.ID == "" || terminal(run.Status) {
				return &Error{409, "unsafe-resume", "只能重新申请未派发节点的审批"}
			}
			if err := m.renewWorkflowV2Approval(ctx, tx, &run); err != nil {
				return err
			}
			node.Status = StateWaitingApproval
		case "accept-result":
			if run.ID == "" || !terminal(run.Status) || (node.Kind != "agent" && node.Kind != "operation") {
				return &Error{409, "invalid-resolution", "只能补录已终止 Agent 或操作节点的外部结果"}
			}
			barriers, err := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE run_id=?", run.ID)
			if err != nil {
				return err
			}
			for _, barrier := range barriers {
				if barrier.Status == "reconciled" && barrier.Decision != "confirmed-completed" {
					return &Error{409, "resolution-conflict", "该尝试已核实为停止，不能补录为完成"}
				}
			}
			if len(input.OutputJSON) > run.Limits.ResultBytes || w.Usage.ResultBytes+len(input.OutputJSON) > w.Limits.ResultBytes {
				return &Error{413, "output-too-large", "補录结果超过容量或流程预算"}
			}
			if err = validateWorkflowJSON(step.OutputSchemaJSON, input.OutputJSON); err != nil {
				return err
			}
			a, err := readWorkflowAttempt(ctx, tx, run.ID)
			if err != nil {
				return err
			}
			if a.Status == StateSucceeded {
				return &Error{409, "already-completed", "节点已经有完成凭据"}
			}
			a.Status, a.OutputJSON, a.OutputCallID, a.OutputRequestID, a.CompletionSource, a.Evidence, a.EndedAt = StateSucceeded, input.OutputJSON, "", "", "operator", input.Evidence, stamp(m.deps.Now())
			if err = m.store.event(ctx, tx, &run, "workflow/result-recorded", "", nil, map[string]string{"evidence": input.Evidence, "nodeId": node.ID}); err != nil {
				return err
			}
			a.EventSeq = run.LastSeq
			version, err := readWorkspaceVersion(ctx, tx, run.TaskID)
			if err != nil {
				return err
			}
			a.WorkspaceRevision = version.Revision
			if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
				return err
			}
			if err = recordWikiRunArtifact(ctx, tx, run, "workflow-node", node.ID); err != nil {
				return err
			}
			node.Status, node.OutputJSON, node.EndedAt = StateSucceeded, input.OutputJSON, a.EndedAt
			w.Usage.ResultBytes += len(input.OutputJSON)
		default:
			return bad("invalid-recovery", "未知工作流恢复动作")
		}
		node.Error = nil
		if err := saveWorkflowNode(ctx, tx, &node); err != nil {
			return err
		}
		if input.Action == "accept-result" {
			if err := m.store.advanceWorkflowV2Scope(ctx, tx, &w, &scope, node, step, ""); err != nil {
				return err
			}
		}
		pending, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state='recovery-required' ORDER BY rowid", w.ID)
		if err != nil {
			return err
		}
		w.GateClosed = len(pending) != 0
		if w.GateClosed {
			w.Status, w.CurrentStepID, w.ActiveRunID, w.Error = StateRecoveryRequired, pending[0].ID, pending[0].RunID, pending[0].Error
		} else if !terminal(w.Status) {
			w.Status, w.ActiveRunID, w.Error, w.ReadyAt = StateReady, "", nil, stamp(m.deps.Now())
		}
		if err = m.store.workflowEvent(ctx, tx, &w, "workflow/recovered", node.ID+":"+input.Action+":"+input.Evidence); err != nil {
			return err
		}
		if err = m.store.releaseWorkflowSession(ctx, tx, w); err != nil {
			return err
		}
		raw, err := json.Marshal(w)
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO workflow_recoveries(workflow_id,request_id,canonical_input,document) VALUES(?,?,?,?)", w.ID, input.RequestID, canonical, string(raw))
		return err
	})
	if err == nil {
		m.signal()
	}
	return w, false, storageFailure(err)
}

func (m *Manager) renewWorkflowV2Approval(ctx context.Context, tx *sql.Tx, run *Run) error {
	approvals, err := readDocuments[Approval](ctx, tx, "SELECT document FROM approvals WHERE run_id=? ORDER BY rowid", run.ID)
	if err != nil {
		return err
	}
	if len(approvals) == 0 {
		return bad("approval-missing", "节点没有可重新申请的审批")
	}
	var pending int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals WHERE state='pending'").Scan(&pending); err != nil {
		return err
	}
	if pending >= 32 {
		return &Error{429, "approvals-full", "待审批运行已达上限"}
	}
	for _, approval := range approvals {
		if approval.Status == "pending" || approval.Status == "approved" {
			approval.Status = "revoked"
			if err = saveApproval(ctx, tx, approval); err != nil {
				return err
			}
		}
	}
	renewed := approvals[len(approvals)-1]
	renewed.ID, renewed.Status, renewed.Decision, renewed.DecidedAt = m.deps.NewID(), "pending", "", ""
	renewed.CreatedAt, renewed.ExpiresAt = stamp(m.deps.Now()), stamp(m.deps.Now().Add(24*time.Hour))
	if renewed.OperationID != "" {
		operation, err := readOperation(ctx, tx, renewed.OperationID)
		if err != nil {
			return err
		}
		if operation.DispatchID != "" || operation.Status == "completed" || operation.Status == "unknown" {
			return &Error{409, "operation-dispatched", "已派发操作不能重新申请原审批"}
		}
		version, err := readWorkspaceVersion(ctx, tx, run.TaskID)
		if err != nil {
			return err
		}
		if version.Revision != operation.WorkspaceRevision {
			return workspaceConflict()
		}
		operation.ApprovalID, operation.Status = renewed.ID, StateWaitingApproval
		renewed.Operation = operation
		if err = saveOperation(ctx, tx, operation); err != nil {
			return err
		}
	}
	if err = saveApproval(ctx, tx, renewed); err != nil {
		return err
	}
	run.Status, run.Phase, run.EndedAt, run.EndReason, run.WorkflowFrozenFrom, run.Error = StateWaitingApproval, StateWaitingApproval, "", "", "", nil
	return m.store.event(ctx, tx, run, "approval/renewed", "", nil, map[string]string{"approvalId": renewed.ID})
}

func (m *Manager) recoverWorkflowV2Startup(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, fence bool) error {
	if terminal(w.Status) {
		return nil
	}
	if !fence {
		return m.store.refreshWorkflowV2(ctx, tx, w)
	}
	w.GateClosed, w.Status = true, StateRecoveryRequired
	w.Error = &Failure{Code: "maintenance-recovery", Message: "面板数据经过维护恢复，工作流需逐节点核实后继续"}
	nodes, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state IN ('ready','queued','running','waiting-approval','waiting-resource') ORDER BY rowid", w.ID)
	if err != nil {
		return err
	}
	for _, node := range nodes {
		if node.RunID != "" {
			run, err := readRun(ctx, tx, node.RunID)
			if err != nil {
				return err
			}
			if !terminal(run.Status) {
				run.WorkflowFrozenFrom, run.Status = run.Status, StateRecoveryRequired
				if err = saveRun(ctx, tx, &run); err != nil {
					return err
				}
			}
		}
		node.Status, node.Error = StateRecoveryRequired, w.Error
		if err = saveWorkflowNode(ctx, tx, &node); err != nil {
			return err
		}
		w.CurrentStepID, w.ActiveRunID = node.ID, node.RunID
	}
	approvals, err := readDocuments[Approval](ctx, tx, "SELECT a.document FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.workflow_id=? AND a.state IN ('pending','approved')", w.ID)
	if err != nil {
		return err
	}
	for _, approval := range approvals {
		approval.Status = "revoked"
		if err = saveApproval(ctx, tx, approval); err != nil {
			return err
		}
	}
	return m.store.workflowEvent(ctx, tx, w, "workflow/recovery-required", w.Error.Message)
}

func (s *store) failWorkflowV2Budget(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, current *Run, failure *Failure) error {
	endedAt := stamp(s.now())
	w.GateClosed, w.Status, w.Error, w.EndedAt = true, StateFailed, failure, endedAt
	if err := s.workflowEvent(ctx, tx, w, "workflow/failed", failure.Message); err != nil {
		return err
	}
	approvals, err := readDocuments[Approval](ctx, tx, "SELECT a.document FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.workflow_id=? AND a.state IN ('pending','approved')", w.ID)
	if err != nil {
		return err
	}
	for _, approval := range approvals {
		approval.Status = "revoked"
		if err = saveApproval(ctx, tx, approval); err != nil {
			return err
		}
	}
	runs, err := readDocuments[Run](ctx, tx, "SELECT document FROM runs WHERE workflow_id=? AND state IN ('queued','running','waiting-approval','waiting-resource','recovery-required')", w.ID)
	if err != nil {
		return err
	}
	for _, run := range runs {
		if run.Status == StateRunning && (current == nil || current.ID != run.ID) {
			run.CancelRequestedAt, run.Error = endedAt, failure
			if err = s.event(ctx, tx, &run, "run/cancel-requested", "", nil, failure); err != nil {
				return err
			}
			continue
		}
		if current != nil && current.ID == run.ID {
			run = *current
		}
		run.Status, run.EndReason, run.Error, run.EndedAt, run.MemoryStatus = StateFailed, failure.Code, failure, endedAt, "stale"
		if err = s.event(ctx, tx, &run, "run/failed", "", nil, failure); err != nil {
			return err
		}
		a, err := readWorkflowAttempt(ctx, tx, run.ID)
		if err != nil {
			return err
		}
		a.Status, a.EndedAt, a.EventSeq = StateFailed, endedAt, run.LastSeq
		if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
			return err
		}
		if err = releaseWaitingResourceLeases(ctx, tx, run.ID, endedAt); err != nil {
			return err
		}
		if current != nil && current.ID == run.ID {
			*current = run
		}
	}
	nodes, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state NOT IN ('succeeded','skipped','cancelled','failed')", w.ID)
	if err != nil {
		return err
	}
	for _, node := range nodes {
		if node.RunID != "" {
			run, err := readRun(ctx, tx, node.RunID)
			if err != nil {
				return err
			}
			if run.Status == StateRunning {
				continue
			}
		}
		node.Status, node.Error, node.EndedAt = StateFailed, failure, endedAt
		if err = saveWorkflowNode(ctx, tx, &node); err != nil {
			return err
		}
	}
	scopes, err := readDocuments[WorkflowScope](ctx, tx, "SELECT document FROM workflow_scopes WHERE workflow_id=? AND state<>'succeeded'", w.ID)
	if err != nil {
		return err
	}
	for _, scope := range scopes {
		scope.Status, scope.EndedAt = StateFailed, endedAt
		if err = saveWorkflowScope(ctx, tx, scope); err != nil {
			return err
		}
	}
	return s.releaseWorkflowSession(ctx, tx, *w)
}
