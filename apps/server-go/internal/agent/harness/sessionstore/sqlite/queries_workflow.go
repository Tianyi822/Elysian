package sqlite

import (
	"context"

	"elysian/server/internal/agent/harness/sessionstore"
)

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

func (v *view) WorkflowExists(ctx context.Context, id string, count *int) error {
	return normalizeError("WorkflowExists", v.read(ctx, "WorkflowExists", func(ctx context.Context) error {
		return v.query(ctx).QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_instances WHERE id=?", id).Scan(count)
	}), v.tx != nil)
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
