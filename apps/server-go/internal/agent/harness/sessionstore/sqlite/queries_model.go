package sqlite

import (
	"context"
)

func (v *view) ModelRequest(ctx context.Context, responseID string, runID string, document *string) error {
	return normalizeError("ModelRequest", v.read(ctx, "ModelRequest", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM model_requests WHERE id=? AND run_id=?", responseID, runID).Scan(document)
	}), v.tx != nil)
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

func (v *view) ModelRequestCount(ctx context.Context, runID string, count *int) error {
	return normalizeError("ModelRequestCount", v.read(ctx, "ModelRequestCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM model_requests WHERE run_id=? AND request_index=-1", runID).Scan(count)
	}), v.tx != nil)
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
