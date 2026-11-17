package harness

import (
	"context"
	"strconv"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/state"
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
			return nil, &Error{Status: 409, Code: "wiki-context-invalidated", Message: "工作流输入、工作记忆、文件或前序结果引用的 Wiki 来源已撤回"}
		}
		inherited, err := wikiArtifactRefs(ctx, q, artifact.kind, artifact.id)
		if err != nil {
			return nil, err
		}
		refs = state.MergeWikiRefs(refs, inherited)
	}
	return refs, validateWikiSources(ctx, q, refs)
}

func workflowScopeWikiSources(ctx context.Context, q workflowTreeQuery, scope WorkflowScope) ([]WikiRef, error) {
	artifacts := []workflowWikiArtifact{{"workflow-scope", scope.ID}}
	nodes, err := readView(ctx, q).WorkflowScopeNodes(ctx, scope.ID)
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
	runs, err := readView(ctx, q).PriorWorkflowRuns(ctx, w.ID, w.ActiveRunID)
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

// Withdrawal also fences ready composites and step-to-step gaps that have no
// active Run. Only workflows derived from this page are affected.
func (m *Manager) withdrawWorkflowV2WikiSources(ctx context.Context, tx sessionstore.Tx, pageID string) error {
	list, err := tx.WikiDependentWorkflows(ctx, pageID)
	if err != nil {
		return err
	}
	for _, w := range list {
		failure := &Failure{Code: "wiki-context-invalidated", Message: "工作流来源已撤回，原上下文和派生结果不能继续使用"}
		nodes, err := tx.WikiDependentNodes(ctx, w.ID, pageID)
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
		if err = tx.WorkflowEvent(ctx, &w, "workflow/recovery-required", failure.Message); err != nil {
			return err
		}
	}
	return nil
}
