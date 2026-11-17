package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/tools"
)

func (v *view) ModelRequest(ctx context.Context, responseID string, runID string, document *string) error {
	return normalizeError("ModelRequest", v.read(ctx, "ModelRequest", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM model_requests WHERE id=? AND run_id=?", responseID, runID).Scan(document)
	}), v.tx != nil)
}

func (v *transaction) InsertAttachment(ctx context.Context, id string, mimeType string, bytes int, width int, height int, name string, now string, content []byte) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO agent_attachments(id,session_id,mime_type,bytes,width,height,name,created_at,content) VALUES(?,NULL,?,?,?,?,?,?,?)", id, mimeType, bytes, width, height, name, now, content)
	if err != nil {
		return 0, normalizeError("InsertAttachment", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertAttachment", err, true)
}

func (v *view) AttachmentContent(ctx context.Context, id string, mimeType *string, content *[]byte) error {
	return normalizeError("AttachmentContent", v.read(ctx, "AttachmentContent", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT mime_type,content FROM agent_attachments WHERE id=?", id).Scan(mimeType, content)
	}), v.tx != nil)
}

func (v *transaction) RemoveUnboundAttachment(ctx context.Context, id string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "DELETE FROM agent_attachments WHERE id=? AND session_id IS NULL", id)
	if err != nil {
		return 0, normalizeError("RemoveUnboundAttachment", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("RemoveUnboundAttachment", err, true)
}

func (v *view) AttachmentOwner(ctx context.Context, id string, document *string) error {
	return normalizeError("AttachmentOwner", v.read(ctx, "AttachmentOwner", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT session_id FROM agent_attachments WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) ResourceBlockedOperations(ctx context.Context, runID string) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "ResourceBlockedOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), `SELECT document FROM operations WHERE run_id=? AND json_extract(document,'$.resourceWait.unknown')=1`, runID)
		return err
	})
	return values, normalizeError("ResourceBlockedOperations", err, v.tx != nil)
}

func (v *view) UnknownBarriers(ctx context.Context) ([]ExecutionBarrier, error) {
	var values []ExecutionBarrier
	err := v.read(ctx, "UnknownBarriers", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ExecutionBarrier](ctx, v.query(ctx), "SELECT document FROM execution_barriers WHERE state='unknown'")
		return err
	})
	return values, normalizeError("UnknownBarriers", err, v.tx != nil)
}

func (v *view) UnknownResourceLeases(ctx context.Context) ([]ResourceLease, error) {
	var values []ResourceLease
	err := v.read(ctx, "UnknownResourceLeases", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceLease](ctx, v.query(ctx), "SELECT document FROM resource_leases WHERE state='unknown'")
		return err
	})
	return values, normalizeError("UnknownResourceLeases", err, v.tx != nil)
}

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

func (v *view) EnvironmentSnapshot(ctx context.Context, id string, document *string) error {
	return normalizeError("EnvironmentSnapshot", v.read(ctx, "EnvironmentSnapshot", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM environments WHERE session_id=? ORDER BY revision DESC LIMIT 1", id).Scan(document)
	}), v.tx != nil)
}

func (v *transaction) InsertEnvironment(ctx context.Context, id string, revision int, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO environments(session_id,revision,document) VALUES(?,?,?)", id, revision, document)
	if err != nil {
		return 0, normalizeError("InsertEnvironment", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertEnvironment", err, true)
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

func (v *view) ContextItems(ctx context.Context, value string) ([]ContextItem, error) {
	var values []ContextItem
	err := v.read(ctx, "ContextItems", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ContextItem](ctx, v.query(ctx), "SELECT document FROM context_items WHERE run_id=? ORDER BY rowid", value)
		return err
	})
	return values, normalizeError("ContextItems", err, v.tx != nil)
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

func (v *view) QueuedRunCount(ctx context.Context, count *int) error {
	return normalizeError("QueuedRunCount", v.read(ctx, "QueuedRunCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(count)
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

func (v *view) SessionModelRequests(ctx context.Context, id string) ([]ModelRequestRecord, error) {
	var values []ModelRequestRecord
	err := v.read(ctx, "SessionModelRequests", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ModelRequestRecord](ctx, v.query(ctx), "SELECT document FROM model_requests WHERE run_id=? ORDER BY request_index", id)
		return err
	})
	return values, normalizeError("SessionModelRequests", err, v.tx != nil)
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

func (v *view) SessionApprovals(ctx context.Context, id string) ([]Approval, error) {
	var values []Approval
	err := v.read(ctx, "SessionApprovals", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Approval](ctx, v.query(ctx), "SELECT json_remove(document,'$.operation') FROM approvals WHERE run_id=? ORDER BY rowid", id)
		return err
	})
	return values, normalizeError("SessionApprovals", err, v.tx != nil)
}

func (v *view) SessionUserInputs(ctx context.Context, id string) ([]UserInputRequest, error) {
	var values []UserInputRequest
	err := v.read(ctx, "SessionUserInputs", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[UserInputRequest](ctx, v.query(ctx), "SELECT document FROM user_inputs WHERE run_id=? ORDER BY rowid", id)
		return err
	})
	return values, normalizeError("SessionUserInputs", err, v.tx != nil)
}

func (v *view) AttachmentMetadata(ctx context.Context, ids []string) ([]sessionstore.AttachmentMetadataRecord, error) {
	placeholders, args := attachmentPlaceholders(ids)
	values := []sessionstore.AttachmentMetadataRecord{}
	err := v.read(ctx, "AttachmentMetadata", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT id,mime_type,bytes FROM agent_attachments WHERE id IN ("+placeholders+")", args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.AttachmentMetadataRecord
			if err := rows.Scan(&item.ID, &item.MimeType, &item.Bytes); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("AttachmentMetadata", err, v.tx != nil)
}

func (v *view) AttachmentBytes(ctx context.Context, ids []string) ([]sessionstore.AttachmentBytesRecord, error) {
	placeholders, args := attachmentPlaceholders(ids)
	values := []sessionstore.AttachmentBytesRecord{}
	err := v.read(ctx, "AttachmentBytes", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT id,content FROM agent_attachments WHERE id IN ("+placeholders+")", args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.AttachmentBytesRecord
			if err := rows.Scan(&item.ID, &item.Content); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("AttachmentBytes", err, v.tx != nil)
}

func (v *view) ContextRuns(ctx context.Context, taskID string, runNumber int, runNumber2 int) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "ContextRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT document FROM runs WHERE task_id=? AND run_number>=? AND run_number<=? ORDER BY run_number", taskID, runNumber, runNumber2)
		return err
	})
	return values, normalizeError("ContextRuns", err, v.tx != nil)
}

