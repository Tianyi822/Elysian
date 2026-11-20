package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

func (v *view) UnverifiedOperations(ctx context.Context, runID string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "UnverifiedOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), `SELECT o.document FROM operations o WHERE o.run_id=? AND o.state='unknown'
AND NOT EXISTS(SELECT 1 FROM execution_barriers b WHERE b.operation_id=o.id AND b.state='reconciled')`, runID)
		return err
	})
	return values, normalizeError("UnverifiedOperations", err, v.tx != nil)
}

func (v *view) ReservedResultBytes(ctx context.Context, runID string, count *int64) error {
	return normalizeError("ReservedResultBytes", v.read(ctx, "ReservedResultBytes", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, `SELECT COALESCE(SUM(COALESCE(json_extract(document,'$.reservedResultBytes'),0)),0) FROM calls WHERE run_id=?`, runID).Scan(count)
	}), v.tx != nil)
}

func (v *view) Operations(ctx context.Context, value string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "Operations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), "SELECT document FROM operations WHERE run_id=? ORDER BY rowid", value)
		return err
	})
	return values, normalizeError("Operations", err, v.tx != nil)
}

func (v *view) SessionOperations(ctx context.Context, id string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "SessionOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), "SELECT json_remove(document,'$.pendingResult') FROM operations WHERE run_id=? ORDER BY rowid", id)
		return err
	})
	return values, normalizeError("SessionOperations", err, v.tx != nil)
}

func (v *view) SessionCalls(ctx context.Context, id string) ([]Call, error) {
	var values []Call
	err := v.read(ctx, "SessionCalls", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Call](ctx, v.query(ctx), "SELECT json_remove(document,'$.result','$.args','$.argumentsJson','$.modelContent') FROM calls WHERE run_id=? ORDER BY step_index", id)
		return err
	})
	return values, normalizeError("SessionCalls", err, v.tx != nil)
}

func (v *view) ToolLoadHistory(ctx context.Context, runID string, toolDiscoverySource string, toolSearchName string, digest string) ([]sessionstore.ToolLoadRecord, error) {
	values := []sessionstore.ToolLoadRecord{}
	err := v.read(ctx, "ToolLoadHistory", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT c.document FROM calls c JOIN operations o ON o.id=json_extract(c.document,'$.operationId') WHERE c.run_id=? AND o.run_id=? AND c.state='succeeded' AND o.state='completed' AND json_extract(o.document,'$.capability.source')=? AND json_extract(o.document,'$.capability.name')=? AND json_extract(o.document,'$.snapshotDigest')=? ORDER BY c.rowid`, runID, runID, toolDiscoverySource, toolSearchName, digest)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.ToolLoadRecord
			if err := rows.Scan(&item.Document); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("ToolLoadHistory", err, v.tx != nil)
}

func (v *view) MaintenanceOperations(ctx context.Context, runID string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "MaintenanceOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), "SELECT document FROM operations WHERE run_id=? AND state IN ('dispatched','unknown','waiting-task')", runID)
		return err
	})
	return values, normalizeError("MaintenanceOperations", err, v.tx != nil)
}

func (v *view) SucceededCallCount(ctx context.Context, id string, count *int) error {
	return normalizeError("SucceededCallCount", v.read(ctx, "SucceededCallCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM calls WHERE run_id=? AND state='succeeded'", id).Scan(count)
	}), v.tx != nil)
}

func (v *view) OperationInvocation(ctx context.Context, runID string, originID string, index int, document *string) error {
	return normalizeError("OperationInvocation", v.read(ctx, "OperationInvocation", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM operations WHERE run_id=? AND model_request_id=? AND call_index=?", runID, originID, index).Scan(document)
	}), v.tx != nil)
}

func (v *view) PriorOperationAttempts(ctx context.Context, id string, taskDomain string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "PriorOperationAttempts", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), "SELECT document FROM operations WHERE id<>? AND json_extract(document,'$.capability.metadata.taskDomain')=?", id, taskDomain)
		return err
	})
	return values, normalizeError("PriorOperationAttempts", err, v.tx != nil)
}

func (v *view) OperationCalls(ctx context.Context, runID string) ([]Call, error) {
	var values []Call
	err := v.read(ctx, "OperationCalls", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Call](ctx, v.query(ctx), `SELECT c.document FROM calls c JOIN operations o ON o.id=json_extract(c.document,'$.operationId') WHERE c.run_id=? AND c.state='succeeded' AND json_extract(c.document,'$.tool')='file_read' AND json_extract(o.document,'$.capability.source')='builtin' ORDER BY c.rowid DESC LIMIT 64`, runID)
		return err
	})
	return values, normalizeError("OperationCalls", err, v.tx != nil)
}

