package harness

import (
	"archive/tar"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"

	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/jsonvalue"
)

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
		return &Error{409, "node-revision-conflict", "工作流节点版本已变化"}
	}
	return err
}

func readWorkflowExecutionTree(ctx context.Context, q workflowTreeQuery, w WorkflowInstance) (WorkflowExecutionTree, error) {
	tree := WorkflowExecutionTree{RootScopeID: w.RootScopeID, Scopes: []WorkflowScope{}, Nodes: []WorkflowNodeExecution{}}
	var err error
	tree.Scopes, err = readDocuments[WorkflowScope](ctx, q, "SELECT document FROM workflow_scopes WHERE workflow_id=? ORDER BY rowid", w.ID)
	if err == nil {
		tree.Nodes, err = readDocuments[WorkflowNodeExecution](ctx, q, "SELECT document FROM workflow_nodes WHERE workflow_id=? ORDER BY rowid", w.ID)
	}
	return tree, err
}

func workflowScopeStep(scope WorkflowScope, id string) (WorkflowStepDefinition, error) {
	return workflowStep(WorkflowDefinition{Steps: scope.Body.Steps}, id)
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
	step, err := workflowScopeStep(scope, node.StepID)
	return scope, node, step, err
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
	return createWorkflowV2Scope(ctx, tx, WorkflowScope{ID: w.RootScopeID, WorkflowID: w.ID, Path: "root", Kind: "root", TaskID: w.TaskID, Status: StateReady, CurrentStepID: d.Entry, InputJSON: w.InputJSON, Body: workflowBody(d), CreatedAt: w.CreatedAt}, newID)
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

// The caller holds Manager.mu. Expansion, the join receipt, and successor
// readiness commit together; rerunning promotion cannot create duplicate work.
func (m *Manager) promoteWorkflowV2(ctx context.Context, candidate WorkflowInstance) error {
	prepared := []workspace.Version{}
	err := m.store.write(ctx, "workflow-v2-promote", func(tx *sql.Tx) error {
		w, err := readWorkflow(ctx, tx, candidate.ID)
		if err != nil || terminal(w.Status) || w.GateClosed || w.CancelRequestedAt != "" {
			return err
		}
		if err = m.checkWorkflowEnvironmentTx(ctx, tx, w); err != nil {
			var issue *Error
			if !errors.As(err, &issue) {
				return err
			}
			w.GateClosed, w.Status, w.Error = true, StateRecoveryRequired, &Failure{Code: issue.Code, Message: issue.Message}
			return m.store.workflowEvent(ctx, tx, &w, "workflow/recovery-required", issue.Message)
		}
		// At most 256 nodes exist; each pass expands or completes at least one.
		for pass := 0; pass <= workflowV2MaxNodes; pass++ {
			changed := false
			nodes, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state IN ('ready','running') ORDER BY rowid", w.ID)
			if err != nil {
				return err
			}
			for _, node := range nodes {
				if node.Kind != "parallel" && node.Kind != "foreach" && node.Kind != "subworkflow" {
					continue
				}
				scope, err := readWorkflowScope(ctx, tx, node.ScopeID)
				if err != nil {
					return err
				}
				step, err := workflowScopeStep(scope, node.StepID)
				if err != nil {
					return err
				}
				originalNode, originalWorkflow, preparedCount := node, w, len(prepared)
				if _, err = tx.ExecContext(ctx, "SAVEPOINT workflow_node_transition"); err != nil {
					return err
				}
				if !node.Expanded {
					if node.Attempt >= w.Limits.Attempts {
						err = bad("attempt-budget", "复合节点尝试次数已耗尽")
					} else {
						node.Attempt++
						err = m.expandWorkflowV2Node(ctx, tx, &w, scope, &node, step, &prepared)
					}
					changed = true
				} else {
					var joined bool
					joined, err = m.joinWorkflowV2Node(ctx, tx, &w, scope, &node, step, &prepared)
					changed = changed || joined
				}
				if err != nil {
					var workspaceIssue *workspace.Error
					if errors.As(err, &workspaceIssue) {
						err = &Error{Status: workspaceIssue.Status, Code: workspaceIssue.Code, Message: workspaceIssue.Message}
					}
					var issue *Error
					if !errors.As(err, &issue) {
						return err
					}
					if _, rollbackErr := tx.ExecContext(ctx, "ROLLBACK TO workflow_node_transition"); rollbackErr != nil {
						return rollbackErr
					}
					if _, releaseErr := tx.ExecContext(ctx, "RELEASE workflow_node_transition"); releaseErr != nil {
						return releaseErr
					}
					for _, version := range prepared[preparedCount:] {
						if m.deps.Workspaces != nil {
							_ = m.deps.Workspaces.Discard(context.Background(), version.TaskID, version.Revision)
						}
					}
					prepared = prepared[:preparedCount]
					node, w = originalNode, originalWorkflow
					if !node.Expanded && node.Attempt < w.Limits.Attempts {
						node.Attempt++
					}
					return m.store.failWorkflowV2Node(ctx, tx, &w, &node, &Failure{Code: issue.Code, Message: issue.Message})
				}
				if _, err = tx.ExecContext(ctx, "RELEASE workflow_node_transition"); err != nil {
					return err
				}
				if terminal(w.Status) || w.GateClosed {
					return m.store.releaseWorkflowSession(ctx, tx, w)
				}
			}
			if !changed {
				break
			}
		}
		nodes, err := readDocuments[WorkflowNodeExecution](ctx, tx, "SELECT document FROM workflow_nodes WHERE workflow_id=? AND state='ready' ORDER BY rowid", w.ID)
		if err != nil {
			return err
		}
		var queued int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(&queued); err != nil {
			return err
		}
		for _, node := range nodes {
			if queued >= m.deps.Limits.QueueCapacity {
				break
			}
			originalNode, originalWorkflow := node, w
			if _, err = tx.ExecContext(ctx, "SAVEPOINT workflow_leaf_transition"); err != nil {
				return err
			}
			if err = m.queueWorkflowV2Leaf(ctx, tx, &w, &node); err != nil {
				var issue *Error
				if !errors.As(err, &issue) {
					return err
				}
				if _, err = tx.ExecContext(ctx, "ROLLBACK TO workflow_leaf_transition"); err != nil {
					return err
				}
				if _, err = tx.ExecContext(ctx, "RELEASE workflow_leaf_transition"); err != nil {
					return err
				}
				node, w = originalNode, originalWorkflow
				if node.Attempt < w.Limits.Attempts {
					node.Attempt++
				}
				return m.store.failWorkflowV2Node(ctx, tx, &w, &node, &Failure{Code: issue.Code, Message: issue.Message})
			}
			if _, err = tx.ExecContext(ctx, "RELEASE workflow_leaf_transition"); err != nil {
				return err
			}
			queued++
			if w.GateClosed {
				break
			}
		}
		return m.store.refreshWorkflowV2(ctx, tx, &w)
	})
	m.discardPreparedCandidates(err, prepared)
	return err
}

// discardPreparedCandidates 只在错误确属「事务已回滚」时丢弃候选工作区版本；
// 提交结果未确认的错误必须保留候选——数据库指针可能已经引用它们，删掉归档
// 会让落库指针指向不存在的版本。保留的候选由会话级联清理（workspace_cleanup
// → RemoveTask）在任务生命周期结束时自然回收。
func (m *Manager) discardPreparedCandidates(err error, prepared []workspace.Version) {
	if err == nil || m.deps.Workspaces == nil || commitUnconfirmed(err) {
		return
	}
	for _, version := range prepared {
		_ = m.deps.Workspaces.Discard(context.Background(), version.TaskID, version.Revision)
	}
}

func (m *Manager) checkWorkflowEnvironmentTx(ctx context.Context, tx *sql.Tx, w WorkflowInstance) error {
	for _, group := range []struct {
		kind string
		refs []RevisionRef
	}{{"skill", w.Snapshot.Environment.Skills}, {"mcp", w.Snapshot.Environment.Servers}, {"execution-profile", w.Snapshot.Environment.ExecutionProfiles}, {"grant", w.Snapshot.Environment.Grants}} {
		for _, ref := range group.refs {
			var count int
			if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM capability_revocations WHERE kind=? AND id=? AND (revision=0 OR revision=?)", group.kind, ref.ID, ref.Revision).Scan(&count); err != nil {
				return err
			}
			if count != 0 {
				return &Error{409, "capability-revoked", "流程固定环境包含已撤销授权，不能继续执行"}
			}
		}
	}
	return nil
}

