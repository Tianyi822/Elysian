package sqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"

	"elysian/server/internal/agent/harness/state"
)

var workflowBindingError = state.WorkflowBindingError

type workflowQuery interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readWorkflow(ctx context.Context, q workflowQuery, id string) (WorkflowInstance, error) {
	var w WorkflowInstance
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM workflow_instances WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return w, notFound()
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &w)
	}
	return w, err
}

func readWorkflowDefinition(ctx context.Context, q workflowQuery, id string, revision int) (WorkflowDefinition, error) {
	var d WorkflowDefinition
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM workflow_definitions WHERE id=? AND (?=0 OR revision=?) ORDER BY revision DESC LIMIT 1", id, revision, revision).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return d, notFound()
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &d)
	}
	return d, err
}

func saveWorkflow(ctx context.Context, tx *sql.Tx, w *WorkflowInstance) error {
	w.Revision++
	w.AllowedActions = []string{} // 可行动作依赖当前屏障与运行位置，只在查询时计算。
	raw, err := json.Marshal(w)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE workflow_instances SET state=?,ready_at=?,document=? WHERE id=?", w.Status, w.ReadyAt, string(raw), w.ID)
	return err
}

func saveWorkflowAttempt(ctx context.Context, tx *sql.Tx, a WorkflowAttempt) error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO workflow_attempts(workflow_id,step_id,number,run_id,state,document) VALUES(?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET state=excluded.state,document=excluded.document`, a.WorkflowID, a.StepID, a.Number, a.RunID, a.Status, string(raw))
	return err
}

func (s *store) workflowEvent(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, kind, detail string) error {
	w.LastSeq = state.NextSeq(w.LastSeq)
	w.UpdatedAt = stamp(s.now())
	e := WorkflowEvent{WorkflowID: w.ID, Seq: w.LastSeq, Type: kind, StepID: w.CurrentStepID, RunID: w.ActiveRunID, At: w.UpdatedAt, Detail: detail}
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	n, _ := strconv.ParseInt(w.LastSeq, 10, 64)
	if _, err = tx.ExecContext(ctx, "INSERT INTO workflow_events(workflow_id,seq,document) VALUES(?,?,?)", w.ID, n, string(raw)); err != nil {
		return err
	}
	return saveWorkflow(ctx, tx, w)
}

func workflowOutputs(ctx context.Context, tx *sql.Tx, id string) (map[string]string, error) {
	attempts, err := readDocuments[WorkflowAttempt](ctx, tx, "SELECT document FROM workflow_attempts WHERE workflow_id=? AND state='succeeded' ORDER BY number", id)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for _, a := range attempts {
		v, e := workflowOutput(ctx, tx, a)
		if e != nil {
			return nil, e
		}
		out[a.StepID] = v
	}
	return out, nil
}

func (s *store) finishWorkflowRun(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.WorkflowID == "" {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if state.WorkflowV2(w) {
		return s.finishWorkflowV2Run(ctx, tx, r)
	}
	if state.Terminal(w.Status) || w.ActiveRunID != r.ID {
		return nil
	}
	a, err := readWorkflowAttempt(ctx, tx, r.ID)
	if err != nil {
		return err
	}
	if a.Status == StateSucceeded {
		return nil
	}
	a.Status = r.Status
	a.EndedAt = r.EndedAt
	a.EventSeq = r.LastSeq
	if r.Status == StateSucceeded {
		a.OutputJSON = r.WorkflowOutputJSON
		a.OutputCallID = r.WorkflowOutputCallID
		a.OutputRequestID = r.WorkflowOutputRequestID
		a.CompletionSource = "execution"
		if a.OutputRequestID != "" {
			a.OutputJSON = ""
			r.WorkflowOutputJSON = ""
		}
		v, e := readWorkspaceVersion(ctx, tx, r.TaskID)
		if e != nil {
			return e
		}
		a.WorkspaceRevision = v.Revision
		if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
			return err
		}
		if err = s.advanceWorkflow(ctx, tx, &w, a, r.WorkflowNext); err != nil {
			return err
		}
	} else {
		if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
			return err
		}
		w.Status = StateRecoveryRequired
		w.Error = r.Error
		if w.Error == nil {
			w.Error = &Failure{Code: r.EndReason, Message: "步骤未完成，需要人工恢复"}
		}
		if r.Status == StateCancelled || w.CancelRequestedAt != "" {
			w.Status = StateCancelled
		}
		if r.EndReason == "approval-denied" || r.EndReason == "workflow-budget" {
			w.Status = StateFailed
		}
		if state.Terminal(w.Status) {
			w.EndedAt = stamp(s.now())
		}
		if err = s.workflowEvent(ctx, tx, &w, "workflow/"+w.Status, w.Error.Message); err != nil {
			return err
		}
	}
	return saveRun(ctx, tx, r)
}

func (s *store) advanceWorkflow(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, a WorkflowAttempt, next string) error {
	d, err := readWorkflowDefinition(ctx, tx, w.DefinitionID, w.DefinitionRevision)
	if err != nil {
		return err
	}
	step, err := state.WorkflowStep(d, a.StepID)
	if err != nil {
		return err
	}
	w.Error = nil
	if step.Finish != nil {
		outputs, e := workflowOutputs(ctx, tx, w.ID)
		if e != nil {
			return e
		}
		output, e := state.EvaluateWorkflowBinding(*step.Finish, w.InputJSON, outputs)
		if e == nil {
			e = state.ValidateWorkflowJSON(d.OutputSchemaJSON, output)
		}
		if e != nil {
			w.Status = StateRecoveryRequired
			w.Error = &Failure{Code: "workflow-output", Message: "流程最终输出不符合固定契约"}
			return s.workflowEvent(ctx, tx, w, "workflow/recovery-required", w.Error.Message)
		}
		w.OutputJSON = output
		w.Status = StateSucceeded
		w.EndedAt = stamp(s.now())
		w.ActiveRunID = ""
	} else {
		if step.Kind != "condition" {
			next = step.Next
		}
		if next == "" {
			return bad("workflow-next", "工作流后继步骤缺失")
		}
		w.CurrentStepID = next
		w.ActiveRunID = ""
		w.Status = StateReady
		w.ReadyAt = stamp(s.now())
	}
	return s.workflowEvent(ctx, tx, w, "workflow/"+w.Status, "")
}

func (s *store) syncWorkflowRun(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.WorkflowID == "" || state.Terminal(r.Status) {
		return nil
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	if state.WorkflowV2(w) {
		return s.syncWorkflowV2Run(ctx, tx, r)
	}
	if state.Terminal(w.Status) || w.ActiveRunID != r.ID {
		return nil
	}
	a, err := readWorkflowAttempt(ctx, tx, r.ID)
	if err != nil {
		return err
	}
	a.Status = r.Status
	if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
		return err
	}
	if w.Status == r.Status {
		return nil
	}
	w.Status = r.Status
	return s.workflowEvent(ctx, tx, &w, "workflow/"+r.Status, "")
}

// 活动时间是所有后续步骤都需要的额度。只在已经结算耗尽后关闭实例，
// 不把模型或工具额度恰好用完推广为整个工作流失败。
func (s *store) failWorkflowActiveBudget(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, current *Run) error {
	if state.Terminal(w.Status) || w.CancelRequestedAt != "" || w.Usage.ActiveMilliseconds < w.Limits.ActiveMilliseconds {
		return nil
	}
	if current != nil && current.CancelRequestedAt != "" {
		return nil
	}
	failure := &Failure{Code: "workflow-budget", Message: "工作流累计活动时间已耗尽，无法继续或恢复"}
	if state.WorkflowV2(*w) {
		return s.failWorkflowV2Budget(ctx, tx, w, current, failure)
	}
	endedAt := stamp(s.now())
	if w.ActiveRunID != "" {
		if current == nil || current.ID != w.ActiveRunID {
			r, err := readRun(ctx, tx, w.ActiveRunID)
			if err != nil {
				return err
			}
			current = &r
		}
		if !state.Terminal(current.Status) {
			current.Status = StateFailed
			current.EndReason = failure.Code
			current.Error = failure
			current.EndedAt = endedAt
			current.MemoryStatus = "stale"
			if err := s.event(ctx, tx, current, "run/failed", "", nil, failure); err != nil {
				return err
			}
			a, err := readWorkflowAttempt(ctx, tx, current.ID)
			if err != nil {
				return err
			}
			a.Status = current.Status
			a.EndedAt = current.EndedAt
			a.EventSeq = current.LastSeq
			if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
				return err
			}
		}
		approvals, err := readDocuments[Approval](ctx, tx, "SELECT document FROM approvals WHERE run_id=? AND state IN ('pending','approved')", w.ActiveRunID)
		if err != nil {
			return err
		}
		for _, a := range approvals {
			a.Status = "revoked"
			if err = saveApproval(ctx, tx, a); err != nil {
				return err
			}
		}
	}
	w.Status = StateFailed
	w.Error = failure
	w.EndedAt = endedAt
	if err := s.workflowEvent(ctx, tx, w, "workflow/failed", failure.Message); err != nil {
		return err
	}
	return s.releaseWorkflowSession(ctx, tx, *w)
}

func readWorkflowAttempt(ctx context.Context, q workflowQuery, runID string) (WorkflowAttempt, error) {
	var a WorkflowAttempt
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM workflow_attempts WHERE run_id=?", runID).Scan(&raw)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &a)
	}
	return a, err
}

func workflowOutput(ctx context.Context, q workflowQuery, a WorkflowAttempt) (string, error) {
	if a.OutputCallID != "" {
		var raw string
		var c Call
		err := q.QueryRowContext(ctx, "SELECT document FROM calls WHERE id=?", a.OutputCallID).Scan(&raw)
		if err != nil {
			return "", err
		}
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			return "", err
		}
		if len(c.Result) == 0 {
			return "null", nil
		}
		return string(c.Result), nil
	}
	if a.OutputRequestID != "" {
		var raw string
		var r ModelRequestRecord
		err := q.QueryRowContext(ctx, "SELECT document FROM model_requests WHERE id=?", a.OutputRequestID).Scan(&raw)
		if err != nil {
			return "", err
		}
		if err = json.Unmarshal([]byte(raw), &r); err != nil {
			return "", err
		}
		if r.Response == nil || len(r.Response.ToolCalls) != 1 {
			return "", bad("workflow-output", "步骤结构化结果缺失")
		}
		return string(r.Response.ToolCalls[0].Arguments), nil
	}
	return a.OutputJSON, nil
}

// A scope is a local graph and a private Task. Nodes retain their identity across
// retries, while a new Run is allocated for every leaf attempt.
type workflowTreeQuery interface {
	workflowQuery
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readWorkflowScope(ctx context.Context, q workflowQuery, id string) (WorkflowScope, error) {
	var scope WorkflowScope
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM workflow_scopes WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return scope, notFound()
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &scope)
	}
	return scope, err
}

func readWorkflowNode(ctx context.Context, q workflowQuery, id string) (WorkflowNodeExecution, error) {
	var node WorkflowNodeExecution
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM workflow_nodes WHERE id=?", id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return node, notFound()
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &node)
	}
	return node, err
}

func saveWorkflowScope(ctx context.Context, tx *sql.Tx, scope WorkflowScope) error {
	raw, err := json.Marshal(scope)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO workflow_scopes(id,workflow_id,parent_node_id,task_id,ordinal,state,document) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, scope.ID, scope.WorkflowID, scope.ParentNodeID, scope.TaskID, scope.Ordinal, scope.Status, string(raw))
	return err
}

func saveWorkflowNode(ctx context.Context, tx *sql.Tx, node *WorkflowNodeExecution) error {
	previous := node.Revision
	node.Revision++
	node.AllowedActions = []string{}
	raw, err := json.Marshal(node)
	if err != nil {
		return err
	}
	if previous == 0 {
		_, err = tx.ExecContext(ctx, `INSERT INTO workflow_nodes(id,workflow_id,scope_id,step_id,state,document) VALUES(?,?,?,?,?,?)`, node.ID, node.WorkflowID, node.ScopeID, node.StepID, node.Status, string(raw))
		return err
	}
	result, err := tx.ExecContext(ctx, `UPDATE workflow_nodes SET state=?,document=? WHERE id=? AND json_extract(document,'$.revision')=?`, node.Status, string(raw), node.ID, previous)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count != 1 {
		return &Error{Status: 409, Code: "node-revision-conflict", Message: "工作流节点版本已变化"}
	}
	return err
}

func createWorkflowV2Scope(ctx context.Context, tx *sql.Tx, scope WorkflowScope, newID func() string) error {
	var count int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_nodes WHERE workflow_id=?", scope.WorkflowID).Scan(&count); err != nil {
		return err
	}
	if scope.Depth > workflowV2MaxDepth || count+len(scope.Body.Steps) > workflowV2MaxNodes {
		return bad("workflow-expansion-limit", "工作流展开超过 4 层或 256 个节点上限")
	}
	if err := saveWorkflowScope(ctx, tx, scope); err != nil {
		return err
	}
	for ordinal, step := range scope.Body.Steps {
		state := "pending"
		if step.ID == scope.Body.Entry {
			state = StateReady
		}
		node := WorkflowNodeExecution{ID: newID(), WorkflowID: scope.WorkflowID, ScopeID: scope.ID, StepID: step.ID, StableKey: scope.Path + "/" + step.ID, Kind: step.Kind, Ordinal: ordinal, Status: state, TaskID: scope.TaskID, CreatedAt: scope.CreatedAt, AllowedActions: []string{}}
		if err := saveWorkflowNode(ctx, tx, &node); err != nil {
			return err
		}
	}
	return nil
}

func createWorkflowV2Root(ctx context.Context, tx *sql.Tx, w WorkflowInstance, d WorkflowDefinition, newID func() string) error {
	return createWorkflowV2Scope(ctx, tx, WorkflowScope{ID: w.RootScopeID, WorkflowID: w.ID, Path: "root", Kind: "root", TaskID: w.TaskID, Status: StateReady, CurrentStepID: d.Entry, InputJSON: w.InputJSON, Body: state.DefinitionBody(d), CreatedAt: w.CreatedAt}, newID)
}

func (s *store) syncWorkflowV2Run(ctx context.Context, tx *sql.Tx, r *Run) error {
	_, node, _, err := workflowV2StepForRun(ctx, tx, *r)
	if err != nil {
		return err
	}
	if state.Terminal(node.Status) || node.Status == StateRecoveryRequired {
		return nil
	}
	a, err := readWorkflowAttempt(ctx, tx, r.ID)
	if err != nil {
		return err
	}
	a.Status = r.Status
	if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
		return err
	}
	node.Status = r.Status
	if err = saveWorkflowNode(ctx, tx, &node); err != nil {
		return err
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	return s.refreshWorkflowV2(ctx, tx, &w)
}

func (s *store) finishWorkflowV2Run(ctx context.Context, tx *sql.Tx, r *Run) error {
	scope, node, step, err := workflowV2StepForRun(ctx, tx, *r)
	if err != nil {
		return err
	}
	w, err := readWorkflow(ctx, tx, r.WorkflowID)
	if err != nil {
		return err
	}
	a, err := readWorkflowAttempt(ctx, tx, r.ID)
	if err != nil || a.Status == StateSucceeded {
		return err
	}
	a.Status, a.EndedAt, a.EventSeq = r.Status, r.EndedAt, r.LastSeq
	if r.Status != StateSucceeded {
		if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
			return err
		}
		failure := r.Error
		if failure == nil {
			failure = &Failure{Code: r.EndReason, Message: "节点未完成，需要人工恢复"}
		}
		return s.failWorkflowV2Node(ctx, tx, &w, &node, failure)
	}
	a.OutputJSON, a.OutputCallID, a.OutputRequestID, a.CompletionSource = r.WorkflowOutputJSON, r.WorkflowOutputCallID, r.WorkflowOutputRequestID, "execution"
	if a.OutputRequestID != "" {
		a.OutputJSON, r.WorkflowOutputJSON = "", ""
	}
	version, err := readWorkspaceVersion(ctx, tx, r.TaskID)
	if err != nil {
		return err
	}
	a.WorkspaceRevision = version.Revision
	output, err := workflowOutput(ctx, tx, a)
	if err == nil {
		err = state.ValidateWorkflowJSON(step.OutputSchemaJSON, output)
	}
	if err != nil {
		return err
	}
	if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
		return err
	}
	node.OutputJSON, node.EndedAt, node.Status = output, r.EndedAt, StateSucceeded
	if err = saveWorkflowNode(ctx, tx, &node); err != nil {
		return err
	}
	if !state.Terminal(w.Status) {
		if err = s.advanceWorkflowV2Scope(ctx, tx, &w, &scope, node, step, r.WorkflowNext); err != nil {
			return err
		}
	}
	if err = saveRun(ctx, tx, r); err != nil {
		return err
	}
	return s.refreshWorkflowV2(ctx, tx, &w)
}

func (s *store) advanceWorkflowV2Scope(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, scope *WorkflowScope, node WorkflowNodeExecution, step WorkflowStepDefinition, next string) error {
	if step.Finish != nil {
		outputs, err := workflowScopeOutputs(ctx, tx, scope.ID)
		if err != nil {
			return err
		}
		output, err := state.EvaluateWorkflowBinding(*step.Finish, scope.InputJSON, outputs)
		if err == nil {
			err = state.ValidateWorkflowJSON(scope.Body.OutputSchemaJSON, output)
		}
		if err != nil {
			return s.failWorkflowV2Node(ctx, tx, w, &node, &Failure{Code: "workflow-output", Message: "作用域最终输出不符合固定契约"})
		}
		scope.OutputJSON, scope.Status, scope.EndedAt = output, StateSucceeded, stamp(s.now())
		pending, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE scope_id=? AND state='pending'", scope.ID)
		if err != nil {
			return err
		}
		for _, skipped := range pending {
			skipped.Status, skipped.EndedAt = "skipped", scope.EndedAt
			if err = saveWorkflowNode(ctx, tx, &skipped); err != nil {
				return err
			}
		}
		if scope.ParentNodeID == "" {
			w.OutputJSON, w.Status, w.EndedAt, w.ActiveRunID = output, StateSucceeded, scope.EndedAt, ""
			w.Error = nil
		}
	} else {
		if step.Kind != "condition" {
			next = step.Next
		}
		var id string
		if err := tx.QueryRowContext(ctx, "SELECT id FROM workflow_nodes WHERE scope_id=? AND step_id=?", scope.ID, next).Scan(&id); err != nil {
			return err
		}
		successor, err := readWorkflowNode(ctx, tx, id)
		if err != nil {
			return err
		}
		if successor.Status != "pending" {
			return bad("workflow-successor-state", "工作流后继节点已被推进")
		}
		successor.Status = StateReady
		if err = saveWorkflowNode(ctx, tx, &successor); err != nil {
			return err
		}
		scope.CurrentStepID, scope.Status = next, StateReady
	}
	return saveWorkflowScope(ctx, tx, *scope)
}

func (s *store) failWorkflowV2Node(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, node *WorkflowNodeExecution, failure *Failure) error {
	node.Status, node.Error, node.EndedAt = StateRecoveryRequired, failure, stamp(s.now())
	if w.Status == StateFailed {
		node.Status = StateFailed
	} else if w.CancelRequestedAt != "" || w.Status == StateCancelled {
		node.Status = StateCancelled
	}
	if err := saveWorkflowNode(ctx, tx, node); err != nil {
		return err
	}
	if w.CancelRequestedAt != "" {
		return s.refreshWorkflowV2(ctx, tx, w)
	}
	if w.GateClosed || state.Terminal(w.Status) {
		return s.workflowEvent(ctx, tx, w, "workflow/node-failed", node.ID+":"+failure.Code)
	}
	if failure.Code == "workflow-budget" || failure.Code == "approval-denied" {
		return s.failWorkflowV2Budget(ctx, tx, w, nil, failure)
	}
	w.GateClosed, w.Status, w.Error, w.CurrentStepID, w.ActiveRunID = true, StateRecoveryRequired, failure, node.ID, node.RunID
	if w.CancelRequestedAt != "" {
		w.Status, w.EndedAt = StateCancelled, stamp(s.now())
	}
	if failure.Code == "approval-denied" || failure.Code == "workflow-budget" {
		w.Status, w.EndedAt = StateFailed, stamp(s.now())
	}
	return s.workflowEvent(ctx, tx, w, "workflow/"+w.Status, failure.Message)
}

func (s *store) refreshWorkflowV2(ctx context.Context, tx *sql.Tx, w *WorkflowInstance) error {
	prior, err := readWorkflow(ctx, tx, w.ID)
	if err != nil {
		return err
	}
	if w.CancelRequestedAt != "" && !state.Terminal(w.Status) {
		var running int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE workflow_id=? AND state='running'", w.ID).Scan(&running); err != nil {
			return err
		}
		if running == 0 {
			w.Status, w.EndedAt, w.ActiveRunID = StateCancelled, stamp(s.now()), ""
			scopes, err := readDocuments[WorkflowScope](ctx, tx, "SELECT document FROM workflow_scopes WHERE workflow_id=? AND state<>'succeeded'", w.ID)
			if err != nil {
				return err
			}
			for _, scope := range scopes {
				scope.Status, scope.EndedAt = StateCancelled, w.EndedAt
				if err = saveWorkflowScope(ctx, tx, scope); err != nil {
					return err
				}
			}
		} else {
			w.Status = StateRunning
		}
	}
	// A failure is a gate: already dispatched siblings may record facts but can
	// never reopen the instance by subsequently succeeding.
	if !state.Terminal(w.Status) && !w.GateClosed {
		nodes, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state IN ('ready','queued','running','waiting-approval','waiting-resource','waiting-task') ORDER BY rowid", w.ID)
		if err != nil {
			return err
		}
		w.Status, w.ActiveRunID = StateReady, ""
		for _, node := range nodes {
			if node.RunID == "" {
				continue
			}
			if w.ActiveRunID == "" || node.Status == StateRunning || (node.Status == StateQueued && w.Status != StateRunning) {
				w.Status, w.ActiveRunID, w.CurrentStepID = node.Status, node.RunID, node.ID
			}
		}
		w.ReadyAt = stamp(s.now())
	}
	if prior.Status == w.Status && prior.ActiveRunID == w.ActiveRunID && prior.CurrentStepID == w.CurrentStepID && prior.OutputJSON == w.OutputJSON && prior.GateClosed == w.GateClosed {
		return nil
	}
	if err := s.workflowEvent(ctx, tx, w, "workflow/"+w.Status, ""); err != nil {
		return err
	}
	return s.releaseWorkflowSession(ctx, tx, *w)
}

func workflowV2StepForRun(ctx context.Context, q workflowQuery, r Run) (WorkflowScope, WorkflowNodeExecution, WorkflowStepDefinition, error) {
	node, err := readWorkflowNode(ctx, q, r.WorkflowStepID)
	if err != nil {
		return WorkflowScope{}, node, WorkflowStepDefinition{}, err
	}
	if node.WorkflowID != r.WorkflowID || node.TaskID != r.TaskID || node.RunID != r.ID {
		return WorkflowScope{}, node, WorkflowStepDefinition{}, bad("workflow-node-mismatch", "运行与工作流节点身份不符")
	}
	scope, err := readWorkflowScope(ctx, q, node.ScopeID)
	if err != nil {
		return scope, node, WorkflowStepDefinition{}, err
	}
	step, err := state.WorkflowScopeStep(scope, node.StepID)
	return scope, node, step, err
}

func workflowScopeOutputs(ctx context.Context, q workflowTreeQuery, scopeID string) (map[string]string, error) {
	nodes, err := readDocuments[WorkflowNodeExecution](ctx, q, "SELECT document FROM workflow_nodes WHERE scope_id=? AND state='succeeded' ORDER BY rowid", scopeID)
	if err != nil {
		return nil, err
	}
	outputs := map[string]string{}
	for _, node := range nodes {
		outputs[node.StepID] = node.OutputJSON
	}
	return outputs, nil
}

func (s *store) failWorkflowV2Budget(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, current *Run, failure *Failure) error {
	endedAt := stamp(s.now())
	w.GateClosed, w.Status, w.Error, w.EndedAt = true, StateFailed, failure, endedAt
	if err := s.workflowEvent(ctx, tx, w, "workflow/failed", failure.Message); err != nil {
		return err
	}
	approvals, err := readDocuments[Approval](ctx, tx, "SELECT a.document FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.workflow_id=? AND a.state IN ('pending','approved')", w.ID)
	if err != nil {
		return err
	}
	for _, approval := range approvals {
		approval.Status = "revoked"
		if err = saveApproval(ctx, tx, approval); err != nil {
			return err
		}
	}
	runs, err := readDocuments[Run](ctx, tx, "SELECT document FROM runs WHERE workflow_id=? AND state IN ('queued','running','waiting-approval','waiting-resource','waiting-task','recovery-required')", w.ID)
	if err != nil {
		return err
	}
	for _, run := range runs {
		if run.Status == StateRunning && (current == nil || current.ID != run.ID) {
			run.CancelRequestedAt, run.Error = endedAt, failure
			if err = s.event(ctx, tx, &run, "run/cancel-requested", "", nil, failure); err != nil {
				return err
			}
			continue
		}
		if current != nil && current.ID == run.ID {
			run = *current
		}
		run.Status, run.EndReason, run.Error, run.EndedAt, run.MemoryStatus = StateFailed, failure.Code, failure, endedAt, "stale"
		if err = s.event(ctx, tx, &run, "run/failed", "", nil, failure); err != nil {
			return err
		}
		a, err := readWorkflowAttempt(ctx, tx, run.ID)
		if err != nil {
			return err
		}
		a.Status, a.EndedAt, a.EventSeq = StateFailed, endedAt, run.LastSeq
		if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
			return err
		}
		if err = releaseWaitingResourceLeases(ctx, tx, run.ID, endedAt); err != nil {
			return err
		}
		if current != nil && current.ID == run.ID {
			*current = run
		}
	}
	nodes, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state NOT IN ('succeeded','skipped','cancelled','failed')", w.ID)
	if err != nil {
		return err
	}
	for _, node := range nodes {
		if node.RunID != "" {
			run, err := readRun(ctx, tx, node.RunID)
			if err != nil {
				return err
			}
			if run.Status == StateRunning {
				continue
			}
		}
		node.Status, node.Error, node.EndedAt = StateFailed, failure, endedAt
		if err = saveWorkflowNode(ctx, tx, &node); err != nil {
			return err
		}
	}
	scopes, err := readDocuments[WorkflowScope](ctx, tx, "SELECT document FROM workflow_scopes WHERE workflow_id=? AND state<>'succeeded'", w.ID)
	if err != nil {
		return err
	}
	for _, scope := range scopes {
		scope.Status, scope.EndedAt = StateFailed, endedAt
		if err = saveWorkflowScope(ctx, tx, scope); err != nil {
			return err
		}
	}
	return s.releaseWorkflowSession(ctx, tx, *w)
}

// Completed execution facts are retained even if withdrawal races with result
// delivery. They are marked invalid and cannot become a subsequent input.

func latestMemory(ctx context.Context, q workflowQuery, task string) (WorkingMemory, error) {
	var v WorkingMemory
	var raw string
	err := q.QueryRowContext(ctx, "SELECT document FROM working_memories WHERE task_id=? ORDER BY revision DESC LIMIT 1", task).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return v, nil
	}
	if err == nil {
		err = json.Unmarshal([]byte(raw), &v)
	}
	return v, err
}

func nullableWorkflowString(v string) any {
	if v == "" {
		return nil
	}
	return v
}

func (s *store) releaseWorkflowSession(ctx context.Context, tx *sql.Tx, w WorkflowInstance) error {
	session, err := readSession(ctx, tx, w.SessionID)
	if err != nil {
		return err
	}
	session.ActiveRunID = w.ActiveRunID
	if state.Terminal(w.Status) {
		session.ActiveRunID = ""
		session.ActiveWorkflowID = ""
		if state.WorkflowV2(w) {
			var running string
			err := tx.QueryRowContext(ctx, "SELECT id FROM runs WHERE workflow_id=? AND state='running' ORDER BY rowid LIMIT 1", w.ID).Scan(&running)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if running != "" {
				session.ActiveRunID, session.ActiveWorkflowID = running, w.ID
			}
		}
	}
	session.LastActivityAt = stamp(s.now())
	return saveSession(ctx, tx, session)
}
