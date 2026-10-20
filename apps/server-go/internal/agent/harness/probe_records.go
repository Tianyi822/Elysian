package harness

import (
	"context"
	"database/sql"
)

// Only confirmed released probes expire. Pending review, in-flight, and
// unknown execution facts retain their lease and complete recovery ledger.
func sweepProbeRecords(ctx context.Context, tx *sql.Tx, cutoff string) error {
	leases, err := readDocuments[ResourceLease](ctx, tx, `SELECT document FROM resource_leases
 WHERE run_id='' AND operation_id='' AND state='released' AND json_extract(document,'$.source')='mcp-probe'
 AND COALESCE(json_extract(document,'$.endedAt'),'')<>'' AND julianday(json_extract(document,'$.endedAt'))<julianday(?)`, cutoff)
	if err != nil {
		return err
	}
	for _, lease := range leases {
		if err := purgeRecordOwner(ctx, tx, recordOwner{kind: "mcp-probe", id: lease.ID}); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM resource_leases WHERE id=? AND state='released'", lease.ID); err != nil {
			return err
		}
	}
	return nil
}
