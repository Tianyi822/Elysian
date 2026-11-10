package harness

import (
	"context"
	"database/sql"
)

// Receipt settlement is evidenced by the atomic call/finished event, including
// legacy receipts with an empty body. Restart interruption emits no such event.
func operationReceiptSettled(ctx context.Context, q rowReader, runID, callID string) (bool, error) {
	var settled bool
	err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND json_extract(document,'$.callId')=? AND json_extract(document,'$.type')='call/finished')`, runID, callID).Scan(&settled)
	return settled, err
}

// Synchronous receipts and domain receipts share the same protection transition.
// Only administrative reconciliation may release an unknown result without a receipt.
func settleOperationProtection(ctx context.Context, tx *sql.Tx, id, ended string, unknown bool) error {
	barriers, err := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE operation_id=?", id)
	if err != nil {
		return err
	}
	for _, barrier := range barriers {
		if barrier.Status == "reconciled" || barrier.Reconciliation != nil {
			return nil
		}
		barrier.Status = "confirmed"
		if unknown {
			barrier.Status = "unknown"
		}
		if err := saveBarrier(ctx, tx, barrier); err != nil {
			return err
		}
	}
	return settleResourceLease(ctx, tx, id, ended, unknown, "", "")
}