func (v *view) ContextModelRequests(ctx context.Context, runID string, coverage int64) ([]ModelRequestRecord, error) {
	var values []ModelRequestRecord
	err := v.read(ctx, "ContextModelRequests", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ModelRequestRecord](ctx, v.query(ctx), "SELECT document FROM model_requests WHERE run_id=? AND CAST(COALESCE(json_extract(document,'$.eventSeq'),0) AS INTEGER)>? ORDER BY request_index", runID, coverage)
		return err
	})
	return values, normalizeError("ContextModelRequests", err, v.tx != nil)
}

func (v *view) ContextCalls(ctx context.Context, runID string, coverage int64) ([]Call, error) {
	var values []Call
	err := v.read(ctx, "ContextCalls", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Call](ctx, v.query(ctx), `SELECT document FROM calls WHERE run_id=? AND (?=0 OR json_extract(document,'$.modelRequestId') IN (SELECT id FROM model_requests WHERE run_id=? AND CAST(COALESCE(json_extract(document,'$.eventSeq'),0) AS INTEGER)>?)
 OR id IN (SELECT json_extract(document,'$.callId') FROM run_events WHERE run_id=? AND seq>? AND json_extract(document,'$.type')='recovery/recovered')) ORDER BY step_index`, runID, coverage, runID, coverage, runID, coverage)
		return err
	})
	return values, normalizeError("ContextCalls", err, v.tx != nil)
}