func (m *Manager) expandWorkflowV2Node(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, scope WorkflowScope, node *WorkflowNodeExecution, step WorkflowStepDefinition, prepared *[]workspace.Version) error {
	parentSources, err := workflowScopeWikiSources(ctx, tx, scope)
	if err != nil {
		return err
	}
	if err = saveWorkflowWikiArtifact(ctx, tx, "workflow-node", node.ID, scope.TaskID, parentSources); err != nil {
		return err
	}
	outputs, err := workflowScopeOutputs(ctx, tx, scope.ID)
	if err != nil {
		return err
	}
	node.InputJSON, err = evaluateWorkflowBinding(step.Input, scope.InputJSON, outputs)
	if err != nil {
		return err
	}
	parentVersion, err := readWorkspaceVersion(ctx, tx, scope.TaskID)
	if err != nil {
		return err
	}
	parentMemory, err := latestMemory(ctx, tx, scope.TaskID)
	if err != nil {
		return err
	}
	type child struct {
		key, input string
		body       WorkflowBody
	}
	children := []child{}
	switch step.Kind {
	case "parallel":
		for _, branch := range step.Parallel.Branches {
			input, e := evaluateWorkflowBinding(branch.Input, node.InputJSON, nil)
			if e != nil {
				return e
			}
			children = append(children, child{branch.ID, input, branch.Body})
		}
	case "foreach":
		raw, e := evaluateWorkflowBinding(step.Foreach.Items, node.InputJSON, nil)
		if e != nil {
			return e
		}
		value, e := jsonvalue.Decode([]byte(raw))
		if e != nil {
			return e
		}
		items, ok := value.([]any)
		if !ok || len(items) > workflowV2MaxForeach {
			return bad("workflow-foreach-limit", "foreach items 必须为不超过 32 项的数组")
		}
		for i, item := range items {
			encoded, e := json.Marshal(item)
			if e != nil {
				return e
			}
			children = append(children, child{strconv.Itoa(i), string(encoded), step.Foreach.Body})
		}
	case "subworkflow":
		var definition *WorkflowDefinition
		for i := range w.Definitions {
			d := &w.Definitions[i]
			if d.ID == step.Subworkflow.DefinitionID && d.Revision == step.Subworkflow.DefinitionRevision {
				definition = d
				break
			}
		}
		if definition == nil {
			return bad("workflow-closure-missing", "固定模板闭包中缺少子流程修订")
		}
		if err = validateWorkflowJSON(definition.InputSchemaJSON, node.InputJSON); err != nil {
			return err
		}
		children = append(children, child{"subworkflow", node.InputJSON, workflowBody(*definition)})
	default:
		return bad("workflow-kind", "不是复合工作流步骤")
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_nodes WHERE workflow_id=?", w.ID).Scan(&count); err != nil {
		return err
	}
	for _, child := range children {
		count += len(child.body.Steps)
	}
	if scope.Depth+1 > workflowV2MaxDepth || count > workflowV2MaxNodes {
		return bad("workflow-expansion-limit", "工作流展开超过 4 层或 256 个节点上限")
	}
	rootTask, err := readTask(ctx, tx, w.TaskID)
	if err != nil {
		return err
	}
	for ordinal, child := range children {
		task := Task{ID: m.deps.NewID(), RequestID: "workflow-scope:" + m.deps.NewID(), SessionID: w.SessionID, Kind: "workflow", DriverVersion: WorkflowV2LanguageVersion, Goal: rootTask.Goal + "\n当前工作流分支：" + node.StableKey + "/" + child.key, CreatedAt: stamp(m.deps.Now()), Steps: []Step{}}
		raw, err := json.Marshal(task)
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO tasks(id,request_id,input,document,session_id) VALUES(?,?,?,?,?)", task.ID, task.RequestID, child.input, string(raw), w.SessionID); err != nil {
			return err
		}
		childScope := WorkflowScope{ID: m.deps.NewID(), WorkflowID: w.ID, ParentScopeID: scope.ID, ParentNodeID: node.ID, Path: node.StableKey + "/" + child.key, Kind: step.Kind, TaskID: task.ID, ParentWorkspaceRevision: parentVersion.Revision, ParentMemoryRevision: parentMemory.Revision, Depth: scope.Depth + 1, Ordinal: ordinal, Status: StateReady, CurrentStepID: child.body.Entry, InputJSON: child.input, Body: child.body, CreatedAt: task.CreatedAt}
		if err = createWorkflowV2Scope(ctx, tx, childScope, m.deps.NewID); err != nil {
			return err
		}
		if err = saveWorkflowWikiArtifact(ctx, tx, "workflow-scope", childScope.ID, task.ID, parentSources); err != nil {
			return err
		}
		if parentMemory.Revision > 0 {
			memory := parentMemory
			memory.TaskID, memory.Revision, memory.Coverage = task.ID, 1, MemoryCursor{}
			if err = saveWorkingMemory(ctx, tx, memory); err != nil {
				return err
			}
			if err = saveWorkflowWikiArtifact(ctx, tx, "memory", task.ID+":1", task.ID, parentSources); err != nil {
				return err
			}
		}
		if parentVersion.Revision > 0 {
			if m.deps.Workspaces == nil {
				return bad("workspace-unavailable", "无法复制父工作区")
			}
			version, e := m.copyWorkflowWorkspace(ctx, parentVersion, task.ID)
			if e != nil {
				return e
			}
			*prepared = append(*prepared, version)
			if err = commitWorkspaceVersion(ctx, tx, version); err != nil {
				return err
			}
			if err = saveWorkflowWikiArtifact(ctx, tx, "workspace", task.ID+":"+strconv.Itoa(version.Revision), task.ID, parentSources); err != nil {
				return err
			}
		}
	}
	node.Expanded, node.Status, node.JoinWorkspaceRevision = true, StateRunning, parentVersion.Revision
	if err = saveWorkflowNode(ctx, tx, node); err != nil {
		return err
	}
	scope.Status = StateRunning
	if err = saveWorkflowScope(ctx, tx, scope); err != nil {
		return err
	}
	return m.store.workflowEvent(ctx, tx, w, "workflow/expanded", node.ID)
}

