package harness

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"elysian/server/internal/agent/harness/worker"
)

// RunWait is a durable scheduling decision, never an authorization to replay a
// tool. Resume still passes the original operation/approval/barrier checks.
var continuousPolicies = "enabled" // compatibility rollback: -X elysian/server/internal/agent/harness.continuousPolicies=freeze

type RunWait struct {
	Kind      string   `json:"kind"`
	NextAt    string   `json:"nextAt"`
	Attempts  int      `json:"attempts"`
	RequestID string   `json:"requestId,omitempty"`
	Reason    *Failure `json:"reason,omitempty"`
}

type PolicyCheckpoint struct {
	Status string   `json:"status"`
	Phase  string   `json:"phase"`
	Error  *Failure `json:"error,omitempty"`
}

func modelBackoff(attempt int) time.Duration {
	delays := []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute}
	return delays[min(max(0, attempt-1), len(delays)-1)]
}

func (a *agentExecution) suspendForRecovery(state string, failure *Failure, requestID string) error {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := m.store.change(context.Background(), a.run.ID, "continuous-wait", func(tx *sql.Tx, r *Run) error {
		if !continuousRun(*r) || r.Status != StateRunning || r.CancelRequestedAt != "" {
			return context.Canceled
		}
		attempts := 1
		if r.Wait != nil && r.Wait.Kind == state {
			attempts = r.Wait.Attempts + 1
			if r.Wait.RequestID != "" {
				requestID = r.Wait.RequestID
			}
		}
		delay := modelBackoff(attempts)
		if failure != nil && time.Duration(min(failure.RetryAfterSeconds, int((1<<63-1)/int64(time.Second))))*time.Second > delay {
			delay = time.Duration(min(failure.RetryAfterSeconds, int((1<<63-1)/int64(time.Second)))) * time.Second
		}
		r.Wait = &RunWait{Kind: state, NextAt: stamp(m.deps.Now().Add(delay)), Attempts: attempts, RequestID: requestID, Reason: failure}
		if a.pending != nil && a.pending.Response != nil && a.pendingIndex < len(a.pending.Response.ToolCalls) {
			r.Resume = &RecoveryCursor{ResponseID: a.pending.ID, CallIndex: a.pendingIndex}
		}
		r.Status, r.Phase = state, state
		return m.store.event(context.Background(), tx, r, "recovery/waiting", "", nil, r.Wait)
	})
	if err != nil {
		return storageFailure(err)
	}
	m.signal()
	return worker.ErrSuspended
}

func (m *Manager) promoteContinuousWaiters() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError || m.store.recordsFault() != nil {
		return
	}
	ctx := m.ctx
	runs, err := storeRead(ctx, m.store, "continuous-waiters", func(ctx context.Context) ([]Run, error) {
		return readDocuments[Run](ctx, m.store.reader(ctx), "SELECT document FROM runs WHERE state IN ('waiting-model','waiting-storage') ORDER BY created_at LIMIT 64")
	})
	if err != nil {
		return
	}
	for _, run := range runs {
		if !continuousRun(run) || run.PolicyFrozen || run.Wait == nil || run.CancelRequestedAt != "" {
			continue
		}
		next, err := time.Parse(time.RFC3339Nano, run.Wait.NextAt)
		if err != nil || m.deps.Now().Before(next) {
			continue
		}
		_, err = m.store.change(ctx, run.ID, "continuous-resume", func(tx *sql.Tx, r *Run) error {
			if r.Status != run.Status || r.CancelRequestedAt != "" || r.Wait == nil || r.Wait.NextAt != run.Wait.NextAt {
				return nil
			}
			session, err := readSession(ctx, tx, r.SessionID)
			if err != nil {
				return err
			}
			if session.ActiveRunID != r.ID || r.SupersededByRunID != "" {
				return nil
			}
			unknown, err := unsettledRun(ctx, tx, r.ID)
			if err != nil {
				return err
			}
			if unknown {
				return nil
			}
			r.Status, r.Phase = StateQueued, "recovering"
			return m.store.event(ctx, tx, r, "recovery/resuming", "", nil, r.Wait)
		})
		if err != nil {
			return
		}
		m.signal()
	}
}

func unsettledRun(ctx context.Context, q rowReader, id string) (bool, error) {
	var unsettled bool
	err := q.QueryRowContext(ctx, `SELECT
 EXISTS(SELECT 1 FROM execution_barriers WHERE run_id=? AND state IN ('dispatched','unknown')) OR
 EXISTS(SELECT 1 FROM resource_leases WHERE run_id=? AND state IN ('held','unknown')) OR
 EXISTS(SELECT 1 FROM operations WHERE run_id=? AND state IN ('dispatched','unknown','waiting-task'))`, id, id, id).Scan(&unsettled)
	return unsettled, err
}

