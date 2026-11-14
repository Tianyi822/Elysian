package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"

	"elysian/server/internal/agent/tools"
)

func taskArgument(args map[string]any, key string) string {
	if key == "" {
		return ""
	}
	if strings.HasPrefix(key, "/") {
		value, ok := resourcePointer(args, key)
		if !ok {
			return ""
		}
		text, _ := value.(string)
		return text
	}
	value, _ := args[key].(string)
	return value
}

func (m *Manager) taskMonitorLoop() {
	defer close(m.taskDone)
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.monitorTasks()
			m.retryReconciliations()
		}
	}
}

func (m *Manager) monitorTasks() {
	m.mu.Lock()
	if m.closed || m.storageError {
		m.mu.Unlock()
		return
	}
	operations, err := readDocuments[Operation](m.ctx, m.store.db, "SELECT o.document FROM operations o WHERE (o.state='waiting-task' OR (o.state='unknown' AND (json_extract(o.document,'$.task') IS NOT NULL OR json_extract(o.document,'$.recovery') IS NOT NULL))) AND NOT EXISTS (SELECT 1 FROM execution_barriers b WHERE b.operation_id=o.id AND (b.state='reconciled' OR json_extract(b.document,'$.reconciliation') IS NOT NULL)) ORDER BY o.rowid")
	m.mu.Unlock()
	if err != nil {
		return
	}
	m.mu.Lock()
	active := make(map[string]bool, len(operations))
	for _, operation := range operations {
		active[operation.ID] = true
	}
	for id := range m.taskProgress {
		if !active[id] {
			delete(m.taskProgress, id)
		}
	}
	m.mu.Unlock()
	for _, operation := range operations {
		if allowed, err := m.recoveryObservation(operation); err != nil || !allowed {
			if err != nil {
				m.mu.Lock()
				m.storageFailedLocked()
				m.mu.Unlock()
			}
			continue
		}
		if operation.Task == nil || m.deps.InspectTask == nil {
			continue
		}
		if operation.Task.ID == "" || operation.Task.RequestID == "" {
			if operation.Recovery != nil && m.deps.VerifyTask != nil {
				if ref, err := m.verifyMissingTask(m.ctx, operation); err == nil {
					operation.Task = &ref
				}
			}
			if m.deps.LookupTask == nil {
				m.taskObservationFailed(operation)
				continue
			}
			ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
			reference, lookupErr := m.deps.LookupTask(ctx, *operation.Task)
			cancel()
			if lookupErr != nil || reference.ID == "" || reference.RequestID == "" || reference.Domain != operation.Task.Domain || operation.Task.ID != "" && reference.ID != operation.Task.ID || operation.Task.RequestID != "" && reference.RequestID != operation.Task.RequestID {
				m.taskObservationFailed(operation)
				continue
			}
			m.mu.Lock()
			err := m.store.write(context.Background(), "operation-task-reconciled", func(tx *sql.Tx) error {
				current, err := readOperation(context.Background(), tx, operation.ID)
				if err != nil {
					return err
				}
				if current.Status != "unknown" || digestJSON(current.Task) != digestJSON(operation.Task) {
					return nil
				}
				current.Task = &reference
				return saveOperation(context.Background(), tx, current)
			})
			m.mu.Unlock()
			if err != nil {
				continue
			}
			operation.Task = &reference
		}
		ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
		status, inspectErr := m.deps.InspectTask(ctx, *operation.Task)
		cancel()
		if inspectErr != nil {
			m.taskObservationFailed(operation)
			continue
		}
		if status.EffectiveOutcome() == tools.TaskRunning {
			m.clearTaskObservationFailure(operation)
			m.observeTaskProgress(operation, status.Progress)
			continue
		}
		m.mu.Lock()
		if !m.closed && !m.storageError {
			if _, err := m.store.get(context.Background(), operation.RunID); isNotFound(err) {
				m.mu.Unlock()
				continue
			}
			if err := m.settleDomainTask(operation, status); err != nil {
				m.storageFailedLocked()
			}
		}
		m.mu.Unlock()
	}
}

func sameUnknownObservation(o Operation, status tools.TaskStatus) bool {
	return (status.ErrorCode == "" || o.Error != nil && o.Error.Code == status.ErrorCode && o.Error.Message == status.Error) && (status.Evidence == nil || o.Error != nil && digestJSON(o.Error.Evidence) == digestJSON(status.Evidence))
}

