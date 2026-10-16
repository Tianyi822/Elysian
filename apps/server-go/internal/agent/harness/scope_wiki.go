package harness

import (
	"context"
	"database/sql"
	"strconv"
)

type workflowWikiArtifact struct{ kind, id string }

func workflowWikiSources(ctx context.Context, q wikiQuery, artifacts []workflowWikiArtifact) ([]WikiRef, error) {
	refs := []WikiRef{}
	for _, artifact := range artifacts {
		invalid, err := wikiArtifactInvalid(ctx, q, artifact.kind, artifact.id)
		if err != nil {
			return nil, err
		}
		if invalid {
			return nil, &Error{409, "wiki-context-invalidated", "工作流输入、工作记忆、文件或前序结果引用的 Wiki 来源已撤回"}
		}
		inherited, err := wikiArtifactRefs(ctx, q, artifact.kind, artifact.id)
		if err != nil {
			return nil, err
		}
		refs = mergeWikiRefs(refs, inherited)
	}
	return refs, validateWikiSources(ctx, q, refs)
}

func workflowScopeWikiSources(ctx context.Context, q workflowTreeQuery, scope WorkflowScope) ([]WikiRef, error) {
	artifacts := []workflowWikiArtifact{{"workflow-scope", scope.ID}}
	nodes, err := readDocuments[WorkflowNodeExecution](ctx, q, "SELECT document FROM workflow_nodes WHERE scope_id=? AND state='succeeded' ORDER BY rowid", scope.ID)
	if err != nil {
		return nil, err
	}
	for _, node := range nodes {
		artifacts = append(artifacts, workflowWikiArtifact{"workflow-node", node.ID})
	}
	memory, err := latestMemory(ctx, q, scope.TaskID)
	if err != nil {
		return nil, err
	}
	if memory.Revision > 0 {
		artifacts = append(artifacts, workflowWikiArtifact{"memory", scope.TaskID + ":" + strconv.Itoa(memory.Revision)})
	}
	version, err := readWorkspaceVersion(ctx, q, scope.TaskID)
	if err != nil {
		return nil, err
	}
	if version.Revision > 0 {
		artifacts = append(artifacts, workflowWikiArtifact{"workspace", scope.TaskID + ":" + strconv.Itoa(version.Revision)})
	}
	return workflowWikiSources(ctx, q, artifacts)
}

func saveWorkflowWikiArtifact(ctx context.Context, tx *sql.Tx, kind, id, taskID string, refs []WikiRef) error {
	generation, err := wikiGeneration(ctx, tx, taskID)
	if err != nil {
		return err
	}
	return saveWikiArtifact(ctx, tx, kind, id, taskID, "", generation, refs)
}

func validateWorkflowV2RecoverySources(ctx context.Context, q workflowTreeQuery, scope WorkflowScope, node WorkflowNodeExecution) error {
	if _, err := workflowScopeWikiSources(ctx, q, scope); err != nil {
		return err
	}
	artifacts := []workflowWikiArtifact{{"workflow-node", node.ID}}
	if node.RunID != "" {
		artifacts = append(artifacts, workflowWikiArtifact{"run", node.RunID})
	}
	_, err := workflowWikiSources(ctx, q, artifacts)
	return err
}

func validateWorkflowV1RecoverySources(ctx context.Context, q workflowTreeQuery, w WorkflowInstance) error {
	artifacts := []workflowWikiArtifact{}
	runs, err := readDocuments[Run](ctx, q, "SELECT r.document FROM runs r WHERE r.workflow_id=? AND (r.id=? OR r.id IN (SELECT run_id FROM workflow_attempts WHERE workflow_id=? AND state='succeeded'))", w.ID, w.ActiveRunID, w.ID)
	if err != nil {
		return err
	}
	for _, run := range runs {
		artifacts = append(artifacts, workflowWikiArtifact{"run", run.ID})
	}
	memory, err := latestMemory(ctx, q, w.TaskID)
	if err != nil {
		return err
	}
	if memory.Revision > 0 {
		artifacts = append(artifacts, workflowWikiArtifact{"memory", w.TaskID + ":" + strconv.Itoa(memory.Revision)})
	}
	version, err := readWorkspaceVersion(ctx, q, w.TaskID)
	if err != nil {
		return err
	}
	if version.Revision > 0 {
		artifacts = append(artifacts, workflowWikiArtifact{"workspace", w.TaskID + ":" + strconv.Itoa(version.Revision)})
	}
	_, err = workflowWikiSources(ctx, q, artifacts)
	return err
}