func (v *view) ContextOperations(ctx context.Context, runID string, coverage int64) ([]Operation, error) {
	var values []Operation
	err := v.read(ctx, "ContextOperations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Operation](ctx, v.query(ctx), `SELECT json_remove(document,'$.pendingResult') FROM operations WHERE run_id=? AND (?=0 OR json_extract(document,'$.modelRequestId') IN (SELECT id FROM model_requests WHERE run_id=? AND CAST(COALESCE(json_extract(document,'$.eventSeq'),0) AS INTEGER)>?)
 OR json_extract(document,'$.callId') IN (SELECT json_extract(document,'$.callId') FROM run_events WHERE run_id=? AND seq>? AND json_extract(document,'$.type')='recovery/recovered')) ORDER BY rowid`, runID, coverage, runID, coverage, runID, coverage)
		return err
	})
	return values, normalizeError("ContextOperations", err, v.tx != nil)
}

func (v *view) ContextEvents(ctx context.Context, runID string, coverage int64) ([]Event, error) {
	var values []Event
	err := v.read(ctx, "ContextEvents", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Event](ctx, v.query(ctx), "SELECT document FROM run_events WHERE run_id=? AND seq>? ORDER BY seq", runID, coverage)
		return err
	})
	return values, normalizeError("ContextEvents", err, v.tx != nil)
}

func (v *view) ContextMessages(ctx context.Context, sessionID string, taskID string, historySeq string) ([]Message, error) {
	var values []Message
	err := v.read(ctx, "ContextMessages", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Message](ctx, v.query(ctx), "SELECT m.document FROM messages m JOIN runs r ON r.id=m.run_id WHERE m.session_id=? AND m.task_id<>? AND m.seq<=? AND "+visibleRunSQL+" ORDER BY m.seq DESC LIMIT 64", sessionID, taskID, historySeq)
		return err
	})
	return values, normalizeError("ContextMessages", err, v.tx != nil)
}

func (v *view) LoadedInstructions(ctx context.Context, taskID string, runNumber int) ([]ContextItem, error) {
	var values []ContextItem
	err := v.read(ctx, "LoadedInstructions", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ContextItem](ctx, v.query(ctx), "SELECT context_items.document FROM context_items JOIN runs ON context_items.run_id=runs.id WHERE context_items.task_id=? AND runs.run_number<=? ORDER BY context_items.rowid", taskID, runNumber)
		return err
	})
	return values, normalizeError("LoadedInstructions", err, v.tx != nil)
}

func (v *view) LatestInstructionResult(ctx context.Context, id string, document *string) error {
	return normalizeError("LatestInstructionResult", v.read(ctx, "LatestInstructionResult", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM calls WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) ContinuousWaiters(ctx context.Context) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "ContinuousWaiters", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT document FROM runs WHERE state IN ('waiting-model','waiting-storage') ORDER BY created_at LIMIT 64")
		return err
	})
	return values, normalizeError("ContinuousWaiters", err, v.tx != nil)
}

func (v *transaction) FinishEmbeddingRequest(ctx context.Context, now string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "DELETE FROM wiki_embedding_requests WHERE state<>'running' AND julianday(json_extract(document,'$.endedAt'))<julianday(?)", now)
	if err != nil {
		return 0, normalizeError("FinishEmbeddingRequest", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("FinishEmbeddingRequest", err, true)
}

func (v *view) PendingEmbeddingRequests(ctx context.Context) ([]EmbeddingRequest, error) {
	var values []EmbeddingRequest
	err := v.read(ctx, "PendingEmbeddingRequests", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[EmbeddingRequest](ctx, v.query(ctx), "SELECT document FROM wiki_embedding_requests WHERE state='running'")
		return err
	})
	return values, normalizeError("PendingEmbeddingRequests", err, v.tx != nil)
}

func (v *view) ExtensionRevoked(ctx context.Context, kind string, id string, revision int, count *int) error {
	return normalizeError("ExtensionRevoked", v.read(ctx, "ExtensionRevoked", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM capability_revocations WHERE kind=? AND id=? AND (revision=0 OR revision=?)", kind, id, revision).Scan(count)
	}), v.tx != nil)
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

func (v *view) MaintenanceRuns(ctx context.Context) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "MaintenanceRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT document FROM runs WHERE session_id<>'' AND workflow_id='' AND state IN ('queued','running','waiting-input','waiting-approval','waiting-resource','waiting-task','waiting-recovery','waiting-model','waiting-storage','recovery-required')")
		return err
	})
	return values, normalizeError("MaintenanceRuns", err, v.tx != nil)
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

func (v *view) TaskSnapshot(ctx context.Context, taskID string, document *string) error {
	return normalizeError("TaskSnapshot", v.read(ctx, "TaskSnapshot", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM tasks WHERE id=?", taskID).Scan(document)
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

func (v *view) ModelRequestCount(ctx context.Context, runID string, count *int) error {
	return normalizeError("ModelRequestCount", v.read(ctx, "ModelRequestCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM model_requests WHERE run_id=? AND request_index=-1", runID).Scan(count)
	}), v.tx != nil)
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

func (v *view) PendingToolCorrections(ctx context.Context, runID string) ([]ModelRequestRecord, error) {
	var values []ModelRequestRecord
	err := v.read(ctx, "PendingToolCorrections", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ModelRequestRecord](ctx, v.query(ctx), "SELECT json_remove(document,'$.response','$.reasoning','$.content') FROM model_requests WHERE run_id=? AND json_extract(document,'$.purpose')='inference' ORDER BY request_index DESC LIMIT 1", runID)
		return err
	})
	return values, normalizeError("PendingToolCorrections", err, v.tx != nil)
}

func (v *view) CorrectionCount(ctx context.Context, runID string, code string, match bool, correctionKey string, document string, count *int) error {
	return normalizeError("CorrectionCount", v.read(ctx, "CorrectionCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, `SELECT COUNT(*) FROM model_requests WHERE run_id=?
 AND json_extract(document,'$.purpose')='inference' AND json_extract(document,'$.error.code')=?
 AND (?=0 OR (COALESCE(json_extract(document,'$.correctionKey'),'')=? AND COALESCE(json_extract(document,'$.toolNames'),'null')=?))`, runID, code, match, correctionKey, document).Scan(count)
	}), v.tx != nil)
}

func (v *view) FailureSummaryExists(ctx context.Context, runID string, found *bool) error {
	return normalizeError("FailureSummaryExists", v.read(ctx, "FailureSummaryExists", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM model_requests WHERE run_id=? AND json_extract(document,'$.purpose')='failure-summary')", runID).Scan(found)
	}), v.tx != nil)
}

func (v *view) OperationInvocation(ctx context.Context, runID string, originID string, index int, document *string) error {
	return normalizeError("OperationInvocation", v.read(ctx, "OperationInvocation", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM operations WHERE run_id=? AND model_request_id=? AND call_index=?", runID, originID, index).Scan(document)
	}), v.tx != nil)
}

func (v *view) OperationContext(ctx context.Context, taskID string) ([]ContextItem, error) {
	var values []ContextItem
	err := v.read(ctx, "OperationContext", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ContextItem](ctx, v.query(ctx), "SELECT document FROM context_items WHERE task_id=?", taskID)
		return err
	})
	return values, normalizeError("OperationContext", err, v.tx != nil)
}

func (v *view) PendingApprovalCount(ctx context.Context, count *int) error {
	return normalizeError("PendingApprovalCount", v.read(ctx, "PendingApprovalCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals WHERE state='pending'").Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertOperationArtifact(ctx context.Context, key string, taskID string, runID string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT OR IGNORE INTO wiki_artifacts(kind,id,task_id,run_id) VALUES('workspace',?,?,?)", key, taskID, runID)
	if err != nil {
		return 0, normalizeError("InsertOperationArtifact", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertOperationArtifact", err, true)
}

func (v *transaction) InsertOperationDependency(ctx context.Context, key string, pageID string, revision int, digest string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT OR IGNORE INTO wiki_dependencies(kind,id,page_id,revision,digest) VALUES('workspace',?,?,?,?)", key, pageID, revision, digest)
	if err != nil {
		return 0, normalizeError("InsertOperationDependency", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertOperationDependency", err, true)
}

func (v *transaction) InvalidateOperationArtifact(ctx context.Context, key string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "UPDATE wiki_artifacts SET invalidated=1 WHERE kind='workspace' AND id=?", key)
	if err != nil {
		return 0, normalizeError("InvalidateOperationArtifact", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InvalidateOperationArtifact", err, true)
}

func (v *transaction) InsertContextItem(ctx context.Context, id string, runID string, taskID string, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO context_items(id,run_id,task_id,document) VALUES(?,?,?,?)", id, runID, taskID, document)
	if err != nil {
		return 0, normalizeError("InsertContextItem", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertContextItem", err, true)
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

func (v *view) PendingProbeLeases(ctx context.Context) ([]ResourceLease, error) {
	var values []ResourceLease
	err := v.read(ctx, "PendingProbeLeases", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceLease](ctx, v.query(ctx), "SELECT document FROM resource_leases WHERE run_id='' AND operation_id=''")
		return err
	})
	return values, normalizeError("PendingProbeLeases", err, v.tx != nil)
}

func (v *view) ProbeLeaseRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("ProbeLeaseRecord", v.read(ctx, "ProbeLeaseRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM resource_leases WHERE id=?", id).Scan(document)
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

func (v *view) ResourceRules(ctx context.Context) ([]ResourceRule, error) {
	var values []ResourceRule
	err := v.read(ctx, "ResourceRules", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceRule](ctx, v.query(ctx), "SELECT r.document FROM resource_rules r JOIN (SELECT id,MAX(revision) AS revision FROM resource_rules GROUP BY id) latest ON r.id=latest.id AND r.revision=latest.revision ORDER BY r.id")
		return err
	})
	return values, normalizeError("ResourceRules", err, v.tx != nil)
}

func (v *view) ResourceRuleRevision(ctx context.Context, id string, count *int) error {
	return normalizeError("ResourceRuleRevision", v.read(ctx, "ResourceRuleRevision", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COALESCE(MAX(revision),0) FROM resource_rules WHERE id=?", id).Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertResourceRule(ctx context.Context, id string, revision int, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO resource_rules(id,revision,document) VALUES(?,?,?)", id, revision, document)
	if err != nil {
		return 0, normalizeError("InsertResourceRule", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertResourceRule", err, true)
}

func (v *view) WaitingResourceLeases(ctx context.Context) ([]ResourceLease, error) {
	var values []ResourceLease
	err := v.read(ctx, "WaitingResourceLeases", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceLease](ctx, v.query(ctx), "SELECT document FROM resource_leases WHERE state='waiting' ORDER BY sequence")
		return err
	})
	return values, normalizeError("WaitingResourceLeases", err, v.tx != nil)
}

func (v *view) ResourceLeases(ctx context.Context) ([]ResourceLease, error) {
	var values []ResourceLease
	err := v.read(ctx, "ResourceLeases", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ResourceLease](ctx, v.query(ctx), "SELECT document FROM resource_leases ORDER BY CASE WHEN state IN ('waiting','held','unknown') THEN 0 ELSE 1 END,sequence DESC LIMIT 200")
		return err
	})
	return values, normalizeError("ResourceLeases", err, v.tx != nil)
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

func (v *view) WorkflowApprovals(ctx context.Context, workflowID string) ([]Approval, error) {
	var values []Approval
	err := v.read(ctx, "WorkflowApprovals", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Approval](ctx, v.query(ctx), "SELECT a.document FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.workflow_id=? AND a.state IN ('pending','approved')", workflowID)
		return err
	})
	return values, normalizeError("WorkflowApprovals", err, v.tx != nil)
}

func (v *view) WorkflowActiveNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "WorkflowActiveNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state NOT IN ('succeeded','cancelled','skipped')", workflowID)
		return err
	})
	return values, normalizeError("WorkflowActiveNodes", err, v.tx != nil)
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

func (v *view) DispatchedOperationCount(ctx context.Context, runID string, count *int) error {
	return normalizeError("DispatchedOperationCount", v.read(ctx, "DispatchedOperationCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM operations WHERE run_id=?", runID).Scan(count)
	}), v.tx != nil)
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

func (v *view) ActiveWorkflowApprovalCount(ctx context.Context, runID string, count *int) error {
	return normalizeError("ActiveWorkflowApprovalCount", v.read(ctx, "ActiveWorkflowApprovalCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT (SELECT COUNT(*) FROM approvals WHERE run_id=?)+(SELECT COUNT(*) FROM operations WHERE run_id=?)", runID, runID).Scan(count)
	}), v.tx != nil)
}

func (v *view) RecoverableWorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "RecoverableWorkflowNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state='recovery-required' ORDER BY rowid", workflowID)
		return err
	})
	return values, normalizeError("RecoverableWorkflowNodes", err, v.tx != nil)
}

func (v *transaction) InsertWorkflowRecovery(ctx context.Context, workflowID string, requestID string, canonical string, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO workflow_recoveries(workflow_id,request_id,canonical_input,document) VALUES(?,?,?,?)", workflowID, requestID, canonical, document)
	if err != nil {
		return 0, normalizeError("InsertWorkflowRecovery", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWorkflowRecovery", err, true)
}

func (v *view) UnsettledWorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "UnsettledWorkflowNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state IN ('ready','queued','running','waiting-approval','waiting-resource','waiting-task') ORDER BY rowid", workflowID)
		return err
	})
	return values, normalizeError("UnsettledWorkflowNodes", err, v.tx != nil)
}

func (v *view) WorkflowScopes(ctx context.Context, workflowID string) ([]WorkflowScope, error) {
	var values []WorkflowScope
	err := v.read(ctx, "WorkflowScopes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowScope](ctx, v.query(ctx), "SELECT document FROM workflow_scopes WHERE workflow_id=? ORDER BY rowid", workflowID)
		return err
	})
	return values, normalizeError("WorkflowScopes", err, v.tx != nil)
}

func (v *view) WorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "WorkflowNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), "SELECT document FROM workflow_nodes WHERE workflow_id=? ORDER BY rowid", workflowID)
		return err
	})
	return values, normalizeError("WorkflowNodes", err, v.tx != nil)
}

func (v *view) WorkflowScopeNodes(ctx context.Context, scopeID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "WorkflowScopeNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), "SELECT document FROM workflow_nodes WHERE scope_id=? AND state='succeeded' ORDER BY rowid", scopeID)
		return err
	})
	return values, normalizeError("WorkflowScopeNodes", err, v.tx != nil)
}

func (v *view) SchedulableWorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "SchedulableWorkflowNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state IN ('ready','running') ORDER BY rowid", workflowID)
		return err
	})
	return values, normalizeError("SchedulableWorkflowNodes", err, v.tx != nil)
}

func (v *transaction) WakeWorkflowRuns(ctx context.Context) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "SAVEPOINT workflow_node_transition")
	if err != nil {
		return 0, normalizeError("WakeWorkflowRuns", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("WakeWorkflowRuns", err, true)
}

func (v *transaction) WakeWorkflowApprovals(ctx context.Context) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "ROLLBACK TO workflow_node_transition")
	if err != nil {
		return 0, normalizeError("WakeWorkflowApprovals", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("WakeWorkflowApprovals", err, true)
}

func (v *transaction) WakeWorkflowOperations(ctx context.Context) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "RELEASE workflow_node_transition")
	if err != nil {
		return 0, normalizeError("WakeWorkflowOperations", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("WakeWorkflowOperations", err, true)
}

func (v *view) JoiningWorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "JoiningWorkflowNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state='ready' ORDER BY rowid", workflowID)
		return err
	})
	return values, normalizeError("JoiningWorkflowNodes", err, v.tx != nil)
}

func (v *transaction) WakeWorkflowCalls(ctx context.Context) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "SAVEPOINT workflow_leaf_transition")
	if err != nil {
		return 0, normalizeError("WakeWorkflowCalls", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("WakeWorkflowCalls", err, true)
}

func (v *transaction) WakeWorkflowNodes(ctx context.Context) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "ROLLBACK TO workflow_leaf_transition")
	if err != nil {
		return 0, normalizeError("WakeWorkflowNodes", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("WakeWorkflowNodes", err, true)
}

func (v *transaction) WakeWorkflowAttempts(ctx context.Context) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "RELEASE workflow_leaf_transition")
	if err != nil {
		return 0, normalizeError("WakeWorkflowAttempts", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("WakeWorkflowAttempts", err, true)
}

func (v *view) WorkflowNodeCount(ctx context.Context, workflowID string, count *int) error {
	return normalizeError("WorkflowNodeCount", v.read(ctx, "WorkflowNodeCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_nodes WHERE workflow_id=?", workflowID).Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertWorkflowTask(ctx context.Context, taskID string, requestID string, canonical string, document string, sessionID string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO tasks(id,request_id,input,document,session_id) VALUES(?,?,?,?,?)", taskID, requestID, canonical, document, sessionID)
	if err != nil {
		return 0, normalizeError("InsertWorkflowTask", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWorkflowTask", err, true)
}

func (v *view) WorkflowRunCount(ctx context.Context, taskID string, count *int) error {
	return normalizeError("WorkflowRunCount", v.read(ctx, "WorkflowRunCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COALESCE(MAX(run_number),0)+1 FROM runs WHERE task_id=?", taskID).Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertWorkflowRun(ctx context.Context, runID string, taskID string, status string, createdAt string, document string, sessionID string, requestID string, input string, number int, workflowID string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, `INSERT INTO runs(id,task_id,state,created_at,document,session_id,request_id,canonical_input,run_number,workflow_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, runID, taskID, status, createdAt, document, sessionID, requestID, input, number, workflowID)
	if err != nil {
		return 0, normalizeError("InsertWorkflowRun", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWorkflowRun", err, true)
}

func (v *view) ChildWorkflowScopes(ctx context.Context, nodeID string) ([]WorkflowScope, error) {
	var values []WorkflowScope
	err := v.read(ctx, "ChildWorkflowScopes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowScope](ctx, v.query(ctx), "SELECT document FROM workflow_scopes WHERE parent_node_id=? ORDER BY ordinal", nodeID)
		return err
	})
	return values, normalizeError("ChildWorkflowScopes", err, v.tx != nil)
}

func (v *view) PriorWorkflowRuns(ctx context.Context, workflowID string, activeRunID string) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "PriorWorkflowRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT r.document FROM runs r WHERE r.workflow_id=? AND (r.id=? OR r.id IN (SELECT run_id FROM workflow_attempts WHERE workflow_id=? AND state='succeeded'))", workflowID, activeRunID, workflowID)
		return err
	})
	return values, normalizeError("PriorWorkflowRuns", err, v.tx != nil)
}

