package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

func resourceClaimsConflict(a, b ResourceClaim) bool {
	if a.Kind == "global" || b.Kind == "global" {
		return true
	}
	if a.Access == "read" && b.Access == "read" {
		return false
	}
	if a.Kind != b.Kind || a.Authority != b.Authority {
		return false
	}
	if a.Key == b.Key {
		return true
	}
	within := func(parent, child string) bool {
		return parent == "/" || strings.HasPrefix(child, parent+"/")
	}
	return a.Subtree && within(a.Key, b.Key) || b.Subtree && within(b.Key, a.Key)
}

func resourceSetsConflict(a, b []ResourceClaim) bool {
	for _, left := range a {
		for _, right := range b {
			if resourceClaimsConflict(left, right) {
				return true
			}
		}
	}
	return false
}

func externalOperation(o Operation) bool {
	if o.Capability.Source == "builtin" {
		return !o.Capability.ReadOnly
	}
	// Workspace reads/writes are committed through the task workspace CAS in
	// the same parent transaction, so they do not represent an external system
	// side effect. A workspace write still gets a barrier from ReadOnly=false;
	// reads must not become unknown external operations on cancellation.
	return o.Capability.Source != "builtin" && o.Capability.Source != "skill-load" && o.Capability.Source != "wiki" && o.Capability.Source != "workspace" && o.Capability.Source != toolDiscoverySource
}

func saveResourceLease(ctx context.Context, tx *sql.Tx, lease ResourceLease) error {
	raw, err := json.Marshal(lease)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO resource_leases(id,run_id,operation_id,state,document) VALUES(?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, lease.ID, lease.RunID, lease.OperationID, lease.State, string(raw))
	return err
}

// resourceLeaseAvailable checks whether a waiting lease can become held. It
// deliberately has no write side effects so a waiter can be promoted back to
// queued without reserving its call budget or consuming its approval.
func resourceLeaseAvailable(ctx context.Context, tx *sql.Tx, o Operation, lease ResourceLease) (bool, error) {
	taskControl := o.Capability.Metadata.Async && o.Capability.Metadata.Action == "cancel" && o.Capability.Metadata.TaskDomain != "" && o.Capability.Metadata.TaskIDArgument != ""
	if externalOperation(o) && !taskControl {
		var barrierCount, leaseCount int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM execution_barriers WHERE state='unknown'").Scan(&barrierCount); err != nil {
			return false, err
		}
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM resource_leases WHERE state='unknown'").Scan(&leaseCount); err != nil {
			return false, err
		}
		if barrierCount > 0 || leaseCount > 0 {
			return false, nil
		}
	}
	others, err := readDocuments[ResourceLease](ctx, tx, `SELECT document FROM resource_leases WHERE id<>? AND
(state IN ('held','unknown') OR (state='waiting' AND sequence<(SELECT sequence FROM resource_leases WHERE id=?))) ORDER BY sequence`, lease.ID, lease.ID)
	if err != nil {
		return false, err
	}
	for _, other := range others {
		if resourceSetsConflict(lease.Claims, other.Claims) {
			return false, nil
		}
	}
	return true, nil
}

