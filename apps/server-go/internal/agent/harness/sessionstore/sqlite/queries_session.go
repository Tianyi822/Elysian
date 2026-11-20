package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/tools"
)

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

func (v *view) QueuedRunCount(ctx context.Context, count *int) error {
	return normalizeError("QueuedRunCount", v.read(ctx, "QueuedRunCount", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(count)
	}), v.tx != nil)
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

func (v *view) ContinuousWaiters(ctx context.Context) ([]Run, error) {
	var values []Run
	err := v.read(ctx, "ContinuousWaiters", func(ctx context.Context) error {
		var err error
		values, err = readDocuments[Run](ctx, v.query(ctx), "SELECT document FROM runs WHERE state IN ('waiting-model','waiting-storage') ORDER BY created_at LIMIT 64")
		return err
	})
	return values, normalizeError("ContinuousWaiters", err, v.tx != nil)
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

func (v *view) TaskSnapshot(ctx context.Context, taskID string, document *string) error {
	return normalizeError("TaskSnapshot", v.read(ctx, "TaskSnapshot", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM tasks WHERE id=?", taskID).Scan(document)
	}), v.tx != nil)
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

func (v *view) UserInputRecord(ctx context.Context, inputID string, runID string, document *string) error {
	return normalizeError("UserInputRecord", v.read(ctx, "UserInputRecord", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT document FROM user_inputs WHERE id=? AND run_id=?", inputID, runID).Scan(document)
	}), v.tx != nil)
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
