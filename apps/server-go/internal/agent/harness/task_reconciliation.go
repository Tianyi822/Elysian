package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"elysian/server/internal/agent/tools"
)

func readBarrier(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (ExecutionBarrier, error) {
	var b ExecutionBarrier
	var raw string
	if err := q.QueryRowContext(ctx, "SELECT document FROM execution_barriers WHERE id=?", id).Scan(&raw); err != nil {
		return b, err
	}
	err := json.Unmarshal([]byte(raw), &b)
	return b, err
}

// Reconcile persists intent before calling the injected domain resolver outside
// the manager lock and SQLite transaction. Repeated requests and startup retries
// complete this same intent, never replaying the original business operation.
func (m *Manager) Reconcile(ctx context.Context, id, evidence, decision string) (ExecutionBarrier, error) {
	m.mu.Lock()
	var b ExecutionBarrier
	if m.closed {
		m.mu.Unlock()
		return b, closedError()
	}
	if m.storageError {
		m.mu.Unlock()
		return b, storageFailure(errors.New("存储故障，核实暂不可用"))
	}
	if len(evidence) < 1 || len(evidence) > 8192 || (decision != "confirmed-completed" && decision != "confirmed-stopped") {
		m.mu.Unlock()
		return b, bad("invalid-reconciliation", "必须提供外部核实证据及 confirmed-completed 或 confirmed-stopped 决定")
	}
	err := m.store.write(ctx, "reconciliation-intent", func(tx *sql.Tx) error {
		var err error
		b, err = readBarrier(ctx, tx, id)
		if err != nil {
			return err
		}
		if b.Status == "reconciled" || b.Reconciliation != nil {
			if b.Decision == decision && b.Evidence == evidence {
				return nil
			}
			return &Error{409, "decision-conflict", "该屏障已有不同核实决定"}
		}
		if b.Status != "unknown" {
			return &Error{409, "barrier-state-conflict", "只能核实已标记结果未知的操作；在途操作必须先结束确认流程"}
		}
		b.Decision, b.Evidence = decision, evidence
		o, err := readOperation(ctx, tx, b.OperationID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if active := m.executionLocked(o.RunID); active != nil {
			if active.unresponsive {
				return bad("verification-running", "原执行尚未确认停止，保护保留")
			}
			if active.callDone != nil {
				select {
				case <-active.callDone:
				default:
					return bad("verification-running", "原执行仍在进行，保护保留")
				}
			}
		}
		if o.Task != nil {
			if o.Task.ID == "" || o.Task.RequestID == "" {
				return &Error{409, "task-identity-unresolved", "须先核实异步任务的完整受理身份"}
			}
			b.Reconciliation = &tools.TaskReconciliation{ID: b.ID, OperationID: o.ID, Task: *o.Task, ArgumentsDigest: digestJSON(o.ArgumentsJSON), Tool: o.Capability.Name, Decision: decision, Evidence: evidence}
			return saveBarrier(ctx, tx, b)
		}
		b.Status, b.ReconciledAt = "reconciled", stamp(m.deps.Now())
		if err := saveBarrier(ctx, tx, b); err != nil {
			return err
		}
		return m.settleReconciledProtection(ctx, tx, b)
	})
	if err == nil {
		err = m.store.recordsFault()
	}
	m.mu.Unlock()
	if err != nil {
		return b, storageFailure(err)
	}
	if b.Status == "reconciled" {
		m.signal()
		return b, nil
	}
	return m.completeTaskReconciliation(ctx, b)
}

func (m *Manager) completeTaskReconciliation(ctx context.Context, expected ExecutionBarrier) (ExecutionBarrier, error) {
	m.mu.Lock()
	if m.closed || m.storageError {
		m.mu.Unlock()
		return expected, closedError()
	}
	if err := m.store.recordsFault(); err != nil {
		m.mu.Unlock()
		return expected, storageFailure(err)
	}
	b, err := readBarrier(ctx, m.store.db, expected.ID)
	if err != nil {
		m.mu.Unlock()
		return b, storageFailure(err)
	}
	if b.Status == "reconciled" {
		m.mu.Unlock()
		return b, nil
	}
	if b.Reconciliation == nil || digestJSON(b.Reconciliation) != digestJSON(expected.Reconciliation) {
		m.mu.Unlock()
		return b, &Error{409, "decision-conflict", "核实决定已变化"}
	}
	o, err := readOperation(ctx, m.store.db, b.OperationID)
	if err != nil {
		m.mu.Unlock()
		return b, storageFailure(err)
	}
	if !reconciliationOperationMatches(b.Reconciliation, o) {
		m.mu.Unlock()
		return b, &Error{409, "task-identity-changed", "核实任务身份已变化"}
	}
	intent := *b.Reconciliation
	intent.ArgumentsJSON = o.ArgumentsJSON
	resolver := m.deps.ReconcileTask
	m.mu.Unlock()
	if resolver == nil {
		return b, &Error{503, "task-reconciliation-unavailable", "域任务核实暂不可用，核实决定已保存，资源保护保留"}
	}
	if err := resolver(ctx, intent); err != nil {
		return b, &Error{409, "task-reconciliation-pending", "域任务尚未完成核实，核实决定已保存，资源保护保留"}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError {
		return b, closedError()
	}
	err = m.store.write(ctx, "reconciliation-completed", func(tx *sql.Tx) error {
		current, err := readBarrier(ctx, tx, b.ID)
		if err != nil {
			return err
		}
		if current.Status == "reconciled" {
			b = current
			return nil
		}
		if current.Status != "unknown" || digestJSON(current.Reconciliation) != digestJSON(b.Reconciliation) {
			return &Error{409, "decision-conflict", "核实决定已变化"}
		}
		op, err := readOperation(ctx, tx, b.OperationID)
		if err != nil {
			return err
		}
		if !reconciliationOperationMatches(&intent, op) {
			return &Error{409, "task-identity-changed", "核实任务身份已变化"}
		}
		b.Status, b.ReconciledAt = "reconciled", stamp(m.deps.Now())
		if err := saveBarrier(ctx, tx, b); err != nil {
			return err
		}
		return m.settleReconciledProtection(ctx, tx, b)
	})
	if err == nil {
		m.signal()
	}
	return b, storageFailure(err)
}

func reconciliationOperationMatches(intent *tools.TaskReconciliation, o Operation) bool {
	return intent != nil && intent.OperationID == o.ID && intent.Tool == o.Capability.Name && intent.ArgumentsDigest == digestJSON(o.ArgumentsJSON) && digestJSON(o.Task) == digestJSON(&intent.Task)
}

func (m *Manager) settleReconciledProtection(ctx context.Context, tx *sql.Tx, b ExecutionBarrier) error {
	// The unknown receipt is already charged. Reconciliation releases only the
	// remaining reservation; it must not charge the receipt or workflow twice.
	o, err := readOperation(ctx, tx, b.OperationID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if o.CallID != "" {
		var raw string
		if err := tx.QueryRowContext(ctx, "SELECT document FROM calls WHERE id=?", o.CallID).Scan(&raw); err != nil {
			return err
		}
		var call Call
		if err := json.Unmarshal([]byte(raw), &call); err != nil {
			return err
		}
		settled, err := operationReceiptSettled(ctx, tx, b.RunID, call.ID)
		if err != nil {
			return err
		}
		if !settled {
			// A crash can precede the first receipt. Release an unsettled
			// workflow reservation once, without inventing a business result.
			r, err := readRun(ctx, tx, b.RunID)
			if err != nil {
				return err
			}
			if err := m.workflowSettleCall(ctx, tx, &r, 0); err != nil {
				return err
			}
		}
		call.ReservedResultBytes = 0
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
	}
	if o.RunID != "" {
		r, err := readRun(ctx, tx, o.RunID)
		if err != nil {
			return err
		}
		r.Recovery = &RunRecovery{OperationID: o.ID, Tool: o.Capability.Name, StartedAt: b.CreatedAt, Deadline: b.ReconciledAt, Status: "recovered", Message: "对应操作已按核实证据解除阻塞，原运行终态与原始回执保持不变"}
		if err := saveRun(ctx, tx, &r); err != nil {
			return err
		}
	}
	return settleResourceLease(ctx, tx, b.OperationID, b.ReconciledAt, false, b.Evidence, b.Decision)
}

func (m *Manager) retryReconciliations() {
	m.mu.Lock()
	if m.closed || m.storageError || m.deps.Now().Before(m.reconciliationRetryAt) {
		m.mu.Unlock()
		return
	}
	m.reconciliationRetryAt = m.deps.Now().Add(5 * time.Second)
	barriers, err := readDocuments[ExecutionBarrier](m.ctx, m.store.db, "SELECT document FROM execution_barriers WHERE state='unknown' AND json_extract(document,'$.reconciliation') IS NOT NULL ORDER BY rowid LIMIT 16")
	m.mu.Unlock()
	if err != nil {
		return
	}
	for _, barrier := range barriers {
		ctx, cancel := context.WithTimeout(m.ctx, 5*time.Second)
		_, _ = m.completeTaskReconciliation(ctx, barrier)
		cancel()
	}
}
