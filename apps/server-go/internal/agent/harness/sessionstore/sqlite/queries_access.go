package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

func (v *view) UnknownBarriers(ctx context.Context) ([]ExecutionBarrier, error) {
	var values []ExecutionBarrier
	err := v.read(ctx, "UnknownBarriers", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ExecutionBarrier](ctx, v.query(ctx), "SELECT document FROM execution_barriers WHERE state='unknown'")
		return err
	})
	return values, normalizeError("UnknownBarriers", err, v.tx != nil)
}

func (v *view) Approvals(ctx context.Context, workflowID string, workflowID2 string, runID string, runID2 string) ([]Approval, error) {
	var values []Approval
	err := v.read(ctx, "Approvals", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Approval](ctx, v.query(ctx), "SELECT document FROM approvals WHERE (?='' OR run_id IN (SELECT id FROM runs WHERE workflow_id=?)) AND (?='' OR run_id=?) ORDER BY CASE WHEN state IN ('pending','approved') THEN 0 ELSE 1 END, rowid DESC LIMIT 200", workflowID, workflowID2, runID, runID2)
		return err
	})
	return values, normalizeError("Approvals", err, v.tx != nil)
}

func (v *view) Barriers(ctx context.Context, workflowID string, workflowID2 string) ([]ExecutionBarrier, error) {
	var values []ExecutionBarrier
	err := v.read(ctx, "Barriers", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ExecutionBarrier](ctx, v.query(ctx), "SELECT document FROM execution_barriers WHERE (?='' OR run_id IN (SELECT id FROM runs WHERE workflow_id=?)) ORDER BY rowid DESC LIMIT 200", workflowID, workflowID2)
		return err
	})
	return values, normalizeError("Barriers", err, v.tx != nil)
}

func (v *view) ApprovalRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("ApprovalRecord", v.read(ctx, "ApprovalRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM approvals WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) ExpiredApprovals(ctx context.Context, now string) ([]Approval, error) {
	var values []Approval
	err := v.read(ctx, "ExpiredApprovals", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Approval](ctx, v.query(ctx), "SELECT document FROM approvals WHERE state IN ('pending','approved') AND julianday(expires_at)<=julianday(?)", now)
		return err
	})
	return values, normalizeError("ExpiredApprovals", err, v.tx != nil)
}

func (v *view) SessionApprovals(ctx context.Context, id string) ([]Approval, error) {
	var values []Approval
	err := v.read(ctx, "SessionApprovals", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Approval](ctx, v.query(ctx), "SELECT json_remove(document,'$.operation') FROM approvals WHERE run_id=? ORDER BY rowid", id)
		return err
	})
	return values, normalizeError("SessionApprovals", err, v.tx != nil)
}

func (v *view) ExtensionRevoked(ctx context.Context, kind string, id string, revision int, count *int) error {
	return normalizeError("ExtensionRevoked", v.read(ctx, "ExtensionRevoked", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM capability_revocations WHERE kind=? AND id=? AND (revision=0 OR revision=?)", kind, id, revision).Scan(count)
	}), v.tx != nil)
}

