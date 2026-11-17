package harness

import (
	"context"
	"database/sql"
	"time"
)

// ResourceWait is a bounded explanation, not a new resource authorization.
type ResourceWait struct {
	Resource       string `json:"resource"`
	RunID          string `json:"runId,omitempty"`
	OperationID    string `json:"operationId,omitempty"`
	Since          string `json:"since"`
	ElapsedSeconds int    `json:"elapsedSeconds"`
	Message        string `json:"message"`
	Unknown        bool   `json:"unknown"`
}

func resourceWaitReason(ctx context.Context, tx *sql.Tx, o Operation, now string) (*ResourceWait, error) {
	wait := &ResourceWait{Since: now, Message: "等待其他操作释放资源"}
	var created string
	if err := tx.QueryRowContext(ctx, "SELECT json_extract(document,'$.createdAt') FROM resource_leases WHERE id=?", o.ID).Scan(&created); err != nil {
		return nil, err
	}
	if created != "" {
		wait.Since = created
	}
	if unknown, err := unknownResourceWait(ctx, tx, o, wait.Since); err != nil || unknown != nil {
		return unknown, err
	}
	leases, err := readDocuments[ResourceLease](ctx, tx, "SELECT document FROM resource_leases WHERE id<>? AND (state='held' OR (state='waiting' AND sequence<(SELECT sequence FROM resource_leases WHERE id=?))) ORDER BY sequence", o.ID, o.ID)
	if err != nil {
		return nil, err
	}
	for _, lease := range leases {
		resource, conflicts := resourceWaitConflict(o, lease)
		if !conflicts {
			continue
		}
		wait.RunID, wait.OperationID, wait.Resource = lease.RunID, lease.OperationID, resource
		return wait, nil
	}
	return wait, nil
}

// Unknown protection is inspected before asking for approval and again in the
// dispatch transaction. This read does not acquire a lease or authorize work.
func unknownResourceWait(ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, o Operation, now string) (*ResourceWait, error) {
	wait := &ResourceWait{Since: now, Unknown: true, Message: "此前操作结果待核实，禁止自动重投"}
	taskControl := o.Capability.Metadata.Async && o.Capability.Metadata.Action == "cancel" && o.Capability.Metadata.TaskDomain != "" && o.Capability.Metadata.TaskIDArgument != ""
	globalFence := externalOperation(o) && !taskControl
	if globalFence {
		barriers, err := readDocuments[ExecutionBarrier](ctx, db, "SELECT document FROM execution_barriers WHERE state='unknown' ORDER BY rowid LIMIT 1")
		if err != nil {
			return nil, err
		}
		if len(barriers) > 0 {
			wait.RunID, wait.OperationID, wait.Resource = barriers[0].RunID, barriers[0].OperationID, "external:*"
			return wait, nil
		}
	}
	leases, err := readDocuments[ResourceLease](ctx, db, "SELECT document FROM resource_leases WHERE id<>? AND state='unknown' ORDER BY sequence", o.ID)
	if err != nil {
		return nil, err
	}
	for _, lease := range leases {
		resource, conflicts := resourceWaitConflict(o, lease)
		if !globalFence && !conflicts {
			continue
		}
		if globalFence {
			resource = "external:*"
		}
		wait.RunID, wait.OperationID, wait.Resource = lease.RunID, lease.OperationID, resource
		return wait, nil
	}
	return nil, nil
}

func resourceWaitConflict(o Operation, lease ResourceLease) (string, bool) {
	for _, a := range o.ResourceClaims {
		for _, b := range lease.Claims {
			if resourceClaimsConflict(a, b) {
				resource := b.Kind + ":" + b.Authority + ":" + b.Key
				if len(resource) > 512 {
					resource = resource[:512]
				}
				return resource, true
			}
		}
	}
	return "external:*", false
}

func resourceWaitSnapshot(wait *ResourceWait, endedAt string) *ResourceWait {
	if wait == nil {
		return nil
	}
	copy := *wait
	if since, err := time.Parse(time.RFC3339Nano, copy.Since); err == nil {
		until := time.Now()
		if ended, err := time.Parse(time.RFC3339Nano, endedAt); err == nil {
			until = ended
		}
		copy.ElapsedSeconds = max(0, int(until.Sub(since).Seconds()))
	}
	return &copy
}

func interruptResourceWaiter(ctx context.Context, tx *sql.Tx, s *store, r *Run, o Operation, now string) error {
	r.Status, r.EndReason, r.EndedAt = StateInterrupted, "resource-outcome-unknown", now
	r.Error = &Failure{Code: r.EndReason, Message: "此前操作结果待核实，本工具未派发，请核实后手动继续"}
	r.MemoryStatus = "stale"
	o.Error = r.Error
	o.EndedAt = now
	if err := saveOperation(ctx, tx, o); err != nil {
		return err
	}
	if err := releaseWaitingResourceLeases(ctx, tx, r.ID, now); err != nil {
		return err
	}
	if err := s.event(ctx, tx, r, "run/interrupted", "", nil, r.Error); err != nil {
		return err
	}
	return s.releaseSession(ctx, tx, r)
}
