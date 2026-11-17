package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	hstate "elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/harness/workspace"
)

func saveOperation(ctx context.Context, tx *sql.Tx, o Operation) error {
	raw, err := json.Marshal(o)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO operations(id,run_id,model_request_id,call_index,state,document) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, o.ID, o.RunID, o.ModelRequestID, o.CallIndex, o.Status, string(raw))
	return err
}

func readOperation(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (Operation, error) {
	var o Operation
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM operations WHERE id=?", id).Scan(&raw)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &o)
	}
	return o, err
}

func saveApproval(ctx context.Context, tx *sql.Tx, a Approval) error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO approvals(id,operation_id,run_id,state,expires_at,document) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,expires_at=excluded.expires_at,document=excluded.document`, a.ID, nullableWorkflowString(a.OperationID), a.RunID, a.Status, a.ExpiresAt, string(raw))
	return err
}

func readApprovalTx(ctx context.Context, tx *sql.Tx, runID string) ([]Approval, error) {
	return readDocuments[Approval](ctx, tx, "SELECT document FROM approvals WHERE run_id=?", runID)
}

func saveBarrier(ctx context.Context, tx *sql.Tx, b ExecutionBarrier) error {
	raw, err := json.Marshal(b)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO execution_barriers(id,operation_id,run_id,state,document) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, b.ID, b.OperationID, b.RunID, b.Status, string(raw))
	return err
}

func recoverOperations(ctx context.Context, tx *sql.Tx, now time.Time) error {
	operations, err := readDocuments[Operation](ctx, tx, "SELECT document FROM operations WHERE state='dispatched'")
	if err != nil {
		return err
	}
	for _, o := range operations {
		o.Status = "unknown"
		o.EndedAt = stamp(now)
		o.Error = &Failure{Code: "outcome-unknown", Message: "面板重启时操作已派发，结果未确认"}
		if err = saveOperation(ctx, tx, o); err != nil {
			return err
		}
		// Even a trusted read can lose its stop acknowledgement at restart.
		// Every retained unknown lease needs an explicit reconciliation handle.
		var barriers int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM execution_barriers WHERE operation_id=?", o.ID).Scan(&barriers); err != nil {
			return err
		}
		if barriers == 0 {
			b := ExecutionBarrier{ID: o.ID, WorkflowID: o.WorkflowID, RunID: o.RunID, OperationID: o.ID, Status: "unknown", CreatedAt: o.DispatchedAt}
			if err := saveBarrier(ctx, tx, b); err != nil {
				return err
			}
		}
	}
	barriers, err := readDocuments[ExecutionBarrier](ctx, tx, "SELECT document FROM execution_barriers WHERE state='dispatched'")
	if err != nil {
		return err
	}
	for _, b := range barriers {
		var state string
		if err := tx.QueryRowContext(ctx, "SELECT state FROM operations WHERE id=?", b.OperationID).Scan(&state); err != nil {
			return err
		}
		if state == StateWaitingTask {
			continue
		}
		b.Status = "unknown"
		if err = saveBarrier(ctx, tx, b); err != nil {
			return err
		}
	}
	return recoverResourceLeases(ctx, tx)
}

func saveSessionAuthorization(ctx context.Context, tx *sql.Tx, a SessionAuthorization) error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO session_authorizations(id,session_id,scope_key,state,document) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, a.ID, a.SessionID, a.Access.ScopeKey, a.Status, string(raw))
	return err
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

func readProbeLease(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (ResourceLease, error) {
	var lease ResourceLease
	var raw string
	if err := db.QueryRowContext(ctx, "SELECT document FROM resource_leases WHERE id=?", id).Scan(&raw); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lease, &Error{Status: 404, Code: "probe-request-not-found", Message: "MCP 探测申请不存在"}
		}
		return lease, err
	}
	if err := json.Unmarshal([]byte(raw), &lease); err != nil {
		return lease, err
	}
	if lease.Source != "mcp-probe" || lease.Probe == nil {
		return lease, &Error{Status: 404, Code: "probe-request-not-found", Message: "MCP 探测申请不存在"}
	}
	if lease.State == "unknown" {
		lease.Probe.State = "unknown"
		lease.Probe.Error = "探测结果未确认，需要先核实已有执行"
	}
	return lease, nil
}

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

func readBarrier(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, id string) (ExecutionBarrier, error) {
	var b ExecutionBarrier
	var raw string
	if err := q.QueryRowContext(ctx, "SELECT document FROM execution_barriers WHERE id=?", id).Scan(&raw); err != nil {
		return b, err
	}
	err := json.Unmarshal([]byte(raw), &b)
	return b, err
}

// readWorkspaceVersion 只读取宿主数据库指针，不扫描归档目录中的候选版本。
// 返回零版本表示空工作区，绝不能用磁盘上的最大版本代替当前版本。
func readWorkspaceVersion(ctx context.Context, q rowReader, taskID string) (workspace.Version, error) {
	var revision int
	var raw string
	err := q.QueryRowContext(ctx, "SELECT revision,document FROM workspace_versions WHERE task_id=?", taskID).Scan(&revision, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return workspace.Version{TaskID: taskID}, nil
	}
	if err != nil {
		return workspace.Version{}, err
	}
	var version workspace.Version
	if err = json.Unmarshal([]byte(raw), &version); err != nil {
		return workspace.Version{}, err
	}
	if version.TaskID != taskID || version.Revision != revision || hstate.ValidateWorkspaceVersion(version) != nil {
		return workspace.Version{}, errors.New("工作区数据库版本指针损坏")
	}
	return version, nil
}

// commitWorkspaceVersion 由父进程在结果事务内调用，使用 BaseRevision 做 CAS。
// 调用者须已验证归档存在，并在同一事务内验证 Task/Run 身份与操作状态。
func commitWorkspaceVersion(ctx context.Context, tx *sql.Tx, version workspace.Version) error {
	if err := hstate.ValidateWorkspaceVersion(version); err != nil {
		return err
	}
	current, err := readWorkspaceVersion(ctx, tx, version.TaskID)
	if err != nil {
		return err
	}
	if current.Revision != version.BaseRevision {
		return hstate.WorkspaceConflict()
	}
	raw, err := json.Marshal(version)
	if err != nil {
		return err
	}
	var result sql.Result
	if current.Revision == 0 {
		result, err = tx.ExecContext(ctx, `INSERT INTO workspace_versions(task_id,revision,document) VALUES(?,?,?) ON CONFLICT(task_id) DO NOTHING`, version.TaskID, version.Revision, string(raw))
	} else {
		result, err = tx.ExecContext(ctx, `UPDATE workspace_versions SET revision=?,document=? WHERE task_id=? AND revision=?`, version.Revision, string(raw), version.TaskID, version.BaseRevision)
	}
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return hstate.WorkspaceConflict()
	}
	return nil
}