func (v *view) WikiDependentWorkflows(ctx context.Context, pageID string) ([]WorkflowInstance, error) {
	var values []WorkflowInstance
	err := v.read(ctx, "WikiDependentWorkflows", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowInstance](ctx, v.query(ctx), `SELECT DISTINCT w.document FROM workflow_instances w JOIN tasks t ON t.session_id=w.session_id JOIN wiki_artifacts a ON a.task_id=t.id JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE d.page_id=? AND a.invalidated=1 AND json_extract(w.document,'$.languageVersion')='workflow/v2' AND w.state NOT IN ('succeeded','failed','cancelled')`, pageID)
		return err
	})
	return values, normalizeError("WikiDependentWorkflows", err, v.tx != nil)
}

func (v *view) WikiDependentNodes(ctx context.Context, workflowID string, pageID string) ([]WorkflowNodeExecution, error) {
	var values []WorkflowNodeExecution
	err := v.read(ctx, "WikiDependentNodes", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowNodeExecution](ctx, v.query(ctx), `SELECT n.document FROM workflow_nodes n WHERE n.workflow_id=? AND n.state IN ('ready','queued','running','waiting-approval','waiting-resource','waiting-task') AND json_extract(n.document,'$.taskId') IN (SELECT a.task_id FROM wiki_artifacts a JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE d.page_id=? AND a.invalidated=1) ORDER BY n.rowid`, workflowID, pageID)
		return err
	})
	return values, normalizeError("WikiDependentNodes", err, v.tx != nil)
}

