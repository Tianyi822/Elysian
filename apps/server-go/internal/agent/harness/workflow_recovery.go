package harness

import (
	"bytes"
	"context"
	"database/sql"
	"elysian/server/internal/agent/jsonvalue"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

func (m *Manager) CancelWorkflow(ctx context.Context, id string) (WorkflowInstance, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var w WorkflowInstance
	if err := m.workflowWritable(); err != nil {
		return w, err
	}
	err := m.store.write(ctx, "workflow-cancel", func(tx *sql.Tx) error {
		var e error
		w, e = readWorkflow(ctx, tx, id)
		if e != nil {
			return e
		}
		if terminal(w.Status) {
			return nil
		}
		if workflowV2(w) {
			return m.cancelWorkflowV2(ctx, tx, &w)
		}
		w.CancelRequestedAt = stamp(m.deps.Now())
		if e = m.store.workflowEvent(ctx, tx, &w, "workflow/cancel-requested", ""); e != nil {
			return e
		}
		if w.ActiveRunID != "" {
			r, e := readRun(ctx, tx, w.ActiveRunID)
			if e != nil {
				return e
			}
			r.CancelRequestedAt = w.CancelRequestedAt
			approvals, e := readDocuments[Approval](ctx, tx, "SELECT document FROM approvals WHERE run_id=? ORDER BY rowid", r.ID)
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
				return m.store.event(ctx, tx, &r, "run/cancel-requested", "", nil, nil)
			}
			if !terminal(r.Status) {
				r.Status = StateCancelled
				r.EndedAt = w.CancelRequestedAt
				r.EndReason = "cancelled"
				if e = m.store.event(ctx, tx, &r, "run/cancelled", "", nil, nil); e != nil {
					return e
				}
				if e = m.store.releaseSession(ctx, tx, &r); e != nil {
					return e
				}
				w, e = readWorkflow(ctx, tx, id)
				return e
			}
		}
		w.Status = StateCancelled
		w.EndedAt = w.CancelRequestedAt
		if e = m.store.workflowEvent(ctx, tx, &w, "workflow/cancelled", ""); e != nil {
			return e
		}
		return m.store.releaseWorkflowSession(ctx, tx, w)
	})
	if execution := m.executionLocked(w.ActiveRunID); err == nil && execution != nil {
		execution.cancel()
	}
	if err == nil && workflowV2(w) {
		for _, execution := range m.executions {
			if execution.rootID == "workflow:"+w.ID {
				execution.cancel()
			}
		}
	}
	if err == nil {
		w, err = readWorkflow(ctx, m.store.db, id)
	}
	m.signal()
	return w, storageFailure(err)
}
func (m *Manager) RecoverWorkflow(ctx context.Context, id string, input WorkflowRecoveryInput) (WorkflowInstance, bool, error) {
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
	err := m.store.db.QueryRowContext(ctx, "SELECT canonical_input,document FROM workflow_recoveries WHERE workflow_id=? AND request_id=?", id, input.RequestID).Scan(&prior, &document)
	if err == nil {
		if prior != canonical {
			return w, false, &Error{409, "request-conflict", "相同恢复请求标识对应不同输入"}
		}
		err = json.Unmarshal([]byte(document), &w)
		return w, true, err
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return w, false, storageFailure(err)
	}
	if err = m.workflowWritable(); err != nil {
		return w, false, err
	}
	if err = recoveryEvidence(input); err != nil {
		return w, false, err
	}
	w, err = readWorkflow(ctx, m.store.db, id)
	if err != nil {
		return w, false, storageFailure(err)
	}
	if w.Revision != input.ExpectedRevision {
		return w, false, &Error{409, "revision-conflict", "工作流状态版本已变化"}
	}
	if w.Status != StateRecoveryRequired || w.CancelRequestedAt != "" {
		return w, false, &Error{409, "workflow-state", "流程不处于可恢复状态"}
	}
	var count int
	if err = m.store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM execution_barriers WHERE state IN ('dispatched','unknown')").Scan(&count); err != nil {
		return w, false, storageFailure(err)
	}
	if count > 0 {
		return w, false, &Error{409, "execution-barrier", "必须先核实全部未知执行屏障"}
	}
	if m.executionLocked(w.ActiveRunID) != nil {
		return w, false, &Error{409, "workflow-active", "原执行尚未确认停止"}
	}
	if workflowV2(w) {
		return m.recoverWorkflowV2(ctx, w, input, canonical)
	}
	d, err := readWorkflowDefinition(ctx, m.store.db, w.DefinitionID, w.DefinitionRevision)
	if err != nil {
		return w, false, storageFailure(err)
	}
	step, err := workflowStep(d, w.CurrentStepID)
	if err != nil {
		return w, false, err
	}
	var r Run
	if w.ActiveRunID != "" {
		r, err = readRun(ctx, m.store.db, w.ActiveRunID)
		if err != nil {
			return w, false, storageFailure(err)
		}
	}
	// 固定环境不能通过人工恢复规避显式撤销。
	if err = m.checkWorkflowEnvironment(ctx, w); err != nil {
		return w, false, err
	}
	err = m.store.write(ctx, "workflow-recovery", func(tx *sql.Tx) error {
		if err := validateWorkflowV1RecoverySources(ctx, tx, w); err != nil {
			return err
		}
		if w.Usage.ActiveMilliseconds+w.Usage.ReservedMilliseconds >= w.Limits.ActiveMilliseconds || w.Usage.ModelRequests >= w.Limits.ModelRequests || w.Usage.Tokens >= w.Limits.Tokens || w.Usage.Calls >= w.Limits.Calls || w.Usage.ResultBytes >= w.Limits.ResultBytes {
			return bad("workflow-budget", "流程累计预算已耗尽，不能恢复")
		}
		switch input.Action {
		case "continue":
			if w.Error == nil || w.Error.Code != "maintenance-recovery" {
				return &Error{409, "unsafe-resume", "只能从维护冻结的已确认边界继续"}
			}
			if r.ID == "" {
				w.Status = StateReady
				w.ReadyAt = stamp(m.deps.Now())
				break
			}
			if r.WorkflowFrozenFrom != StateQueued {
				return &Error{409, "unsafe-resume", "该步骤不是未派发边界，应重新审批、重试或补录"}
			}
			var approvals int
			if e := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals WHERE run_id=?", r.ID).Scan(&approvals); e != nil {
				return e
			}
			if approvals > 0 {
				return &Error{409, "unsafe-resume", "原审批已经撤销，应明确重新申请"}
			}
			var operations int
			if e := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM operations WHERE run_id=?", r.ID).Scan(&operations); e != nil {
				return e
			}
			if operations > 0 {
				return &Error{409, "unsafe-resume", "保存的操作需要重新核对审批"}
			}
			r.Status = StateQueued
			r.WorkflowFrozenFrom = ""
			if e := saveRun(ctx, tx, &r); e != nil {
				return e
			}
			w.Status = StateQueued
		case "renew-approval":
			if r.ID == "" || terminal(r.Status) {
				return &Error{409, "unsafe-resume", "只能重新申请尚未派发步骤的审批"}
			}
			approvals, e := readDocuments[Approval](ctx, tx, "SELECT document FROM approvals WHERE run_id=? ORDER BY rowid", r.ID)
			if e != nil {
				return e
			}
			if len(approvals) == 0 {
				return bad("approval-missing", "没有可重新申请的审批")
			}
			old := approvals[len(approvals)-1]
			var pending int
			if e = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals WHERE state='pending'").Scan(&pending); e != nil {
				return e
			}
			if pending >= 32 {
				return &Error{429, "approvals-full", "待审批运行已达上限"}
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
					return &Error{409, "operation-dispatched", "已派发操作不能重新申请原审批"}
				}
				v, e := readWorkspaceVersion(ctx, tx, w.TaskID)
				if e != nil {
					return e
				}
				if v.Revision != o.WorkspaceRevision {
					return &Error{409, "workspace-conflict", "工作区版本与原操作审批基线不同"}
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
			if e = m.store.event(ctx, tx, &r, "approval/renewed", "", nil, map[string]string{"approvalId": renewed.ID}); e != nil {
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
					return &Error{409, "already-completed", "已提交完成凭据的步骤不能重做"}
				}
			}

			if r.ID != "" && !terminal(r.Status) {
				return &Error{409, "unsafe-retry", "尚未派发的暂停步骤应继续或重新申请审批"}
			}
			var attempts int
			if e := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_attempts WHERE workflow_id=? AND step_id=?", w.ID, step.ID).Scan(&attempts); e != nil {
				return e
			}
			if attempts >= w.Limits.Attempts {
				return bad("attempt-budget", "步骤尝试次数已耗尽")
			}
			w.ActiveRunID = ""
			w.Status = StateReady
			w.ReadyAt = stamp(m.deps.Now())
		case "accept-result":
			barriers, e := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE run_id=?", r.ID)
			if e != nil {
				return e
			}
			for _, b := range barriers {
				if b.Status == "reconciled" && b.Decision != "confirmed-completed" {
					return &Error{409, "resolution-conflict", "该尝试已核实为停止，只能明确重试，不能补录为完成"}
				}
			}

			if r.ID == "" || !terminal(r.Status) || step.Kind == "approval" || step.Kind == "condition" {
				return &Error{409, "invalid-resolution", "只能补录已终止 Agent 或操作步骤的外部结果"}
			}
			if len(input.OutputJSON) > r.Limits.ResultBytes || w.Usage.ResultBytes+len(input.OutputJSON) > w.Limits.ResultBytes {
				return &Error{413, "output-too-large", "补录结果超过容量或流程预算"}
			}
			if e := validateWorkflowJSON(step.OutputSchemaJSON, input.OutputJSON); e != nil {
				return e
			}
			a, e := readWorkflowAttempt(ctx, tx, r.ID)
			if e != nil {
				return e
			}
			if a.Status == StateSucceeded {
				return &Error{409, "already-completed", "步骤已经有完成凭据"}
			}
			a.Status = StateSucceeded
			a.OutputJSON = input.OutputJSON
			a.OutputCallID = ""
			a.OutputRequestID = ""
			a.CompletionSource = "operator"
			a.Evidence = input.Evidence
			a.EndedAt = stamp(m.deps.Now())
			if e = m.store.event(ctx, tx, &r, "workflow/result-recorded", "", nil, map[string]string{"evidence": input.Evidence}); e != nil {
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
			if e = m.store.advanceWorkflow(ctx, tx, &w, a, ""); e != nil {
				return e
			}
		default:
			return bad("invalid-recovery", "未知工作流恢复动作")
		}
		if w.Status != StateRecoveryRequired {
			w.Error = nil
		}
		if e := m.store.workflowEvent(ctx, tx, &w, "workflow/recovered", input.Action+"："+input.Evidence); e != nil {
			return e
		}
		if e := m.store.releaseWorkflowSession(ctx, tx, w); e != nil {
			return e
		}
		b, _ := json.Marshal(w)
		_, e := tx.ExecContext(ctx, "INSERT INTO workflow_recoveries(workflow_id,request_id,canonical_input,document) VALUES(?,?,?,?)", id, input.RequestID, canonical, string(b))
		return e
	})
	if err == nil {
		m.signal()
	}
	return w, false, storageFailure(err)
}
func (m *Manager) recoverWorkflows(ctx context.Context) error {
	fence := false
	if m.deps.WorkflowRecoveryFence != "" {
		info, err := os.Lstat(m.deps.WorkflowRecoveryFence)
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if err == nil {
			if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 4096 {
				return errors.New("工作流维护冻结标记无效")
			}
			raw, e := os.ReadFile(m.deps.WorkflowRecoveryFence)
			if e != nil {
				return e
			}
			var record struct {
				Version   int    `json:"version"`
				Reason    string `json:"reason"`
				CreatedAt string `json:"createdAt"`
			}
			if _, e = jsonvalue.Object(raw); e != nil {
				return errors.New("工作流维护冻结标记 JSON 无效")
			}
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			if e = decoder.Decode(&record); e != nil || record.Version != 1 || record.Reason != "panel-rollback" {
				return errors.New("工作流维护冻结标记无效")
			}
			if _, e = time.Parse(time.RFC3339Nano, record.CreatedAt); e != nil {
				return errors.New("工作流维护冻结标记时间无效")
			}
			fence = true
		}
	}
	err := m.store.write(ctx, "workflow-startup", func(tx *sql.Tx) error {
		if fence {
			if err := m.freezeWikiJobsForMaintenance(ctx, tx); err != nil {
				return err
			}
		}
		runs, e := readDocuments[Run](ctx, tx, "SELECT document FROM runs WHERE workflow_id<>''")
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
		list, e := readDocuments[WorkflowInstance](ctx, tx, "SELECT document FROM workflow_instances WHERE state NOT IN ('succeeded','failed','cancelled')")
		if e != nil {
			return e
		}
		for _, w := range list {
			if e = m.store.failWorkflowActiveBudget(ctx, tx, &w, nil); e != nil {
				return e
			}
			if workflowV2(w) {
				if e = m.recoverWorkflowV2Startup(ctx, tx, &w, fence); e != nil {
					return e
				}
				continue
			}
			if terminal(w.Status) || !fence {
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
			approvals, e := readDocuments[Approval](ctx, tx, "SELECT a.document FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.workflow_id=? AND a.state IN ('pending','approved')", w.ID)
			if e != nil {
				return e
			}
			for _, a := range approvals {
				a.Status = "revoked"
				if e = saveApproval(ctx, tx, a); e != nil {
					return e
				}
			}
			if e = m.store.workflowEvent(ctx, tx, &w, "workflow/recovery-required", w.Error.Message); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if fence {
		if err = os.Remove(m.deps.WorkflowRecoveryFence); err != nil {
			return err
		}
		dir, e := os.Open(filepath.Dir(m.deps.WorkflowRecoveryFence))
		if e != nil {
			return e
		}
		defer dir.Close()
		return dir.Sync()
	}
	return nil
}