// acquireResourceLease is called in the dispatch transaction before reserving
// budgets or consuming approval. A denied acquisition commits only a waiter.
// Earlier conflicting waiters cannot be bypassed by a later operation.
func acquireResourceLease(ctx context.Context, tx *sql.Tx, o Operation, now string) (bool, error) {
	lease := ResourceLease{ID: o.ID, OperationID: o.ID, RunID: o.RunID, ScopeID: o.ID, State: "waiting", Claims: o.ResourceClaims, CreatedAt: now}
	if o.ScopeID != "" {
		lease.ScopeID = o.ScopeID
	}
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT document FROM resource_leases WHERE id=?", lease.ID).Scan(&raw)
	if err == nil {
		if err = json.Unmarshal([]byte(raw), &lease); err != nil {
			return false, err
		}
		if digestJSON(lease.Claims) != digestJSON(o.ResourceClaims) || lease.OperationID != o.ID || lease.RunID != o.RunID {
			return false, bad("resource-claims-changed", "资源声明与持久租约不符")
		}
		if lease.State == "released" && o.DispatchID == "" && o.DispatchedAt == "" && lease.Evidence == "" {
			lease.State = "waiting"
			lease.EndedAt = ""
			if err := saveResourceLease(ctx, tx, lease); err != nil {
				return false, err
			}
		}
		if lease.State != "waiting" {
			return false, bad("resource-lease-state", "已派发或已结束的资源租约不能重复获取")
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	} else if err = saveResourceLease(ctx, tx, lease); err != nil {
		return false, err
	}
	available, err := resourceLeaseAvailable(ctx, tx, o, lease)
	if err != nil {
		return false, err
	}
	if !available {
		return false, nil
	}
	lease.State = "held"
	return true, saveResourceLease(ctx, tx, lease)
}

// promoteResourceWaiters moves only resource-waiting runs whose claims are
// currently available back to the normal queue. The lease remains waiting;
// the subsequent dispatch transaction acquires it together with its approval,
// budget reservation and dispatch marker.
func (m *Manager) promoteResourceWaiters(ctx context.Context) (int, error) {
	var promoted int
	err := m.store.write(ctx, "resource-promote", func(tx *sql.Tx) error {
		var queued int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(&queued); err != nil {
			return err
		}
		leases, err := readDocuments[ResourceLease](ctx, tx, "SELECT document FROM resource_leases WHERE state='waiting' ORDER BY sequence")
		if err != nil {
			return err
		}
		for _, lease := range leases {
			r, err := readRun(ctx, tx, lease.RunID)
			if err != nil {
				return err
			}
			if terminal(r.Status) || r.CancelRequestedAt != "" {
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
			if queued >= r.Limits.QueueCapacity {
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
				continue
			}
			r.Status = StateQueued
			r.Phase = StateQueued
			if err := m.store.event(ctx, tx, &r, "resource/ready", o.CallID, &o.CallIndex, map[string]string{"operationId": lease.OperationID}); err != nil {
				return err
			}
			promoted++
			queued++
		}
		return nil
	})
	return promoted, err
}

// settleResourceLease retains unknown claims until reconciliation provides
// external evidence. Confirmed completion and lease release commit together.
func settleResourceLease(ctx context.Context, tx *sql.Tx, operationID, now string, unknown bool, evidence, decision string) error {
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT document FROM resource_leases WHERE operation_id=?", operationID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil // Pre-v5 operations have no resource lease.
	}
	if err != nil {
		return err
	}
	var lease ResourceLease
	if err = json.Unmarshal([]byte(raw), &lease); err != nil {
		return err
	}
	lease.State = "released"
	lease.EndedAt = now
	lease.Evidence, lease.Decision = evidence, decision
	if unknown {
		lease.State = "unknown"
		lease.EndedAt = ""
	}
	return saveResourceLease(ctx, tx, lease)
}

// releaseWaitingResourceLeases is used by cancellation/expiry paths. Held or
// unknown leases are intentionally untouched; only an explicit result or
// reconciliation can prove that an external operation stopped.
func releaseWaitingResourceLeases(ctx context.Context, tx *sql.Tx, runID, now string) error {
	leases, err := readDocuments[ResourceLease](ctx, tx, "SELECT document FROM resource_leases WHERE run_id=? AND state='waiting'", runID)
	if err != nil {
		return err
	}
	for _, lease := range leases {
		lease.State = "released"
		lease.EndedAt = now
		if err := saveResourceLease(ctx, tx, lease); err != nil {
			return err
		}
	}
	return nil
}

func recoverResourceLeases(ctx context.Context, tx *sql.Tx) error {
	leases, err := readDocuments[ResourceLease](ctx, tx, "SELECT document FROM resource_leases WHERE state='held' AND operation_id NOT IN (SELECT id FROM operations WHERE state='waiting-task')")
	if err != nil {
		return err
	}
	for _, lease := range leases {
		lease.State = "unknown"
		if err = saveResourceLease(ctx, tx, lease); err != nil {
			return err
		}
	}
	return nil
}

func (m *Manager) ResourceLeases(ctx context.Context) ([]ResourceLease, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil, closedError()
	}
	leases, err := readDocuments[ResourceLease](ctx, m.store.db, "SELECT document FROM resource_leases ORDER BY CASE WHEN state IN ('waiting','held','unknown') THEN 0 ELSE 1 END,sequence DESC LIMIT 200")
	return leases, storageFailure(err)
}