func (v *view) PendingTaskCancellations(ctx context.Context, now string) ([]tools.TaskReference, error) {
	var values []tools.TaskReference
	err := v.read(ctx, "PendingTaskCancellations", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[tools.TaskReference](ctx, v.query(ctx), "SELECT document FROM session_task_cleanup WHERE retry_at<=? ORDER BY retry_at,id LIMIT 32", now)
		return err
	})
	return values, normalizeError("PendingTaskCancellations", err, v.tx != nil)
}

func (v *transaction) RecordTaskCancellationFailure(ctx context.Context, now string, value string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "UPDATE session_task_cleanup SET retry_at=? WHERE id=?", now, value)
	if err != nil {
		return 0, normalizeError("RecordTaskCancellationFailure", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("RecordTaskCancellationFailure", err, true)
}

func (v *transaction) RemoveTaskCancellation(ctx context.Context, value string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "DELETE FROM session_task_cleanup WHERE id=?", value)
	if err != nil {
		return 0, normalizeError("RemoveTaskCancellation", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("RemoveTaskCancellation", err, true)
}

func (v *view) SessionRuns(ctx context.Context, id string) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "SessionRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT document FROM runs WHERE session_id=?", id)
		return err
	})
	return values, normalizeError("SessionRuns", err, v.tx != nil)
}

func (v *view) SkillLoadHistory(ctx context.Context, taskID string, runNumber int, replacement string) ([]sessionstore.SkillLoadRecord, error) {
	values := []sessionstore.SkillLoadRecord{}
	err := v.read(ctx, "SkillLoadHistory", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT ci.document,c.document FROM context_items ci JOIN runs r ON r.id=ci.run_id JOIN calls c ON c.id=json_extract(ci.document,'$.callId') WHERE ci.task_id=? AND (?=0 OR r.run_number<=?) AND `+visibleRunSQL+` AND r.id NOT IN (SELECT run_id FROM messages WHERE id=? AND role='user') AND c.state='succeeded' ORDER BY ci.rowid`, taskID, runNumber, runNumber, replacement)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.SkillLoadRecord
			if err := rows.Scan(&item.Context, &item.Call); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("SkillLoadHistory", err, v.tx != nil)
}

func (v *view) TaskHistory(ctx context.Context, taskID string, cursor int64, runID string, seq int64, keyword string) ([]sessionstore.TaskHistoryRecord, error) {
	values := []sessionstore.TaskHistoryRecord{}
	err := v.read(ctx, "TaskHistory", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT e.rowid,e.document,
 COALESCE(json_object('tool',json_extract(c.document,'$.tool'),'status',c.state,'result',json_extract(c.document,'$.result'),'error',json_extract(c.document,'$.error'),'originalModelContent',json_extract(c.document,'$.modelContent')),'null'),
 COALESCE(json_object('purpose',json_extract(m.document,'$.purpose'),'response',json_remove(json_extract(m.document,'$.response'),'$.reasoning'),'error',json_extract(m.document,'$.error')),'null')
 FROM run_events e JOIN runs r ON r.id=e.run_id
 LEFT JOIN calls c ON c.run_id=e.run_id AND c.id=json_extract(e.document,'$.callId')
 LEFT JOIN model_requests m ON m.run_id=e.run_id AND m.id=json_extract(e.document,'$.data.modelRequestId')
 WHERE r.task_id=? AND COALESCE(json_extract(r.document,'$.supersededByRunId'),'')='' AND e.rowid>?
 AND (?='' OR (e.run_id=? AND e.seq=?)) AND (?='' OR instr(e.document,?)>0 OR instr(c.document,?)>0 OR instr(m.document,?)>0)
 ORDER BY e.rowid LIMIT 21`, taskID, cursor, runID, runID, seq, keyword, keyword, keyword, keyword)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.TaskHistoryRecord
			if err := rows.Scan(&item.Sequence, &item.Event, &item.Call, &item.ModelRequest); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("TaskHistory", err, v.tx != nil)
}

func (v *view) TaskHistoryInvocationExists(ctx context.Context, runID string, modelRequestID string, modelCallID string, found *bool) error {
	return normalizeError("TaskHistoryInvocationExists", v.read(ctx, "TaskHistoryInvocationExists", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM calls WHERE run_id=? AND json_extract(document,'$.modelRequestId')=? AND json_extract(document,'$.modelCallId')=?)", runID, modelRequestID, modelCallID).Scan(found)
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

func (v *view) UserInputRecord(ctx context.Context, inputID string, runID string, document *string) error {
	return normalizeError("UserInputRecord", v.read(ctx, "UserInputRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM user_inputs WHERE id=? AND run_id=?", inputID, runID).Scan(document)
	}), v.tx != nil)
}

func (v *view) UserInputCall(ctx context.Context, callID string, runID string, document *string) error {
	return normalizeError("UserInputCall", v.read(ctx, "UserInputCall", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM calls WHERE id=? AND run_id=?", callID, runID).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiRecallRecord(ctx context.Context, runID string, document *string) error {
	return normalizeError("WikiRecallRecord", v.read(ctx, "WikiRecallRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_recalls WHERE run_id=?", runID).Scan(document)
	}), v.tx != nil)
}

func (v *view) RunWikiSelection(ctx context.Context, runID string, document *string) error {
	return normalizeError("RunWikiSelection", v.read(ctx, "RunWikiSelection", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_run_spaces WHERE run_id=?", runID).Scan(document)
	}), v.tx != nil)
}

func (v *view) RunWikiPages(ctx context.Context, runID string) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "RunWikiPages", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), `SELECT r.document FROM wiki_visible_pages v JOIN wiki_page_revisions r ON r.page_id=v.page_id AND r.revision=v.revision WHERE v.owner_kind='run' AND v.owner_id=?`, runID)
		return err
	})
	return values, normalizeError("RunWikiPages", err, v.tx != nil)
}