func (v *view) OperationReceiptSettled(ctx context.Context, runID string, callID string, found *bool) error {
	return normalizeError("OperationReceiptSettled", v.read(ctx, "OperationReceiptSettled", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND json_extract(document,'$.callId')=? AND json_extract(document,'$.type')='call/finished')`, runID, callID).Scan(found)
	}), v.tx != nil)
}

func (v *view) PlanInvocation(ctx context.Context, runID string, modelRequestID string, modelCallID string, document *string) error {
	return normalizeError("PlanInvocation", v.read(ctx, "PlanInvocation", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM calls WHERE run_id=? AND json_extract(document,'$.modelRequestId')=? AND json_extract(document,'$.modelCallId')=?", runID, modelRequestID, modelCallID).Scan(document)
	}), v.tx != nil)
}

func (v *view) FailedCallExists(ctx context.Context, runID string, found *bool) error {
	return normalizeError("FailedCallExists", v.read(ctx, "FailedCallExists", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM calls WHERE run_id=? AND state='failed')", runID).Scan(found)
	}), v.tx != nil)
}

func (v *view) RecoveryCalls(ctx context.Context, runID string) ([]Call, error) {
	var values []Call
	err := v.read(ctx, "RecoveryCalls", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Call](ctx, v.query(ctx), "SELECT document FROM calls WHERE run_id=? ORDER BY step_index", runID)
		return err
	})
	return values, normalizeError("RecoveryCalls", err, v.tx != nil)
}

func (v *view) AuthorizedOperations(ctx context.Context, id string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "AuthorizedOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), "SELECT document FROM operations WHERE json_extract(document,'$.authorization.sessionAuthorizationId')=? AND (state IN ('dispatched','waiting-task') OR json_extract(document,'$.preparation.state')='pulling')", id)
		return err
	})
	return values, normalizeError("AuthorizedOperations", err, v.tx != nil)
}

func (v *view) DeniedAccessCount(ctx context.Context, runID string, scopeKey string, count *int) error {
	return normalizeError("DeniedAccessCount", v.read(ctx, "DeniedAccessCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, `SELECT COUNT(*) FROM operations WHERE run_id=? AND json_extract(document,'$.access.scopeKey')=? AND json_extract(document,'$.error.code')='access-denied'`, runID, scopeKey).Scan(count)
	}), v.tx != nil)
}

func (v *view) DispatchedOperationCount(ctx context.Context, runID string, count *int) error {
	return normalizeError("DispatchedOperationCount", v.read(ctx, "DispatchedOperationCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM operations WHERE run_id=?", runID).Scan(count)
	}), v.tx != nil)
}

func (v *view) MonitoredOperations(ctx context.Context) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "MonitoredOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), "SELECT o.document FROM operations o WHERE (o.state='waiting-task' OR (o.state='unknown' AND (json_extract(o.document,'$.task') IS NOT NULL OR json_extract(o.document,'$.recovery') IS NOT NULL))) AND NOT EXISTS (SELECT 1 FROM execution_barriers b WHERE b.operation_id=o.id AND (b.state='reconciled' OR json_extract(b.document,'$.reconciliation') IS NOT NULL)) ORDER BY o.rowid")
		return err
	})
	return values, normalizeError("MonitoredOperations", err, v.tx != nil)
}

func (v *view) ReportOperations(ctx context.Context, runID string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "ReportOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), "SELECT document FROM operations WHERE run_id=?", runID)
		return err
	})
	return values, normalizeError("ReportOperations", err, v.tx != nil)
}

func (v *view) LoadedToolHistory(ctx context.Context, runID string, toolDiscoverySource string, digest string) ([]sessionstore.LoadedToolRecord, error) {
	values := []sessionstore.LoadedToolRecord{}
	err := v.read(ctx, "LoadedToolHistory", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT c.document FROM calls c JOIN operations o ON o.id=json_extract(c.document,'$.operationId') WHERE c.run_id=? AND c.state='succeeded' AND o.state='completed' AND json_extract(o.document,'$.capability.source')=? AND json_extract(o.document,'$.snapshotDigest')=? ORDER BY c.rowid DESC`, runID, toolDiscoverySource, digest)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.LoadedToolRecord
			if err := rows.Scan(&item.Document); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("LoadedToolHistory", err, v.tx != nil)
}

func (v *view) UserInputCall(ctx context.Context, callID string, runID string, document *string) error {
	return normalizeError("UserInputCall", v.read(ctx, "UserInputCall", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM calls WHERE id=? AND run_id=?", callID, runID).Scan(document)
	}), v.tx != nil)
}