func (v *view) Revocations(ctx context.Context, cursor int64, kind string, id string, limit int) ([]sessionstore.RevocationRecord, error) {
	values := []sessionstore.RevocationRecord{}
	err := v.read(ctx, "Revocations", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT rowid,kind,id,revision,reason,created_at
		FROM capability_revocations WHERE rowid>? AND (?='' OR kind=?) AND (?='' OR id=?)
		ORDER BY rowid LIMIT ?`, cursor, kind, kind, id, id, limit)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.RevocationRecord
			if err := rows.Scan(&item.Sequence, &item.Kind, &item.ID, &item.Revision, &item.Reason, &item.CreatedAt); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("Revocations", err, v.tx != nil)
}

func (v *transaction) RevokeCapability(ctx context.Context, kind string, id string, revision int, reason string, now string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO capability_revocations(kind,id,revision,reason,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING", kind, id, revision, reason, now)
	if err != nil {
		return 0, normalizeError("RevokeCapability", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("RevokeCapability", err, true)
}

func (v *view) ExecutionRevocations(ctx context.Context) ([]sessionstore.ExecutionRevocationRecord, error) {
	values := []sessionstore.ExecutionRevocationRecord{}
	err := v.read(ctx, "ExecutionRevocations", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT kind,id,revision FROM capability_revocations WHERE kind IN ('grant','mcp')")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.ExecutionRevocationRecord
			if err := rows.Scan(&item.Kind, &item.ID, &item.Revision); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("ExecutionRevocations", err, v.tx != nil)
}

func (v *view) PendingApprovalCount(ctx context.Context, count *int) error {
	return normalizeError("PendingApprovalCount", v.read(ctx, "PendingApprovalCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals WHERE state='pending'").Scan(count)
	}), v.tx != nil)
}

func (v *view) SessionAuthorizations(ctx context.Context, sessionID string) ([]SessionAuthorization, error) {
	var values []SessionAuthorization
	err := v.read(ctx, "SessionAuthorizations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[SessionAuthorization](ctx, v.query(ctx), "SELECT document FROM session_authorizations WHERE session_id=? AND state='active' ORDER BY rowid DESC", sessionID)
		return err
	})
	return values, normalizeError("SessionAuthorizations", err, v.tx != nil)
}

func (v *view) MatchingAuthorizations(ctx context.Context, sessionID string, scopeKey string) ([]SessionAuthorization, error) {
	var values []SessionAuthorization
	err := v.read(ctx, "MatchingAuthorizations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[SessionAuthorization](ctx, v.query(ctx), "SELECT document FROM session_authorizations WHERE session_id=? AND scope_key=? AND state='active' ORDER BY rowid DESC LIMIT 1", sessionID, scopeKey)
		return err
	})
	return values, normalizeError("MatchingAuthorizations", err, v.tx != nil)
}

func (v *view) AuthorizationRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("AuthorizationRecord", v.read(ctx, "AuthorizationRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM session_authorizations WHERE id=? AND state='active'", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) AuthorizationExists(ctx context.Context, sessionID string, count *int) error {
	return normalizeError("AuthorizationExists", v.read(ctx, "AuthorizationExists", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM session_authorizations WHERE session_id=? AND state='active'", sessionID).Scan(count)
	}), v.tx != nil)
}

func (v *view) SessionAuthorizationRecord(ctx context.Context, id string, sessionID string, document *string) error {
	return normalizeError("SessionAuthorizationRecord", v.read(ctx, "SessionAuthorizationRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM session_authorizations WHERE id=? AND session_id=?", id, sessionID).Scan(document)
	}), v.tx != nil)
}

func (v *view) UnresolvedBarrierCount(ctx context.Context, count *int) error {
	return normalizeError("UnresolvedBarrierCount", v.read(ctx, "UnresolvedBarrierCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM execution_barriers WHERE state IN ('dispatched','unknown')").Scan(count)
	}), v.tx != nil)
}

func (v *view) NodeApprovals(ctx context.Context, runID string) ([]Approval, error) {
	var values []Approval
	err := v.read(ctx, "NodeApprovals", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Approval](ctx, v.query(ctx), "SELECT document FROM approvals WHERE run_id=? ORDER BY rowid", runID)
		return err
	})
	return values, normalizeError("NodeApprovals", err, v.tx != nil)
}

func (v *view) NodeBarriers(ctx context.Context, runID string) ([]ExecutionBarrier, error) {
	var values []ExecutionBarrier
	err := v.read(ctx, "NodeBarriers", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ExecutionBarrier](ctx, v.query(ctx), "SELECT document FROM execution_barriers WHERE run_id=?", runID)
		return err
	})
	return values, normalizeError("NodeBarriers", err, v.tx != nil)
}

func (v *view) TaskBarriers(ctx context.Context, operationID string) ([]ExecutionBarrier, error) {
	var values []ExecutionBarrier
	err := v.read(ctx, "TaskBarriers", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ExecutionBarrier](ctx, v.query(ctx), "SELECT document FROM execution_barriers WHERE operation_id=?", operationID)
		return err
	})
	return values, normalizeError("TaskBarriers", err, v.tx != nil)
}

func (v *view) PendingReconciliations(ctx context.Context) ([]ExecutionBarrier, error) {
	var values []ExecutionBarrier
	err := v.read(ctx, "PendingReconciliations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ExecutionBarrier](ctx, v.query(ctx), "SELECT document FROM execution_barriers WHERE state='unknown' AND json_extract(document,'$.reconciliation') IS NOT NULL ORDER BY rowid LIMIT 16")
		return err
	})
	return values, normalizeError("PendingReconciliations", err, v.tx != nil)
}
