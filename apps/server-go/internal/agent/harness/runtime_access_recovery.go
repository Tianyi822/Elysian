package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

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
		if r.Status != StateRunning || r.DriverVersion != "v2" || r.CancelRequestedAt != "" || r.EndedAt != "" || r.WorkflowID != "" || r.SessionID == "" || r.Snapshot == nil || r.Snapshot.AuthorizationMode != AuthorizationOnDemand || o.DispatchID != "" || o.DispatchedAt != "" || o.EndedAt != "" || o.Access == nil || o.Access.Runtime == nil || o.Execution == nil || o.Authorization == nil || o.Authorization.ID != o.ID || o.Authorization.Digest != o.Access.Digest || accessDigest(o) != o.Access.Digest || o.ModelRequestID == "" || o.CallIndex < 0 {
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
			if previous.OperationID != o.ID || previous.RunID != r.ID || previous.Status != "approved" || previous.AccessDecision == nil || !approvedOperationMatches(previous.Operation, o) {
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
		o.Access.Digest = accessDigest(o)
		o.ApprovalID = randomID()
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
