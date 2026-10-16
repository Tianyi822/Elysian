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
		}
	}
}

func (m *Manager) monitorTasks() {
	if m.deps.InspectTask == nil {
		return
	}
	m.mu.Lock()
	if m.closed || m.storageError {
		m.mu.Unlock()
		return
	}
	operations, err := readDocuments[Operation](m.ctx, m.store.db, "SELECT document FROM operations WHERE state='waiting-task' OR (state='unknown' AND json_extract(document,'$.task.id') IS NOT NULL) ORDER BY rowid")
	m.mu.Unlock()
	if err != nil {
		return
	}
	for _, operation := range operations {
		if operation.Task == nil {
			continue
		}
		if operation.Task.ID == "" || operation.Task.RequestID == "" {
			if m.deps.LookupTask == nil {
				continue
			}
			ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
			reference, lookupErr := m.deps.LookupTask(ctx, *operation.Task)
			cancel()
			if lookupErr != nil || reference.ID == "" || reference.RequestID == "" || reference.Domain != operation.Task.Domain || operation.Task.ID != "" && reference.ID != operation.Task.ID || operation.Task.RequestID != "" && reference.RequestID != operation.Task.RequestID {
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
		if inspectErr != nil || !status.Terminal {
			continue
		}
		m.mu.Lock()
		if !m.closed && !m.storageError {
			if err := m.settleDomainTask(operation, status); err != nil {
				m.storageFailedLocked()
			}
		}
		m.mu.Unlock()
	}
}

func (m *Manager) settleDomainTask(expected Operation, status tools.TaskStatus) error {
	ctx := context.Background()
	_, err := m.store.change(ctx, expected.RunID, "operation-task-result", func(tx *sql.Tx, r *Run) error {
		o, err := readOperation(ctx, tx, expected.ID)
		if err != nil {
			return err
		}
		if (o.Status != StateWaitingTask && o.Status != "unknown") || digestJSON(o.Task) != digestJSON(expected.Task) {
			return nil
		}
		var raw string
		var call Call
		if err := tx.QueryRowContext(ctx, "SELECT document FROM calls WHERE id=?", o.CallID).Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &call); err != nil {
			return err
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
		}
		if r.Usage.ResultBytes-previousBytes+len(result) > r.Limits.RunResultBytes {
			result = []byte(`null`)
			status.Failed = true
			status.Error = "运行结果总量达到上限"
		}
		ended := stamp(m.deps.Now())
		o.Status = "completed"
		o.EndedAt = ended
		o.Error = nil
		o.PendingResult = nil
		call.Status = StateSucceeded
		call.EndedAt = ended
		call.Result = result
		call.Error = nil
		if status.Failed {
			call.Status = StateFailed
			call.Error = &Failure{Code: "domain-task-failed", Message: "域任务执行失败，请检查任务日志"}
			o.Error = call.Error
		}
		if expected.Status == "unknown" && r.WorkflowID != "" {
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
		barriers, err := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE operation_id=?", o.ID)
		if err != nil {
			return err
		}
		for _, barrier := range barriers {
			barrier.Status = "confirmed"
			if err := saveBarrier(ctx, tx, barrier); err != nil {
				return err
			}
		}
		if err := settleResourceLease(ctx, tx, o.ID, ended, false, "", ""); err != nil {
			return err
		}
		r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: o.CallIndex + 1}
		if !terminal(r.Status) && r.CancelRequestedAt == "" {
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
		return nil
	})
	if err == nil {
		m.signal()
	}
	return err
}