// Completed execution facts are retained even if withdrawal races with result
// delivery. They are marked invalid and cannot become a subsequent input.
func recordWorkflowV2RunOutput(ctx context.Context, tx *sql.Tx, run Run, node WorkflowNodeExecution) (bool, error) {
	refs, err := wikiArtifactRefs(ctx, tx, "run", run.ID)
	if err != nil {
		return false, err
	}
	invalid, err := wikiArtifactInvalid(ctx, tx, "run", run.ID)
	if err != nil {
		return false, err
	}
	if !invalid {
		if err = (&Manager{}).validateWikiRun(ctx, tx, run.ID); err != nil {
			if _, ok := err.(*Error); !ok {
				return false, err
			}
			invalid = true
		}
	}
	if !invalid {
		return false, recordWikiRunArtifact(ctx, tx, run, "workflow-node", node.ID)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO wiki_artifacts(kind,id,task_id,run_id,invalidated) VALUES('workflow-node',?,?,?,1) ON CONFLICT(kind,id) DO UPDATE SET invalidated=1`, node.ID, node.TaskID, run.ID); err != nil {
		return false, err
	}
	for _, ref := range refs {
		if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO wiki_dependencies(kind,id,page_id,revision,digest) VALUES('workflow-node',?,?,?,?)", node.ID, ref.PageID, ref.Revision, ref.Digest); err != nil {
			return false, err
		}
	}
	return true, nil
}

// Withdrawal also fences ready composites and step-to-step gaps that have no
// active Run. Only workflows derived from this page are affected.
func (m *Manager) withdrawWorkflowV2WikiSources(ctx context.Context, tx *sql.Tx, pageID string) error {
	list, err := readDocuments[WorkflowInstance](ctx, tx, `SELECT DISTINCT w.document FROM workflow_instances w JOIN tasks t ON t.session_id=w.session_id JOIN wiki_artifacts a ON a.task_id=t.id JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE d.page_id=? AND a.invalidated=1 AND json_extract(w.document,'$.languageVersion')='workflow/v2' AND w.state NOT IN ('succeeded','failed','cancelled')`, pageID)
	if err != nil {
		return err
	}
	for _, w := range list {
		failure := &Failure{Code: "wiki-context-invalidated", Message: "工作流来源已撤回，原上下文和派生结果不能继续使用"}
		nodes, err := readDocuments[WorkflowNodeExecution](ctx, tx, `SELECT n.document FROM workflow_nodes n WHERE n.workflow_id=? AND n.state IN ('ready','queued','running','waiting-approval','waiting-resource','waiting-task') AND json_extract(n.document,'$.taskId') IN (SELECT a.task_id FROM wiki_artifacts a JOIN wiki_dependencies d ON d.kind=a.kind AND d.id=a.id WHERE d.page_id=? AND a.invalidated=1) ORDER BY n.rowid`, w.ID, pageID)
		// TaskID is stored in the node document, not a redundant SQL column.
		if err != nil {
			return err
		}
		for _, node := range nodes {
			node.Status, node.Error = StateRecoveryRequired, failure
			if err = saveWorkflowNode(ctx, tx, &node); err != nil {
				return err
			}
			w.CurrentStepID, w.ActiveRunID = node.ID, node.RunID
		}
		w.GateClosed, w.Status, w.Error = true, StateRecoveryRequired, failure
		if err = m.store.workflowEvent(ctx, tx, &w, "workflow/recovery-required", failure.Message); err != nil {
			return err
		}
	}
	return nil
}
