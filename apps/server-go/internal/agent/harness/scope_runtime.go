package harness

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/jsonvalue"
)

func readWorkflowExecutionTree(ctx context.Context, q workflowTreeQuery, w WorkflowInstance) (WorkflowExecutionTree, error) {
	tree := WorkflowExecutionTree{RootScopeID: w.RootScopeID, Scopes: []WorkflowScope{}, Nodes: []WorkflowNodeExecution{}}
	var err error
	tree.Scopes, err = readView(ctx, q).WorkflowScopes(ctx, w.ID)
	if err == nil {
		tree.Nodes, err = readView(ctx, q).WorkflowNodes(ctx, w.ID)
	}
	return tree, err
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
	nodes, err := readView(ctx, q).WorkflowScopeNodes(ctx, scopeID)
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
	err := writeStore(m.store, ctx, "workflow-v2-promote", func(tx sessionstore.Tx) error {
		w, err := readWorkflow(ctx, tx, candidate.ID)
		if err != nil || state.Terminal(w.Status) || w.GateClosed || w.CancelRequestedAt != "" {
			return err
		}
		if err = m.checkWorkflowEnvironmentTx(ctx, tx, w); err != nil {
			var issue *Error
			if !errors.As(err, &issue) {
				return err
			}
			w.GateClosed, w.Status, w.Error = true, StateRecoveryRequired, &Failure{Code: issue.Code, Message: issue.Message}
			return tx.WorkflowEvent(ctx, &w, "workflow/recovery-required", issue.Message)
		}
		// At most 256 nodes exist; each pass expands or completes at least one.
		for pass := 0; pass <= workflowV2MaxNodes; pass++ {
			changed := false
			nodes, err := tx.SchedulableWorkflowNodes(ctx, w.ID)
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
				step, err := state.WorkflowScopeStep(scope, node.StepID)
				if err != nil {
					return err
				}
				originalNode, originalWorkflow, preparedCount := node, w, len(prepared)
				if _, err = tx.WakeWorkflowRuns(ctx); err != nil {
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
					if _, rollbackErr := tx.WakeWorkflowApprovals(ctx); rollbackErr != nil {
						return rollbackErr
					}
					if _, releaseErr := tx.WakeWorkflowOperations(ctx); releaseErr != nil {
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
					return tx.FailWorkflowV2Node(ctx, &w, &node, &Failure{Code: issue.Code, Message: issue.Message})
				}
				if _, err = tx.WakeWorkflowOperations(ctx); err != nil {
					return err
				}
				if state.Terminal(w.Status) || w.GateClosed {
					return tx.ReleaseWorkflowSession(ctx, w)
				}
			}
			if !changed {
				break
			}
		}
		nodes, err := tx.JoiningWorkflowNodes(ctx, w.ID)
		if err != nil {
			return err
		}
		var queued int
		if err = tx.QueuedRunCount(ctx, &queued); err != nil {
			return err
		}
		for _, node := range nodes {
			if queued >= m.deps.Limits.QueueCapacity {
				break
			}
			originalNode, originalWorkflow := node, w
			if _, err = tx.WakeWorkflowCalls(ctx); err != nil {
				return err
			}
			if err = m.queueWorkflowV2Leaf(ctx, tx, &w, &node); err != nil {
				var issue *Error
				if !errors.As(err, &issue) {
					return err
				}
				if _, err = tx.WakeWorkflowNodes(ctx); err != nil {
					return err
				}
				if _, err = tx.WakeWorkflowAttempts(ctx); err != nil {
					return err
				}
				node, w = originalNode, originalWorkflow
				if node.Attempt < w.Limits.Attempts {
					node.Attempt++
				}
				return tx.FailWorkflowV2Node(ctx, &w, &node, &Failure{Code: issue.Code, Message: issue.Message})
			}
			if _, err = tx.WakeWorkflowAttempts(ctx); err != nil {
				return err
			}
			queued++
			if w.GateClosed {
				break
			}
		}
		return tx.RefreshWorkflowV2(ctx, &w)
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

func (m *Manager) checkWorkflowEnvironmentTx(ctx context.Context, tx sessionstore.Tx, w WorkflowInstance) error {
	for _, group := range []struct {
		kind string
		refs []RevisionRef
	}{{"skill", w.Snapshot.Environment.Skills}, {"mcp", w.Snapshot.Environment.Servers}, {"execution-profile", w.Snapshot.Environment.ExecutionProfiles}, {"grant", w.Snapshot.Environment.Grants}} {
		for _, ref := range group.refs {
			var count int
			if err := tx.ExtensionRevoked(ctx, group.kind, ref.ID, ref.Revision, &count); err != nil {
				return err
			}
			if count != 0 {
				return &Error{Status: 409, Code: "capability-revoked", Message: "流程固定环境包含已撤销授权，不能继续执行"}
			}
		}
	}
	return nil
}

func (m *Manager) expandWorkflowV2Node(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, scope WorkflowScope, node *WorkflowNodeExecution, step WorkflowStepDefinition, prepared *[]workspace.Version) error {
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
	node.InputJSON, err = state.EvaluateWorkflowBinding(step.Input, scope.InputJSON, outputs)
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
	children := []workflowChildPlan{}
	switch step.Kind {
	case "parallel":
		for _, branch := range step.Parallel.Branches {
			input, e := state.EvaluateWorkflowBinding(branch.Input, node.InputJSON, nil)
			if e != nil {
				return e
			}
			children = append(children, workflowChildPlan{branch.ID, input, branch.Body})
		}
	case "foreach":
		raw, e := state.EvaluateWorkflowBinding(step.Foreach.Items, node.InputJSON, nil)
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
			children = append(children, workflowChildPlan{strconv.Itoa(i), string(encoded), step.Foreach.Body})
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
		if err = state.ValidateWorkflowJSON(definition.InputSchemaJSON, node.InputJSON); err != nil {
			return err
		}
		children = append(children, workflowChildPlan{"subworkflow", node.InputJSON, state.DefinitionBody(*definition)})
	default:
		return bad("workflow-kind", "不是复合工作流步骤")
	}
	var count int
	if err = tx.WorkflowNodeCount(ctx, w.ID, &count); err != nil {
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
		if _, err = tx.InsertWorkflowTask(ctx, task.ID, task.RequestID, child.input, string(raw), w.SessionID); err != nil {
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
	return tx.WorkflowEvent(ctx, w, "workflow/expanded", node.ID)
}

type workflowChildPlan struct {
	key, input string
	body       WorkflowBody
}

func (m *Manager) queueWorkflowV2Leaf(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, node *WorkflowNodeExecution) error {
	scope, err := readWorkflowScope(ctx, tx, node.ScopeID)
	if err != nil {
		return err
	}
	step, err := state.WorkflowScopeStep(scope, node.StepID)
	if err != nil {
		return err
	}
	sources, err := workflowScopeWikiSources(ctx, tx, scope)
	if err != nil {
		var issue *Error
		if errors.As(err, &issue) {
			return tx.FailWorkflowV2Node(ctx, w, node, &Failure{Code: issue.Code, Message: issue.Message})
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
	input, bindingErr := state.EvaluateWorkflowBinding(step.Input, scope.InputJSON, outputs)
	if node.Attempt >= w.Limits.Attempts {
		return tx.FailWorkflowV2Node(ctx, w, node, &Failure{Code: "attempt-budget", Message: "节点尝试次数已耗尽"})
	}
	var number int
	if err = tx.WorkflowRunCount(ctx, scope.TaskID, &number); err != nil {
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
	if _, err = tx.InsertWorkflowRun(ctx, run.ID, run.TaskID, run.Status, run.CreatedAt, string(raw), run.SessionID, run.RequestID, input, number, w.ID); err != nil {
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
	if err = tx.Event(ctx, &run, "run/"+run.Status, "", nil, run.Error); err != nil {
		return err
	}
	if bindingErr != nil {
		if err = tx.FinishWorkflowV2Run(ctx, &run); err != nil {
			return err
		}
	}
	*w, err = readWorkflow(ctx, tx, w.ID)
	return err
}

func (m *Manager) joinWorkflowV2Node(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance, scope WorkflowScope, node *WorkflowNodeExecution, step WorkflowStepDefinition, prepared *[]workspace.Version) (bool, error) {
	children, err := tx.ChildWorkflowScopes(ctx, node.ID)
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
	if err = state.ValidateWorkflowJSON(step.OutputSchemaJSON, string(raw)); err != nil {
		return false, err
	}
	parentVersion, err := readWorkspaceVersion(ctx, tx, scope.TaskID)
	if err != nil {
		return false, err
	}
	if parentVersion.Revision != node.JoinWorkspaceRevision {
		return false, state.WorkspaceConflict()
	}
	if err = m.joinWorkflowWorkspaces(ctx, tx, parentVersion, node.ID, children, prepared); err != nil {
		return false, err
	}
	node.OutputJSON, node.Status, node.EndedAt = string(raw), StateSucceeded, stamp(m.deps.Now())
	if err = saveWorkflowNode(ctx, tx, node); err != nil {
		return false, err
	}
	if err = tx.AdvanceWorkflowV2Scope(ctx, w, &scope, *node, step, ""); err != nil {
		return false, err
	}
	return true, tx.WorkflowEvent(ctx, w, "workflow/joined", node.ID)
}

func (m *Manager) copyWorkflowWorkspace(ctx context.Context, source workspace.Version, target string) (workspace.Version, error) {
	f, cleanup, err := workspaceArchiveFile("elysian-workflow-*.tar")
	if err != nil {
		return workspace.Version{}, err
	}
	defer cleanup()
	actual, err := m.deps.Workspaces.Export(ctx, source.TaskID, source.Revision, f)
	if err != nil {
		return workspace.Version{}, err
	}
	if actual != source {
		return workspace.Version{}, state.WorkspaceConflict()
	}
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return workspace.Version{}, err
	}
	return m.deps.Workspaces.PrepareImport(ctx, target, 0, f)
}

// Join keeps all parent files. A branch only publishes additions and changes in
// a stable namespace; deletions and colliding sibling paths cannot erase data.
func (m *Manager) joinWorkflowWorkspaces(ctx context.Context, tx sessionstore.Tx, parent workspace.Version, nodeID string, children []WorkflowScope, prepared *[]workspace.Version) error {
	versions := []workflowChildVersion{}
	for _, child := range children {
		version, err := readWorkspaceVersion(ctx, tx, child.TaskID)
		if err != nil {
			return err
		}
		if version.Revision > 0 {
			versions = append(versions, workflowChildVersion{child, version})
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
	output, cleanup, err := workspaceArchiveFile("elysian-workflow-*.tar")
	if err != nil {
		return err
	}
	defer cleanup()
	tw := tar.NewWriter(output)
	appendFiles := func(version workspace.Version, prefix string, include map[string]bool) error {
		f, done, e := workspaceArchiveFile("elysian-workflow-*.tar")
		if e != nil {
			return e
		}
		defer done()
		actual, e := m.deps.Workspaces.Export(ctx, version.TaskID, version.Revision, f)
		if e != nil {
			return e
		}
		if version.Revision > 0 && actual != version {
			return state.WorkspaceConflict()
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

type workflowChildVersion struct {
	scope   WorkflowScope
	version workspace.Version
}
