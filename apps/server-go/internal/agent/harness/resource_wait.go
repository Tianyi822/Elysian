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
	taskControl := o.Capability.Metadata.Async && o.Capability.Metadata.Action == "cancel" && o.Capability.Metadata.TaskDomain != "" && o.Capability.Metadata.TaskIDArgument != ""
	globalFence := externalOperation(o) && !taskControl
	if globalFence {
		barriers, err := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE state='unknown' ORDER BY rowid LIMIT 1")
		if err != nil {
			return nil, err
		}
		if len(barriers) > 0 {
			wait.RunID, wait.OperationID, wait.Unknown, wait.Resource, wait.Message = barriers[0].RunID, barriers[0].OperationID, true, "external:*", "此前操作结果待核实，禁止自动重投"
			return wait, nil
		}
	}
	leases, err := readDocuments[ResourceLease](ctx, tx, "SELECT document FROM resource_leases WHERE id<>? AND (state IN ('held','unknown') OR (state='waiting' AND sequence<(SELECT sequence FROM resource_leases WHERE id=?))) ORDER BY CASE state WHEN 'unknown' THEN 0 ELSE 1 END,sequence", o.ID, o.ID)
	if err != nil {
		return nil, err
	}
	for _, lease := range leases {
		var conflicts bool
		if globalFence && lease.State == "unknown" {
			conflicts = true
		}
		for _, a := range o.ResourceClaims {
			for _, b := range lease.Claims {
				if resourceClaimsConflict(a, b) {
					conflicts = true
					wait.Resource = b.Kind + ":" + b.Authority + ":" + b.Key
					break
				}
			}
		}
		if !conflicts {
			continue
		}
		wait.RunID, wait.OperationID, wait.Unknown = lease.RunID, lease.OperationID, lease.State == "unknown"
		if wait.Resource == "" {
			wait.Resource = "external:*"
		}
		if len(wait.Resource) > 512 {
			wait.Resource = wait.Resource[:512]
		}
		if wait.Unknown {
			wait.Message = "此前操作结果待核实，禁止自动重投"
		}
		return wait, nil
	}
	return wait, nil
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