func (v *transaction) SaveWikiRecall(ctx context.Context, runID string, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_recalls(run_id,document) VALUES(?,?)", runID, document)
	if err != nil {
		return 0, normalizeError("SaveWikiRecall", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("SaveWikiRecall", err, true)
}

func (v *transaction) InvalidateWikiArtifacts(ctx context.Context, pageID string, value string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, `UPDATE wiki_artifacts SET invalidated=1 WHERE (kind,id) IN (SELECT kind,id FROM wiki_dependencies WHERE page_id=?) OR (kind='page' AND id LIKE ?)`, pageID, value)
	if err != nil {
		return 0, normalizeError("InvalidateWikiArtifacts", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InvalidateWikiArtifacts", err, true)
}

func (v *view) ActiveWikiWorkflows(ctx context.Context, pageID string) ([]WorkflowInstance, error) {
	var values []WorkflowInstance
	err := v.read(ctx, "ActiveWikiWorkflows", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowInstance](ctx, v.query(ctx), `SELECT w.document FROM workflow_instances w WHERE w.state NOT IN ('succeeded','failed','cancelled') AND COALESCE(json_extract(w.document,'$.languageVersion'),'')<>'workflow/v2' AND json_extract(w.document,'$.taskId') IN (SELECT a.task_id FROM wiki_artifacts a JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE d.page_id=? AND a.invalidated=1)`, pageID)
		return err
	})
	return values, normalizeError("ActiveWikiWorkflows", err, v.tx != nil)
}

func (v *view) WikiAffectedTasks(ctx context.Context, pageID string) ([]sessionstore.WikiAffectedTask, error) {
	values := []sessionstore.WikiAffectedTask{}
	err := v.read(ctx, "WikiAffectedTasks", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT DISTINCT a.task_id FROM wiki_artifacts a JOIN tasks t ON t.id=a.task_id JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE a.invalidated=1 AND d.page_id=?`, pageID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WikiAffectedTask
			if err := rows.Scan(&item.TaskID); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WikiAffectedTasks", err, v.tx != nil)
}

func (v *transaction) AdvanceWikiGeneration(ctx context.Context, taskID string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, `INSERT INTO wiki_task_contexts(task_id,generation) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET generation=generation+1`, taskID)
	if err != nil {
		return 0, normalizeError("AdvanceWikiGeneration", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("AdvanceWikiGeneration", err, true)
}

func (v *view) WikiAffectedRuns(ctx context.Context, pageID string) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "WikiAffectedRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), `SELECT r.document FROM runs r WHERE r.task_id IN (SELECT a.task_id FROM wiki_artifacts a JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE a.invalidated=1 AND d.page_id=?) AND r.state IN ('queued','running','waiting-input','waiting-approval','waiting-resource','waiting-task','waiting-recovery','waiting-model','waiting-storage','recovery-required')`, pageID)
		return err
	})
	return values, normalizeError("WikiAffectedRuns", err, v.tx != nil)
}

func (v *transaction) RetireInvalidWikiCandidates(ctx context.Context) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, `UPDATE wiki_candidates SET state='invalidated',document=json_set(document,'$.status','invalidated') WHERE id IN (SELECT id FROM wiki_artifacts WHERE kind='candidate' AND invalidated=1) AND state='pending'`)
	if err != nil {
		return 0, normalizeError("RetireInvalidWikiCandidates", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("RetireInvalidWikiCandidates", err, true)
}

func (v *view) InvalidWikiRuns(ctx context.Context) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "InvalidWikiRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT document FROM runs WHERE state='running'")
		return err
	})
	return values, normalizeError("InvalidWikiRuns", err, v.tx != nil)
}

func (v *view) WikiTextMatches(ctx context.Context, value string, spaceID string) ([]sessionstore.WikiTextMatch, error) {
	values := []sessionstore.WikiTextMatch{}
	err := v.read(ctx, "WikiTextMatches", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, `SELECT page_id FROM wiki_fts WHERE wiki_fts MATCH ? AND (?='' OR space_id=?)`, value, spaceID, spaceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WikiTextMatch
			if err := rows.Scan(&item.PageID); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WikiTextMatches", err, v.tx != nil)
}

func (v *view) WikiEmbeddingMatches(ctx context.Context, id string, revision int) ([]sessionstore.WikiEmbeddingMatch, error) {
	values := []sessionstore.WikiEmbeddingMatch{}
	err := v.read(ctx, "WikiEmbeddingMatches", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT page_id,page_revision,digest,vector FROM wiki_embedding_indexes WHERE profile_id=? AND profile_revision=?", id, revision)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WikiEmbeddingMatch
			if err := rows.Scan(&item.PageID, &item.Revision, &item.Digest, &item.Vector); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WikiEmbeddingMatches", err, v.tx != nil)
}

func (v *view) RecoverableWikiJobs(ctx context.Context) ([]sessionstore.StoredWikiJob, error) {
	var values []sessionstore.StoredWikiJob
	err := v.read(ctx, "RecoverableWikiJobs", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[sessionstore.StoredWikiJob](ctx, v.query(ctx), "SELECT document FROM wiki_jobs WHERE state IN ('queued','running')")
		return err
	})
	return values, normalizeError("RecoverableWikiJobs", err, v.tx != nil)
}

func (v *view) WikiDirectory(ctx context.Context, space string, value int, offset int64) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "WikiDirectory", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), "SELECT document FROM wiki_pages WHERE space_id=? AND status='active' ORDER BY slug,id LIMIT ? OFFSET ?", space, value, offset)
		return err
	})
	return values, normalizeError("WikiDirectory", err, v.tx != nil)
}

func (v *view) WikiPageRevisions(ctx context.Context, space string, id string) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "WikiPageRevisions", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), "SELECT r.document FROM wiki_page_revisions r JOIN wiki_pages p ON p.id=r.page_id WHERE p.space_id=? AND r.page_id=? ORDER BY r.revision DESC", space, id)
		return err
	})
	return values, normalizeError("WikiPageRevisions", err, v.tx != nil)
}

func (v *view) WikiVisiblePages(ctx context.Context, runID string) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "WikiVisiblePages", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), `SELECT p.document FROM wiki_visible_pages v JOIN wiki_page_revisions p ON p.page_id=v.page_id AND p.revision=v.revision WHERE v.owner_kind='run' AND v.owner_id=? ORDER BY v.page_id`, runID)
		return err
	})
	return values, normalizeError("WikiVisiblePages", err, v.tx != nil)
}

func (v *view) WorkflowExists(ctx context.Context, id string, count *int) error {
	return normalizeError("WorkflowExists", v.read(ctx, "WorkflowExists", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_instances WHERE id=?", id).Scan(count)
	}), v.tx != nil)
}

func (v *view) WikiSourcesCleared(ctx context.Context, runID string, count *int) error {
	return normalizeError("WikiSourcesCleared", v.read(ctx, "WikiSourcesCleared", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_cleared_sources WHERE run_id=?", runID).Scan(count)
	}), v.tx != nil)
}

func (v *view) WikiSessionSelection(ctx context.Context, id string, document *string) error {
	return normalizeError("WikiSessionSelection", v.read(ctx, "WikiSessionSelection", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_session_spaces WHERE session_id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *transaction) InsertWikiSpaceRevision(ctx context.Context, id string, revision int, raw string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_space_revisions(id,revision,document) VALUES(?,?,?)", id, revision, raw)
	if err != nil {
		return 0, normalizeError("InsertWikiSpaceRevision", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWikiSpaceRevision", err, true)
}

func (v *transaction) UpdateWikiSpace(ctx context.Context, name string, document string, id string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "UPDATE wiki_spaces SET name=?,document=? WHERE id=?", name, document, id)
	if err != nil {
		return 0, normalizeError("UpdateWikiSpace", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("UpdateWikiSpace", err, true)
}

func (v *view) WikiPageRevision(ctx context.Context, space string, id string, revision int, document *string) error {
	return normalizeError("WikiPageRevision", v.read(ctx, "WikiPageRevision", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, `SELECT r.document FROM wiki_page_revisions r JOIN wiki_pages p ON p.id=r.page_id WHERE p.space_id=? AND r.page_id=? AND r.revision=?`, space, id, revision).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiSpaceRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("WikiSpaceRecord", v.read(ctx, "WikiSpaceRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_spaces WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiSpaces(ctx context.Context) ([]sessionstore.WikiSpaceDocument, error) {
	values := []sessionstore.WikiSpaceDocument{}
	err := v.read(ctx, "WikiSpaces", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT document FROM wiki_spaces ORDER BY kind DESC,name,id")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WikiSpaceDocument
			if err := rows.Scan(&item.Document); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WikiSpaces", err, v.tx != nil)
}

func (v *view) WikiSpaceCount(ctx context.Context, count *int) error {
	return normalizeError("WikiSpaceCount", v.read(ctx, "WikiSpaceCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM wiki_spaces WHERE kind='global'").Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertWikiSpace(ctx context.Context, id string, name string, kind string, raw string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_spaces(id,name,kind,document) VALUES(?,?,?,?)", id, name, kind, raw)
	if err != nil {
		return 0, normalizeError("InsertWikiSpace", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWikiSpace", err, true)
}

func (v *transaction) SaveWikiSessionSelection(ctx context.Context, sessionID string, raw string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_session_spaces(session_id,document) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET document=excluded.document", sessionID, raw)
	if err != nil {
		return 0, normalizeError("SaveWikiSessionSelection", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("SaveWikiSessionSelection", err, true)
}

func (v *view) DefaultWikiSpace(ctx context.Context, document *string) error {
	return normalizeError("DefaultWikiSpace", v.read(ctx, "DefaultWikiSpace", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT id FROM wiki_spaces WHERE kind='global'").Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiPageRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("WikiPageRecord", v.read(ctx, "WikiPageRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_pages WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiRevisionDigest(ctx context.Context, pageID string, revision int, document *string) error {
	return normalizeError("WikiRevisionDigest", v.read(ctx, "WikiRevisionDigest", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT digest FROM wiki_page_revisions WHERE page_id=? AND revision=?", pageID, revision).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiExportPages(ctx context.Context, id string) ([]WikiPage, error) {
	var values []WikiPage
	err := v.read(ctx, "WikiExportPages", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WikiPage](ctx, v.query(ctx), "SELECT document FROM wiki_page_revisions WHERE page_id=? ORDER BY revision", id)
		return err
	})
	return values, normalizeError("WikiExportPages", err, v.tx != nil)
}

func (v *transaction) InsertWikiCandidate(ctx context.Context, id string, spaceID string, status string, originKind string, originID string, raw string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO wiki_candidates(id,space_id,state,origin_kind,origin_id,document) VALUES(?,?,?,?,?,?)", id, spaceID, status, originKind, originID, raw)
	if err != nil {
		return 0, normalizeError("InsertWikiCandidate", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWikiCandidate", err, true)
}

func (v *view) WikiCandidateRecord(ctx context.Context, id string, document *string) error {
	return normalizeError("WikiCandidateRecord", v.read(ctx, "WikiCandidateRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_candidates WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) WikiPageBySlug(ctx context.Context, pageID string, spaceID string, document *string) error {
	return normalizeError("WikiPageBySlug", v.read(ctx, "WikiPageBySlug", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM wiki_pages WHERE id=? AND space_id=?", pageID, spaceID).Scan(document)
	}), v.tx != nil)
}

func (v *transaction) UpdateWikiCandidate(ctx context.Context, status string, doc string, id string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "UPDATE wiki_candidates SET state=?,document=? WHERE id=?", status, doc, id)
	if err != nil {
		return 0, normalizeError("UpdateWikiCandidate", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("UpdateWikiCandidate", err, true)
}

func (v *view) WorkflowDefinitionRevision(ctx context.Context, id string, count *int) error {
	return normalizeError("WorkflowDefinitionRevision", v.read(ctx, "WorkflowDefinitionRevision", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COALESCE(MAX(revision),0) FROM workflow_definitions WHERE id=?", id).Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertWorkflowDefinition(ctx context.Context, id string, revision int, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO workflow_definitions(id,revision,document) VALUES(?,?,?)", id, revision, document)
	if err != nil {
		return 0, normalizeError("InsertWorkflowDefinition", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWorkflowDefinition", err, true)
}

func (v *view) WorkflowRequest(ctx context.Context, requestID string, document *string, document2 *string) error {
	return normalizeError("WorkflowRequest", v.read(ctx, "WorkflowRequest", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT id,canonical_input FROM workflow_instances WHERE request_id=?", requestID).Scan(document, document2)
	}), v.tx != nil)
}

func (v *view) ActiveWorkflowCount(ctx context.Context, count *int) error {
	return normalizeError("ActiveWorkflowCount", v.read(ctx, "ActiveWorkflowCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_instances WHERE state NOT IN ('succeeded','failed','cancelled')").Scan(count)
	}), v.tx != nil)
}

func (v *transaction) InsertWorkflow(ctx context.Context, workflowID string, requestID string, canonical string, sessionID string, status string, readyAt string, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO workflow_instances(id,request_id,canonical_input,session_id,state,ready_at,document) VALUES(?,?,?,?,?,?,?)", workflowID, requestID, canonical, sessionID, status, readyAt, document)
	if err != nil {
		return 0, normalizeError("InsertWorkflow", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertWorkflow", err, true)
}

func (v *view) ReadyWorkflows(ctx context.Context) ([]WorkflowInstance, error) {
	var values []WorkflowInstance
	err := v.read(ctx, "ReadyWorkflows", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowInstance](ctx, v.query(ctx), "SELECT document FROM workflow_instances WHERE state='ready' OR (json_extract(document,'$.languageVersion')='workflow/v2' AND state IN ('queued','running','waiting-approval','waiting-resource','waiting-task')) ORDER BY ready_at,rowid")
		return err
	})
	return values, normalizeError("ReadyWorkflows", err, v.tx != nil)
}

func (v *view) WorkflowAttemptCount(ctx context.Context, workflowID string, id string, count *int) error {
	return normalizeError("WorkflowAttemptCount", v.read(ctx, "WorkflowAttemptCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COALESCE(MAX(number),0)+1 FROM workflow_attempts WHERE workflow_id=? AND step_id=?", workflowID, id).Scan(count)
	}), v.tx != nil)
}

func (v *view) WorkflowAttempts(ctx context.Context, workflowID string) ([]WorkflowAttempt, error) {
	var values []WorkflowAttempt
	err := v.read(ctx, "WorkflowAttempts", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowAttempt](ctx, v.query(ctx), "SELECT document FROM workflow_attempts WHERE workflow_id=? AND state='succeeded' ORDER BY rowid", workflowID)
		return err
	})
	return values, normalizeError("WorkflowAttempts", err, v.tx != nil)
}

func (v *view) RunWorkflowNode(ctx context.Context, id string, document *string) error {
	return normalizeError("RunWorkflowNode", v.read(ctx, "RunWorkflowNode", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM workflow_nodes WHERE id=?", id).Scan(document)
	}), v.tx != nil)
}

func (v *view) WorkflowRecoveryRequest(ctx context.Context, id string, requestID string, document *string, document2 *string) error {
	return normalizeError("WorkflowRecoveryRequest", v.read(ctx, "WorkflowRecoveryRequest", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT canonical_input,document FROM workflow_recoveries WHERE workflow_id=? AND request_id=?", id, requestID).Scan(document, document2)
	}), v.tx != nil)
}

func (v *view) PendingWorkflowApprovalCount(ctx context.Context, runID string, count *int) error {
	return normalizeError("PendingWorkflowApprovalCount", v.read(ctx, "PendingWorkflowApprovalCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM approvals WHERE run_id=?", runID).Scan(count)
	}), v.tx != nil)
}

func (v *view) WorkflowStepAttemptCount(ctx context.Context, workflowID string, id string, count *int) error {
	return normalizeError("WorkflowStepAttemptCount", v.read(ctx, "WorkflowStepAttemptCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_attempts WHERE workflow_id=? AND step_id=?", workflowID, id).Scan(count)
	}), v.tx != nil)
}

func (v *view) WorkflowRuns(ctx context.Context) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "WorkflowRuns", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT document FROM runs WHERE workflow_id<>''")
		return err
	})
	return values, normalizeError("WorkflowRuns", err, v.tx != nil)
}

func (v *view) ActiveWorkflows(ctx context.Context) ([]WorkflowInstance, error) {
	var values []WorkflowInstance
	err := v.read(ctx, "ActiveWorkflows", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[WorkflowInstance](ctx, v.query(ctx), "SELECT document FROM workflow_instances WHERE state NOT IN ('succeeded','failed','cancelled')")
		return err
	})
	return values, normalizeError("ActiveWorkflows", err, v.tx != nil)
}

func (v *view) TaskRunCount(ctx context.Context, taskID string, count *int) error {
	return normalizeError("TaskRunCount", v.read(ctx, "TaskRunCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, `SELECT COUNT(*) FROM runs WHERE task_id=? AND state NOT IN ('succeeded','failed','cancelled','interrupted')`, taskID).Scan(count)
	}), v.tx != nil)
}

func (v *view) TaskExists(ctx context.Context, id string, count *int) error {
	return normalizeError("TaskExists", v.read(ctx, "TaskExists", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM tasks WHERE id=?", id).Scan(count)
	}), v.tx != nil)
}

func (v *transaction) EnqueueWorkspaceCleanup(ctx context.Context, taskID string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT OR IGNORE INTO workspace_cleanup(task_id) VALUES(?)", taskID)
	if err != nil {
		return 0, normalizeError("EnqueueWorkspaceCleanup", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("EnqueueWorkspaceCleanup", err, true)
}

func (v *view) WorkspaceCleanup(ctx context.Context) ([]sessionstore.WorkspaceCleanupTask, error) {
	values := []sessionstore.WorkspaceCleanupTask{}
	err := v.read(ctx, "WorkspaceCleanup", func(ctx context.Context) error {
		values = values[:0]
		rows, err := v.query(ctx).QueryContext(ctx, "SELECT task_id FROM workspace_cleanup")
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item sessionstore.WorkspaceCleanupTask
			if err := rows.Scan(&item.TaskID); err != nil {
				return err
			}
			values = append(values, item)
		}
		return rows.Err()
	})
	return values, normalizeError("WorkspaceCleanup", err, v.tx != nil)
}

func (v *transaction) RemoveWorkspaceCleanup(ctx context.Context, id string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "DELETE FROM workspace_cleanup WHERE task_id=?", id)
	if err != nil {
		return 0, normalizeError("RemoveWorkspaceCleanup", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("RemoveWorkspaceCleanup", err, true)
}

func (v *view) ListWikiPages(ctx context.Context, spaceID string, includeWithdrawn bool) (values []WikiPage, err error) {
	err = v.read(ctx, "wiki-pages", func(ctx context.Context) error {
		var e error
		values, e = readDocuments[WikiPage](ctx, v.query(ctx), "SELECT document FROM wiki_pages WHERE (?='' OR space_id=?) AND (? OR status<>'withdrawn') ORDER BY rowid DESC", spaceID, spaceID, includeWithdrawn)
		return e
	})
	return values, normalizeError("wiki-pages", err, v.tx != nil)
}
func (v *view) ListWikiCandidates(ctx context.Context, spaceID, status string) (values []WikiCandidate, err error) {
	err = v.read(ctx, "wiki-candidates", func(ctx context.Context) error {
		var e error
		values, e = readDocuments[WikiCandidate](ctx, v.query(ctx), "SELECT document FROM wiki_candidates WHERE (?='' OR space_id=?) AND (?='' OR state=?) ORDER BY rowid DESC", spaceID, spaceID, status, status)
		return e
	})
	return values, normalizeError("wiki-candidates", err, v.tx != nil)
}
func (v *view) EmbeddingRequests(ctx context.Context, offset int64, limit int) (page Page[EmbeddingRequest], err error) {
	err = v.read(ctx, "embedding-requests", func(ctx context.Context) error {
		rows, e := v.query(ctx).QueryContext(ctx, "SELECT rowid,document FROM wiki_embedding_requests WHERE (?=0 OR rowid<?) ORDER BY rowid DESC LIMIT ?", offset, offset, limit+1)
		if e != nil {
			return e
		}
		page, e = documentPage[EmbeddingRequest](rows, limit, 0, "")
		return e
	})
	return page, normalizeError("embedding-requests", err, v.tx != nil)
}