func (m *Manager) settleDomainTask(expected Operation, status tools.TaskStatus) error {
	ctx := context.Background()
	if expected.Status == "unknown" && status.EffectiveOutcome() == tools.TaskUnknown {
		settled, err := operationReceiptSettled(ctx, m.store.db, expected.RunID, expected.CallID)
		if err != nil {
			return err
		}
		if settled && sameUnknownObservation(expected, status) {
			return nil // Repeated unknown observations must not churn the durable ledger.
		}
	}
	_, err := m.store.change(ctx, expected.RunID, "operation-task-result", func(tx *sql.Tx, r *Run) error {
		o, err := readOperation(ctx, tx, expected.ID)
		if err != nil {
			return err
		}
		if (o.Status != StateWaitingTask && o.Status != "unknown") || digestJSON(o.Task) != digestJSON(expected.Task) {
			return nil
		}
		barriers, err := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE operation_id=?", o.ID)
		if err != nil {
			return err
		}
		for _, barrier := range barriers {
			if barrier.Status == "reconciled" || barrier.Reconciliation != nil {
				return nil
			}
		}
		unknown := status.EffectiveOutcome() == tools.TaskUnknown
		status.Failed = status.EffectiveOutcome() == tools.TaskFailed
		var raw string
		var call Call
		if err := tx.QueryRowContext(ctx, "SELECT document FROM calls WHERE id=?", o.CallID).Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &call); err != nil {
			return err
		}
		// Restart may mark a dispatch unknown before its first receipt. The
		// finished event distinguishes this from a settled, empty legacy receipt.
		settled, err := operationReceiptSettled(ctx, tx, o.RunID, call.ID)
		if err != nil {
			return err
		}
		wasUnknown := o.Status == "unknown" && settled
		if unknown && wasUnknown && sameUnknownObservation(o, status) {
			return nil
		}
		previousBytes := 0
		if o.Status == "unknown" {
			previousBytes = len(call.Result)
		}
		result, _, err := projectResult(status.Value, r.Limits.ResultBytes)
		if err != nil {
			result = []byte(`null`)
			status.Failed = true
			status.Error = "任务结果超过容量限制"
			status.ErrorCode = "result-too-large"
		}
		if r.Usage.ResultBytes-previousBytes+len(result) > r.Limits.RunResultBytes {
			result = []byte(`null`)
			status.Failed = true
			status.Error = "运行结果总量达到上限"
			status.ErrorCode = "result-budget"
		}
		ended := stamp(m.deps.Now())
		o.Status = "completed"
		o.EndedAt = ended
		o.Error = nil
		o.PendingResult = nil
		o.TaskObservationFailedAt = ""
		call.Status = StateSucceeded
		call.EndedAt = ended
		call.Result = result
		call.ReservedResultBytes = 0
		call.Error = nil
		call.Evidence = status.Evidence
		if status.Failed {
			call.Status = StateFailed
			call.Error = &Failure{Code: "domain-task-failed", Message: "域任务执行失败，请检查任务日志"}
			if status.ErrorCode != "" && status.Error != "" {
				call.Error = &Failure{Code: status.ErrorCode, Message: status.Error}
			}
			call.Error.Evidence = status.Evidence
			o.Error = call.Error
		}
		if unknown {
			o.Status = "unknown"
			call.Status = StateInterrupted
			call.Error = &Failure{Code: "outcome-unknown", Message: "操作已接受，结果未确认，须核实实际状态，禁止自动重投"}
			if status.ErrorCode != "" && status.Error != "" {
				call.Error = &Failure{Code: status.ErrorCode, Message: status.Error}
			}
			call.Error.Evidence = status.Evidence
			o.Error = call.Error
			if resourceBudgetRun(*r) {
				call.ReservedResultBytes = max(0, r.Limits.ResultBytes-len(result))
			}
		}
		if !unknown && o.Recovery != nil {
			o.Recovery.Status, o.Recovery.Message = "recovered", "已取得可信结束回执，恢复任务判断"
			if terminal(r.Status) || r.CancelRequestedAt != "" {
				o.Recovery.Message = "已补齐可信结束回执，原运行终态保持不变"
			}
			if evidenceRecoveryRun(*r) {
				r.Recovery = o.Recovery
			}
		}
		if wasUnknown && r.WorkflowID != "" {
			// The unknown receipt already released its reserved result budget.
			// Reconciliation replaces that result instead of settling it twice.
			w, err := readWorkflow(ctx, tx, r.WorkflowID)
			if err != nil {
				return err
			}
			w.Usage.ResultBytes += len(result) - previousBytes
			if err := saveWorkflow(ctx, tx, &w); err != nil {
				return err
			}
		} else if err := m.workflowSettleCall(ctx, tx, r, len(result)); err != nil {
			return err
		}
		r.Usage.ResultBytes += len(result) - previousBytes
		if err := saveOperation(ctx, tx, o); err != nil {
			return err
		}
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		if err := settleOperationProtection(ctx, tx, o.ID, ended, unknown); err != nil {
			return err
		}
		r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: o.CallIndex + 1}
		if !terminal(r.Status) && r.CancelRequestedAt == "" {
			if unknown {
				if evidenceRecoveryRun(*r) {
					beginRecovery(r, &o, m.deps.Now())
					if err := saveOperation(ctx, tx, o); err != nil {
						return err
					}
					if err := m.store.event(ctx, tx, r, "call/finished", call.ID, &call.StepIndex, map[string]any{"operationId": o.ID, "status": call.Status, "domainTaskState": status.State}); err != nil {
						return err
					}
					return m.store.event(ctx, tx, r, "recovery/waiting", call.ID, nil, r.Recovery)
				}
				r.Status, r.EndReason, r.Error, r.EndedAt = StateInterrupted, "outcome-unknown", call.Error, ended
				r.MemoryStatus = "stale"
				if err := m.store.event(ctx, tx, r, "call/finished", call.ID, &call.StepIndex, map[string]any{"operationId": o.ID, "status": call.Status, "domainTaskState": status.State}); err != nil {
					return err
				}
				return m.store.event(ctx, tx, r, "run/interrupted", call.ID, &call.StepIndex, call.Error)
			}
			r.Status = StateQueued
			r.Phase = StateQueued
			if workflowDriver(*r) == "operation" {
				if status.Failed {
					r.Status = StateFailed
					r.EndReason = "domain-task-failed"
					r.Error = call.Error
					r.EndedAt = ended
				} else {
					output := string(result)
					if err := validateWorkflowJSON(r.WorkflowOutputSchemaJSON, output); err != nil {
						r.Status = StateFailed
						r.EndReason = "invalid-workflow-output"
						r.EndedAt = ended
						r.Error = &Failure{Code: r.EndReason, Message: "任务输出不符合步骤契约"}
					} else {
						r.WorkflowOutputCallID = call.ID
						r.Status = StateSucceeded
						r.EndReason = "completed"
						r.EndedAt = ended
					}
				}
			}
		}
		if err := m.store.event(ctx, tx, r, "call/finished", call.ID, &call.StepIndex, map[string]any{"operationId": o.ID, "status": call.Status, "domainTaskState": status.State}); err != nil {
			return err
		}
		if !unknown && o.Recovery != nil {
			return m.store.event(ctx, tx, r, "recovery/recovered", call.ID, nil, o.Recovery)
		}
		return nil
	})
	if err == nil {
		m.signal()
	}
	return err
}

