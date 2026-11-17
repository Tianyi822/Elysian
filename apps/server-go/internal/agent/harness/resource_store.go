package harness

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
)

// promoteResourceWaiters moves only resource-waiting runs whose claims are
// currently available back to the normal queue. The lease remains waiting;
// the subsequent dispatch transaction acquires it together with its approval,
// budget reservation and dispatch marker.
func (m *Manager) promoteResourceWaiters(ctx context.Context) (int, error) {
	var promoted int
	err := writeStore(m.store, ctx, "resource-promote", func(tx sessionstore.Tx) error {
		var queued int
		if err := tx.QueuedRunCount(ctx, &queued); err != nil {
			return err
		}
		leases, err := tx.WaitingResourceLeases(ctx)
		if err != nil {
			return err
		}
		for _, lease := range leases {
			r, err := readRun(ctx, tx, lease.RunID)
			if err != nil {
				return err
			}
			if hstate.Terminal(r.Status) || r.CancelRequestedAt != "" {
				lease.State = "released"
				lease.EndedAt = stamp(m.deps.Now())
				if err := saveResourceLease(ctx, tx, lease); err != nil {
					return err
				}
				continue
			}
			if r.Status != StateWaitingResource {
				continue
			}
			o, err := readOperation(ctx, tx, lease.OperationID)
			if err != nil {
				return err
			}
			available, err := resourceLeaseAvailable(ctx, tx, o, lease)
			if err != nil {
				return err
			}
			if !available {
				previous := hstate.DigestJSON(o.ResourceWait)
				o.Status = StateWaitingResource
				o.ResourceWait, err = resourceWaitReason(ctx, tx, o, stamp(m.deps.Now()))
				if err != nil {
					return err
				}
				if o.ResourceWait.Unknown {
					if err := interruptResourceWaiter(ctx, tx, &r, o, stamp(m.deps.Now())); err != nil {
						return err
					}
				} else if previous != hstate.DigestJSON(o.ResourceWait) {
					if err := saveOperation(ctx, tx, o); err != nil {
						return err
					}
				}
				continue
			}
			if queued >= r.Limits.QueueCapacity {
				continue
			}
			r.Status = StateQueued
			r.Phase = StateQueued
			if err := tx.Event(ctx, &r, "resource/ready", o.CallID, &o.CallIndex, map[string]string{"operationId": lease.OperationID}); err != nil {
				return err
			}
			promoted++
			queued++
		}
		return nil
	})
	return promoted, err
}

func (m *Manager) ResourceLeases(ctx context.Context) ([]ResourceLease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	value, readErr := storeRead(ctx, m.store, "ResourceLeases", func(ctx context.Context) ([]ResourceLease, error) {
		leases, err := readView(ctx, m.store).ResourceLeases(ctx)
		return leases, err
	})
	return value, storageFailure(readErr)
}
