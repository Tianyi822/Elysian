package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"elysian/server/internal/agent/harness/state"
)

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
	if state.ExternalOperation(o) && !taskControl {
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
		if state.ResourceSetsConflict(lease.Claims, other.Claims) {
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
		if state.DigestJSON(lease.Claims) != state.DigestJSON(o.ResourceClaims) || lease.OperationID != o.ID || lease.RunID != o.RunID {
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

func readResourceRule(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string, revision int) (ResourceRule, error) {
	var rule ResourceRule
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM resource_rules WHERE id=? AND (?=0 OR revision=?) ORDER BY revision DESC LIMIT 1", id, revision, revision).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return rule, bad("resource-rule-not-found", "资源规则不存在")
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &rule)
	}
	return rule, err
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
		resource, conflicts := state.ResourceWaitConflict(o, lease)
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
	globalFence := state.ExternalOperation(o) && !taskControl
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
		resource, conflicts := state.ResourceWaitConflict(o, lease)
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

type ResourceWait = state.ResourceWait

// recoverRuntimePreparations recovers only the pre-dispatch image preparation
// boundary. A pull may still be running in Docker, so recovery requests a new
// human decision and retains unknown preparation: confirmation can inspect the
// approved digest, but cannot start another pull or replay a command.
func (s *store) recoverRuntimePreparations(ctx context.Context, tx *sql.Tx) error {
	operations, err := readDocuments[Operation](ctx, tx, `SELECT o.document FROM operations o JOIN runs r ON r.id=o.run_id
 WHERE r.state='running' AND json_extract(o.document,'$.preparation.state')='pulling'`)
	if err != nil {
		return err
	}
	for _, o := range operations {
		r, err := readRun(ctx, tx, o.RunID)
		if err != nil {
			return err
		}
		if r.Status != StateRunning || r.DriverVersion != "v2" || r.CancelRequestedAt != "" || r.EndedAt != "" || r.WorkflowID != "" || r.SessionID == "" || r.Snapshot == nil || r.Snapshot.AuthorizationMode != AuthorizationOnDemand || o.DispatchID != "" || o.DispatchedAt != "" || o.EndedAt != "" || o.Access == nil || o.Access.Runtime == nil || o.Execution == nil || o.Authorization == nil || o.Authorization.ID != o.ID || o.Authorization.Digest != o.Access.Digest || state.AccessDigest(o) != o.Access.Digest || o.ModelRequestID == "" || o.CallIndex < 0 {
			continue
		}
		if o.Status != StateWaitingApproval && o.Status != "planned" {
			continue
		}
		session, err := readSession(ctx, tx, r.SessionID)
		if err != nil {
			return err
		}
		if session.ActiveRunID != r.ID || session.ActiveWorkflowID != "" {
			continue
		}
		var dispatched bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM execution_barriers WHERE operation_id=?) OR
 EXISTS(SELECT 1 FROM resource_leases WHERE operation_id=? AND state IN ('held','unknown')) OR
 EXISTS(SELECT 1 FROM calls WHERE json_extract(document,'$.operationId')=?)`, o.ID, o.ID, o.ID).Scan(&dispatched); err != nil {
			return err
		}
		if dispatched {
			continue
		}
		if o.ApprovalID != "" {
			var raw string
			if err := tx.QueryRowContext(ctx, "SELECT document FROM approvals WHERE id=?", o.ApprovalID).Scan(&raw); err != nil {
				return err
			}
			var previous Approval
			if err := json.Unmarshal([]byte(raw), &previous); err != nil {
				return err
			}
			if previous.OperationID != o.ID || previous.RunID != r.ID || previous.Status != "approved" || previous.AccessDecision == nil || !state.ApprovedOperationMatches(previous.Operation, o) {
				continue
			}
			previous.Status = "revoked"
			if err := saveApproval(ctx, tx, previous); err != nil {
				return err
			}
		}
		preparation := *o.Preparation
		preparation.State = "unknown"
		preparation.Error = "面板重启中断了运行环境准备，下载结果未确认"
		o.Preparation = &preparation
		o.Authorization = nil
		o.Access.Revision++
		o.Access.Reason = preparation.Error + "；再次确认仅核实本机镜像，未确认前不会重新下载或执行。"
		o.Access.Digest = state.AccessDigest(o)
		o.ApprovalID = state.RandomID()
		o.Status, o.Policy, o.DecisionSource = StateWaitingApproval, "approval-required", "human-approval"
		approval := Approval{ID: o.ApprovalID, Kind: "operation", OperationID: o.ID, RunID: r.ID, Status: "pending", CreatedAt: stamp(s.now()), ExpiresAt: stamp(s.now().Add(24 * time.Hour)), Access: o.Access, Operation: o}
		if err := saveOperation(ctx, tx, o); err != nil {
			return err
		}
		if err := saveApproval(ctx, tx, approval); err != nil {
			return err
		}
		r.Status, r.Phase = StateWaitingApproval, StateWaitingApproval
		r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: o.CallIndex}
		if err := s.event(ctx, tx, &r, "runtime/recovery-required", "", nil, map[string]string{"operationId": o.ID, "approvalId": o.ApprovalID}); err != nil {
			return err
		}
	}
	return nil
}