func (m *Manager) taskObservationFailed(expected Operation) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError {
		return
	}
	current, err := readOperation(context.Background(), m.store.db, expected.ID)
	if err != nil || current.Status != StateWaitingTask || digestJSON(current.Task) != digestJSON(expected.Task) {
		return
	}
	now := m.deps.Now()
	if current.TaskObservationFailedAt == "" {
		current.TaskObservationFailedAt = stamp(now)
		err = m.store.write(context.Background(), "task-observation-failed", func(tx *sql.Tx) error { return saveOperation(context.Background(), tx, current) })
	} else if first, parseErr := time.Parse(time.RFC3339Nano, current.TaskObservationFailedAt); parseErr == nil && now.Sub(first) >= 30*time.Second {
		err = m.settleDomainTask(current, tools.TaskStatus{Outcome: tools.TaskUnknown, ErrorCode: "task-observation-unavailable", Error: "任务状态无法确认，须核实实际状态，禁止自动重投"})
	}
	if err != nil {
		m.storageFailedLocked()
	}
}

func (m *Manager) clearTaskObservationFailure(expected Operation) {
	if expected.TaskObservationFailedAt == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError {
		return
	}
	err := m.store.write(context.Background(), "task-observation-restored", func(tx *sql.Tx) error {
		current, err := readOperation(context.Background(), tx, expected.ID)
		if err != nil {
			return err
		}
		if digestJSON(current.Task) != digestJSON(expected.Task) {
			return nil
		}
		current.TaskObservationFailedAt = ""
		return saveOperation(context.Background(), tx, current)
	})
	if err != nil {
		m.storageFailedLocked()
	}
}

// A submission can return after cancellation's grace period. Preserve its
// accepted identity for observation without changing the terminal Run or guard.
func (m *Manager) rememberLateOperationTask(expected Operation, ref tools.TaskReference) {
	if ref.Domain == "" || ref.ID == "" || ref.RequestID == "" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError {
		return
	}
	ctx := context.Background()
	current, err := readOperation(ctx, m.store.db, expected.ID)
	if err != nil || current.Status != "unknown" || current.DispatchID != expected.DispatchID || current.ArgumentsJSON != expected.ArgumentsJSON {
		return
	}
	if current.Task != nil && (current.Task.Domain != ref.Domain || current.Task.ID != "" && current.Task.ID != ref.ID || current.Task.RequestID != "" && current.Task.RequestID != ref.RequestID) {
		return
	}
	err = m.store.write(ctx, "operation-late-task-accepted", func(tx *sql.Tx) error {
		barriers, err := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE operation_id=?", current.ID)
		if err != nil {
			return err
		}
		for _, barrier := range barriers {
			if barrier.Status == "reconciled" || barrier.Reconciliation != nil {
				return nil
			}
		}
		current.Task = &ref
		return saveOperation(ctx, tx, current)
	})
	if err != nil {
		m.storageFailedLocked()
	}
}
