package sqlite

import (
	"context"
	"database/sql"
)

func (s *store) stopLegacyRuns(ctx context.Context, tx *sql.Tx) error {
	runs, err := readDocuments[Run](ctx, tx, `SELECT r.document FROM runs r
 JOIN context_exclusions x ON x.kind='run' AND x.id=r.id
 WHERE r.state NOT IN ('succeeded','failed','cancelled','interrupted')`)
	if err != nil {
		return err
	}
	if len(runs) > 0 {
		if err := recoverOperations(ctx, tx, s.now()); err != nil {
			return err
		}
	}
	workflows, err := readDocuments[WorkflowInstance](ctx, tx, `SELECT w.document FROM workflow_instances w
 JOIN context_exclusions x ON x.kind='workflow' AND x.id=w.id
 WHERE w.state NOT IN ('succeeded','failed','cancelled','interrupted')`)
	if err != nil {
		return err
	}
	failure := &Failure{Code: "context-retired", Message: "旧知识能力已退役，原任务已停止"}
	for i := range workflows {
		w := &workflows[i]
		w.GateClosed, w.Status, w.Error = true, StateRecoveryRequired, failure
		if err := s.workflowEvent(ctx, tx, w, "workflow/recovery-required", failure.Message); err != nil {
			return err
		}
	}
	for i := range runs {
		r := &runs[i]
		r.Status, r.Phase, r.EndReason = StateInterrupted, "completed", failure.Code
		r.Error, r.EndedAt, r.MemoryStatus = failure, stamp(s.now()), "stale"
		approvals, err := readApprovalTx(ctx, tx, r.ID)
		if err != nil {
			return err
		}
		for _, approval := range approvals {
			if approval.Status == "pending" || approval.Status == "approved" {
				approval.Status = "revoked"
				if err := saveApproval(ctx, tx, approval); err != nil {
					return err
				}
			}
		}
		if err := interruptCalls(ctx, tx, r.ID, s.now()); err != nil {
			return err
		}
		if err := s.event(ctx, tx, r, "run/interrupted", "", nil, r.Error); err != nil {
			return err
		}
		if err := s.releaseSession(ctx, tx, r); err != nil {
			return err
		}
	}
	return nil
}
