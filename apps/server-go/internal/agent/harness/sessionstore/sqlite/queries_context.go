package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

func (v *view) ContextItems(ctx context.Context, value string) ([]ContextItem, error) {
	var values []ContextItem
	err := v.read(ctx, "ContextItems", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ContextItem](ctx, v.query(ctx), "SELECT document FROM context_items WHERE run_id=? ORDER BY rowid", value)
		return err
	})
	return values, normalizeError("ContextItems", err, v.tx != nil)
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

func (v *view) OperationContext(ctx context.Context, taskID string) ([]ContextItem, error) {
	var values []ContextItem
	err := v.read(ctx, "OperationContext", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[ContextItem](ctx, v.query(ctx), "SELECT document FROM context_items WHERE task_id=?", taskID)
		return err
	})
	return values, normalizeError("OperationContext", err, v.tx != nil)
}

func (v *transaction) InsertContextItem(ctx context.Context, id string, runID string, taskID string, document string) (sessionstore.AffectedRows, error) {
	r, err := v.tx.ExecContext(ctx, "INSERT INTO context_items(id,run_id,task_id,document) VALUES(?,?,?,?)", id, runID, taskID, document)
	if err != nil {
		return 0, normalizeError("InsertContextItem", err, true)
	}
	n, err := r.RowsAffected()
	return sessionstore.AffectedRows(n), normalizeError("InsertContextItem", err, true)
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
