package harness

import (
	"context"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/harness/worker"
)

// RunWait is a durable scheduling decision, never an authorization to replay a
// tool. Resume still passes the original operation/approval/barrier checks.
var continuousPolicies = "enabled" // compatibility rollback: -X elysian/server/internal/agent/harness.continuousPolicies=freeze

func modelBackoff(attempt int) time.Duration {
	delays := []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 5 * time.Minute}
	return delays[min(max(0, attempt-1), len(delays)-1)]
}

func (a *agentExecution) suspendForRecovery(state string, failure *Failure, requestID string) error {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	_, err := m.store.ChangeRun(context.Background(), a.run.ID, "continuous-wait", func(tx sessionstore.Tx, r *Run) error {
		if !hstate.ContinuousRun(*r) || r.Status != StateRunning || r.CancelRequestedAt != "" {
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
		return tx.Event(context.Background(), r, "recovery/waiting", "", nil, r.Wait)
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
	if m.closed || m.storageError || m.store.DispatchError() != nil {
		return
	}
	ctx := m.ctx
	runs, err := storeRead(ctx, m.store, "continuous-waiters", func(ctx context.Context) ([]Run, error) {
		return readView(ctx, m.store).ContinuousWaiters(ctx)
	})
	if err != nil {
		return
	}
	for _, run := range runs {
		if !hstate.ContinuousRun(run) || run.PolicyFrozen || run.Wait == nil || run.CancelRequestedAt != "" {
			continue
		}
		next, err := time.Parse(time.RFC3339Nano, run.Wait.NextAt)
		if err != nil || m.deps.Now().Before(next) {
			continue
		}
		_, err = m.store.ChangeRun(ctx, run.ID, "continuous-resume", func(tx sessionstore.Tx, r *Run) error {
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
			return tx.Event(ctx, r, "recovery/resuming", "", nil, r.Wait)
		})
		if err != nil {
			return
		}
		m.signal()
	}
}

func transientStorageRead(err error) bool {
	return sessionstore.IsTransientRead(err)
}