// Recover only a proven checkpoint. Unknown tools retain their original
// identities and are left to the existing domain reconciliation monitor.
func (s *store) recoverContinuous(ctx context.Context, tx *sql.Tx, r *Run) (bool, error) {
	if !continuousRun(*r) || terminal(r.Status) || r.PolicyFrozen || r.CancelRequestedAt != "" || r.SupersededByRunID != "" {
		return false, nil
	}
	session, err := readSession(ctx, tx, r.SessionID)
	if err != nil {
		return false, err
	}
	if session.ActiveRunID != r.ID {
		return false, nil
	}
	unsettled, err := unsettledRun(ctx, tx, r.ID)
	if err != nil {
		return false, err
	}
	if unsettled {
		r.Status, r.Phase = StateRecoveryRequired, "recovering"
		r.Error = &Failure{Code: "recovery-evidence-required", Message: "仍有未结执行保护，已暂停派发并等待可信结束证据"}
		operations, err := readDocuments[Operation](ctx, tx, "SELECT document FROM operations WHERE run_id=? AND state IN ('unknown','waiting-task','dispatched')", r.ID)
		if err != nil {
			return false, err
		}
		for _, operation := range operations {
			beginRecovery(r, &operation, s.now())
			if err = saveOperation(ctx, tx, operation); err != nil {
				return false, err
			}
		}
		if err = interruptCalls(ctx, tx, r.ID, s.now()); err != nil {
			return false, err
		}
		if err = s.event(ctx, tx, r, "recovery/restarted-verification", "", nil, r.Recovery); err != nil {
			return false, err
		}
		return true, nil
	}
	if err := interruptModelRequests(ctx, tx, r.ID, s.now()); err != nil {
		return false, err
	}
	r.Status, r.Phase = StateQueued, "recovering"
	r.EndReason, r.EndedAt, r.Error = "", "", nil
	if err := s.event(ctx, tx, r, "recovery/restarted", "", nil, map[string]string{"message": "已核对执行检查点，沿用原任务与请求身份继续"}); err != nil {
		return false, err
	}
	return true, nil
}

func transientStorageRead(err error) bool {
	if err == nil || commitUnconfirmed(err) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	code := sqliteCode(err) & 255
	return code == 5 || code == 6 || code == 9
}

func (s *store) freezeContinuousRuns(ctx context.Context, tx *sql.Tx) error {
	if !s.freezeContinuous {
		return nil
	}
	runs, err := readDocuments[Run](ctx, tx, "SELECT document FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted')")
	if err != nil {
		return err
	}
	for _, r := range runs {
		if continuousRun(r) && !r.PolicyFrozen {
			r.PolicyCheckpoint = &PolicyCheckpoint{Status: r.Status, Phase: r.Phase, Error: r.Error}
			r.PolicyFrozen = true
			r.Status, r.Phase = StateRecoveryRequired, "policy-frozen"
			r.Error = &Failure{Code: "continuous-policy-frozen", Message: "兼容回滚已冻结持续执行策略，保留执行事实与保护；请恢复支持该策略的版本后核实"}
			if err = s.event(ctx, tx, &r, "recovery/policy-frozen", "", nil, r.Error); err != nil {
				return err
			}
		}
	}
	return nil
}

// A supporting build may unfreeze scheduling only after validating the same
// active Run and its durable execution protection. Terminal/cancelled history
// remains frozen; no operation is resubmitted by this transition.
func (s *store) thawContinuousRuns(ctx context.Context, tx *sql.Tx) error {
	if s.freezeContinuous {
		return nil
	}
	runs, err := readDocuments[Run](ctx, tx, "SELECT document FROM runs WHERE state='recovery-required' AND json_extract(document,'$.policyFrozen')=1")
	if err != nil {
		return err
	}
	for _, r := range runs {
		if !continuousRun(r) || r.CancelRequestedAt != "" || r.SupersededByRunID != "" || r.PolicyCheckpoint == nil {
			continue
		}
		session, err := readSession(ctx, tx, r.SessionID)
		if err != nil {
			return err
		}
		if session.ActiveRunID != r.ID {
			continue
		}
		checkpoint := r.PolicyCheckpoint
		r.PolicyFrozen, r.PolicyCheckpoint = false, nil
		r.Status, r.Phase, r.Error = checkpoint.Status, checkpoint.Phase, checkpoint.Error
		unknown, err := unsettledRun(ctx, tx, r.ID)
		if err != nil {
			return err
		}
		if unknown || r.Status == StateRunning || r.Status == StateQueued || r.Status == StateWaitingTask || r.Status == StateWaitingRecovery {
			if _, err = s.recoverContinuous(ctx, tx, &r); err != nil {
				return err
			}
		}
		if err = s.event(ctx, tx, &r, "recovery/policy-restored", "", nil, map[string]string{"message": "已核对原任务身份与执行保护，恢复支持版本的调度策略"}); err != nil {
			return err
		}
	}
	return nil
}