func (m *Manager) queueWorkflowV2Leaf(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, node *WorkflowNodeExecution) error {
	scope, err := readWorkflowScope(ctx, tx, node.ScopeID)
	if err != nil {
		return err
	}
	step, err := workflowScopeStep(scope, node.StepID)
	if err != nil {
		return err
	}
	sources, err := workflowScopeWikiSources(ctx, tx, scope)
	if err != nil {
		var issue *Error
		if errors.As(err, &issue) {
			return m.store.failWorkflowV2Node(ctx, tx, w, node, &Failure{Code: issue.Code, Message: issue.Message})
		}
		return err
	}
	if node.Kind == "parallel" || node.Kind == "foreach" || node.Kind == "subworkflow" {
		return bad("workflow-unexpanded", "复合节点尚未展开")
	}
	outputs, err := workflowScopeOutputs(ctx, tx, scope.ID)
	if err != nil {
		return err
	}
	input, bindingErr := evaluateWorkflowBinding(step.Input, scope.InputJSON, outputs)
	if node.Attempt >= w.Limits.Attempts {
		return m.store.failWorkflowV2Node(ctx, tx, w, node, &Failure{Code: "attempt-budget", Message: "节点尝试次数已耗尽"})
	}
	var number int
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(run_number),0)+1 FROM runs WHERE task_id=?", scope.TaskID).Scan(&number); err != nil {
		return err
	}
	session, err := readSession(ctx, tx, w.SessionID)
	if err != nil {
		return err
	}
	memory, err := latestMemory(ctx, tx, scope.TaskID)
	if err != nil {
		return err
	}
	driver := "workflow-control"
	if step.Kind == "agent" || step.Kind == "operation" {
		driver = step.Kind
	}
	node.Attempt++
	// 作用域与节点身份是分支隔离过滤的生效前提：兄弟公开消息与跨 scope
	// 完成资料都依赖 Run.ScopeID 非空才会被排除（v1 单链运行保持为空）。
	run := Run{ID: m.deps.NewID(), TaskID: scope.TaskID, SessionID: w.SessionID, RequestID: "workflow-node:" + m.deps.NewID(), RunNumber: number, Driver: driver, DriverVersion: "v2", ScopeID: scope.ID, NodeID: node.ID, Snapshot: &w.Snapshot, Model: &w.Model, WorkflowID: w.ID, WorkflowStepID: node.ID, WorkflowAttempt: node.Attempt, WorkflowOutputSchemaJSON: step.OutputSchemaJSON, Status: StateQueued, CreatedAt: stamp(m.deps.Now()), LastSeq: "0", HistorySeq: session.LastSeq, InitialMemoryRevision: memory.Revision, Input: input, Limits: m.deps.AgentLimits, Phase: "queued", MemoryStatus: "stale", Selection: step.Selection}
	prepareWorkflowRunLoading(&run)
	if step.Kind == "agent" {
		run.Input = step.Instruction + "\n步骤输入（数据）：\n" + input
	}
	if bindingErr != nil {
		run.Status, run.Phase, run.EndedAt, run.EndReason = StateFailed, "completed", run.CreatedAt, "workflow-binding"
		run.Error = &Failure{Code: "workflow-binding", Message: "节点输入引用不存在或无效"}
	}
	raw, err := json.Marshal(run)
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO runs(id,task_id,state,created_at,document,session_id,request_id,canonical_input,run_number,workflow_id) VALUES(?,?,?,?,?,?,?,?,?,?)`, run.ID, run.TaskID, run.Status, run.CreatedAt, string(raw), run.SessionID, run.RequestID, input, number, w.ID); err != nil {
		return err
	}
	if err = snapshotWikiRunSpaces(ctx, tx, run.ID, run.SessionID); err != nil {
		return err
	}
	if err = saveWorkflowWikiArtifact(ctx, tx, "run", run.ID, run.TaskID, sources); err != nil {
		return err
	}
	node.RunID, node.Status, node.InputJSON = run.ID, run.Status, input
	if err = saveWorkflowNode(ctx, tx, node); err != nil {
		return err
	}
	a := WorkflowAttempt{WorkflowID: w.ID, StepID: node.ID, Number: node.Attempt, RunID: run.ID, RunNumber: number, Status: run.Status, InputJSON: input, CreatedAt: run.CreatedAt, ScopeID: scope.ID, NodeID: node.ID, Iteration: scope.Ordinal, ExpectedRevision: node.Revision}
	if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
		return err
	}
	scope.Status = StateRunning
	if err = saveWorkflowScope(ctx, tx, scope); err != nil {
		return err
	}
	if err = m.store.event(ctx, tx, &run, "run/"+run.Status, "", nil, run.Error); err != nil {
		return err
	}
	if bindingErr != nil {
		if err = m.store.finishWorkflowV2Run(ctx, tx, &run); err != nil {
			return err
		}
	}
	*w, err = readWorkflow(ctx, tx, w.ID)
	return err
}

func (s *store) syncWorkflowV2Run(ctx context.Context, tx *sql.Tx, r *Run) error {
	_, node, _, err := workflowV2StepForRun(ctx, tx, *r)
	if err != nil {
		return err
	}
	if terminal(node.Status) || node.Status == StateRecoveryRequired {
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
		err = validateWorkflowJSON(step.OutputSchemaJSON, output)
	}
	if err != nil {
		return err
	}
	if err = saveWorkflowAttempt(ctx, tx, a); err != nil {
		return err
	}
	invalidSource, err := recordWorkflowV2RunOutput(ctx, tx, *r, node)
	if err != nil {
		return err
	}
	node.OutputJSON, node.EndedAt, node.Status = output, r.EndedAt, StateSucceeded
	if err = saveWorkflowNode(ctx, tx, &node); err != nil {
		return err
	}
	if invalidSource {
		return s.failWorkflowV2Node(ctx, tx, &w, &node, &Failure{Code: "wiki-context-invalidated", Message: "已完成结果的来源已撤回，保留事实但停止后续推进"})
	}
	if !terminal(w.Status) {
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
		output, err := evaluateWorkflowBinding(*step.Finish, scope.InputJSON, outputs)
		if err == nil {
			err = validateWorkflowJSON(scope.Body.OutputSchemaJSON, output)
		}
		if err != nil {
			return s.failWorkflowV2Node(ctx, tx, w, &node, &Failure{Code: "workflow-output", Message: "作用域最终输出不符合固定契约"})
		}
		refs, err := workflowScopeWikiSources(ctx, tx, *scope)
		if err == nil {
			err = saveWorkflowWikiArtifact(ctx, tx, "workflow-scope", scope.ID, scope.TaskID, refs)
		}
		if err != nil {
			var issue *Error
			if errors.As(err, &issue) {
				return s.failWorkflowV2Node(ctx, tx, w, &node, &Failure{Code: issue.Code, Message: issue.Message})
			}
			return err
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
	if w.GateClosed || terminal(w.Status) {
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
	if w.CancelRequestedAt != "" && !terminal(w.Status) {
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
	if !terminal(w.Status) && !w.GateClosed {
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

func (m *Manager) joinWorkflowV2Node(ctx context.Context, tx *sql.Tx, w *WorkflowInstance, scope WorkflowScope, node *WorkflowNodeExecution, step WorkflowStepDefinition, prepared *[]workspace.Version) (bool, error) {
	children, err := readDocuments[WorkflowScope](ctx, tx, "SELECT document FROM workflow_scopes WHERE parent_node_id=? ORDER BY ordinal", node.ID)
	if err != nil {
		return false, err
	}
	for _, child := range children {
		if child.Status != StateSucceeded {
			return false, nil
		}
	}
	artifacts := []workflowWikiArtifact{{"workflow-node", node.ID}}
	for _, child := range children {
		artifacts = append(artifacts, workflowWikiArtifact{"workflow-scope", child.ID})
	}
	sources, err := workflowWikiSources(ctx, tx, artifacts)
	if err != nil {
		return false, err
	}
	if err = saveWorkflowWikiArtifact(ctx, tx, "workflow-node", node.ID, node.TaskID, sources); err != nil {
		return false, err
	}
	var value any
	switch node.Kind {
	case "parallel":
		out := map[string]json.RawMessage{}
		if len(children) != len(step.Parallel.Branches) {
			return false, bad("workflow-join-incomplete", "并行分支数量与固定模板不符")
		}
		for i, child := range children {
			out[step.Parallel.Branches[i].ID] = json.RawMessage(child.OutputJSON)
		}
		value = out
	case "foreach":
		out := make([]json.RawMessage, len(children))
		for i, child := range children {
			out[i] = json.RawMessage(child.OutputJSON)
		}
		value = out
	case "subworkflow":
		if len(children) != 1 {
			return false, bad("workflow-join-incomplete", "子流程数量与固定模板不符")
		}
		value = json.RawMessage(children[0].OutputJSON)
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return false, err
	}
	if err = validateWorkflowJSON(step.OutputSchemaJSON, string(raw)); err != nil {
		return false, err
	}
	parentVersion, err := readWorkspaceVersion(ctx, tx, scope.TaskID)
	if err != nil {
		return false, err
	}
	if parentVersion.Revision != node.JoinWorkspaceRevision {
		return false, workspaceConflict()
	}
	if err = m.joinWorkflowWorkspaces(ctx, tx, parentVersion, node.ID, children, prepared); err != nil {
		return false, err
	}
	node.OutputJSON, node.Status, node.EndedAt = string(raw), StateSucceeded, stamp(m.deps.Now())
	if err = saveWorkflowNode(ctx, tx, node); err != nil {
		return false, err
	}
	if err = m.store.advanceWorkflowV2Scope(ctx, tx, w, &scope, *node, step, ""); err != nil {
		return false, err
	}
	return true, m.store.workflowEvent(ctx, tx, w, "workflow/joined", node.ID)
}

func workflowArchiveFile() (*os.File, func(), error) {
	f, err := os.CreateTemp("", "elysian-workflow-*.tar")
	if err != nil {
		return nil, nil, err
	}
	return f, func() { _ = f.Close(); _ = os.Remove(f.Name()) }, nil
}

func (m *Manager) copyWorkflowWorkspace(ctx context.Context, source workspace.Version, target string) (workspace.Version, error) {
	f, cleanup, err := workflowArchiveFile()
	if err != nil {
		return workspace.Version{}, err
	}
	defer cleanup()
	actual, err := m.deps.Workspaces.Export(ctx, source.TaskID, source.Revision, f)
	if err != nil {
		return workspace.Version{}, err
	}
	if actual != source {
		return workspace.Version{}, workspaceConflict()
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return workspace.Version{}, err
	}
	return m.deps.Workspaces.PrepareImport(ctx, target, 0, f)
}

// Join keeps all parent files. A branch only publishes additions and changes in
// a stable namespace; deletions and colliding sibling paths cannot erase data.
func (m *Manager) joinWorkflowWorkspaces(ctx context.Context, tx *sql.Tx, parent workspace.Version, nodeID string, children []WorkflowScope, prepared *[]workspace.Version) error {
	type childVersion struct {
		scope   WorkflowScope
		version workspace.Version
	}
	versions := []childVersion{}
	for _, child := range children {
		version, err := readWorkspaceVersion(ctx, tx, child.TaskID)
		if err != nil {
			return err
		}
		if version.Revision > 0 {
			versions = append(versions, childVersion{child, version})
		}
	}
	if len(versions) == 0 {
		return nil
	}
	artifacts := []workflowWikiArtifact{{"workspace", parent.TaskID + ":" + strconv.Itoa(parent.Revision)}, {"workflow-node", nodeID}}
	for _, child := range versions {
		artifacts = append(artifacts, workflowWikiArtifact{"workspace", child.version.TaskID + ":" + strconv.Itoa(child.version.Revision)})
	}
	sources, err := workflowWikiSources(ctx, tx, artifacts)
	if err != nil {
		return err
	}
	if m.deps.Workspaces == nil {
		return bad("workspace-unavailable", "无法汇合子任务工作区")
	}
	parentFiles, err := m.deps.Workspaces.List(ctx, parent.TaskID, parent.Revision)
	if err != nil {
		return err
	}
	baseline := map[string]string{}
	for _, file := range parentFiles.Files {
		baseline[file.Path] = file.Digest
	}
	output, cleanup, err := workflowArchiveFile()
	if err != nil {
		return err
	}
	defer cleanup()
	tw := tar.NewWriter(output)
	appendFiles := func(version workspace.Version, prefix string, include map[string]bool) error {
		f, done, e := workflowArchiveFile()
		if e != nil {
			return e
		}
		defer done()
		actual, e := m.deps.Workspaces.Export(ctx, version.TaskID, version.Revision, f)
		if e != nil {
			return e
		}
		if version.Revision > 0 && actual != version {
			return workspaceConflict()
		}
		if _, e = f.Seek(0, io.SeekStart); e != nil {
			return e
		}
		tr := tar.NewReader(f)
		for {
			header, e := tr.Next()
			if e == io.EOF {
				return nil
			}
			if e != nil {
				return e
			}
			if include != nil && !include[header.Name] {
				continue
			}
			header.Name = prefix + header.Name
			if e = tw.WriteHeader(header); e != nil {
				return e
			}
			if _, e = io.Copy(tw, tr); e != nil {
				return e
			}
		}
	}
	if err = appendFiles(parent, "", nil); err != nil {
		return err
	}
	changed := false
	for _, child := range versions {
		files, err := m.deps.Workspaces.List(ctx, child.version.TaskID, child.version.Revision)
		if err != nil {
			return err
		}
		include := map[string]bool{}
		for _, file := range files.Files {
			if digest, exists := baseline[file.Path]; !exists || digest != file.Digest {
				include[file.Path] = true
			}
		}
		if len(include) == 0 {
			continue
		}
		changed = true
		if err = appendFiles(child.version, fmt.Sprintf(".workflow/%s/%d/", nodeID, child.scope.Ordinal), include); err != nil {
			return err
		}
	}
	if err = tw.Close(); err != nil {
		return err
	}
	if !changed {
		return nil
	}
	if _, err = output.Seek(0, io.SeekStart); err != nil {
		return err
	}
	version, err := m.deps.Workspaces.PrepareImport(ctx, parent.TaskID, parent.Revision, output)
	if err != nil {
		return err
	}
	*prepared = append(*prepared, version)
	if err = commitWorkspaceVersion(ctx, tx, version); err != nil {
		return err
	}
	return saveWorkflowWikiArtifact(ctx, tx, "workspace", version.TaskID+":"+strconv.Itoa(version.Revision), version.TaskID, sources)
}
