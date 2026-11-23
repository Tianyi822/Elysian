package harness

import (
	"context"
	"strconv"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/workspace"
)

func revisionContextKey(taskID string, revision int) string {
	return taskID + ":" + strconv.Itoa(revision)
}

func workspaceContextKey(v workspace.Version) string {
	return revisionContextKey(v.TaskID, v.Revision)
}

func contextExcluded(ctx context.Context, q sessionstore.ReadView, kind, id string) (bool, error) {
	return readView(ctx, q).ContextExcluded(ctx, kind, id)
}

func requireContext(ctx context.Context, q sessionstore.ReadView, kind, id string) error {
	excluded, err := contextExcluded(ctx, q, kind, id)
	if err != nil {
		return err
	}
	if excluded {
		return &Error{Status: 409, Code: "context-quarantined", Message: "历史内容已隔离，不能用于模型或后续执行"}
	}
	return nil
}

func carryWorkspaceContext(ctx context.Context, tx sessionstore.Tx, v workspace.Version) error {
	if v.FileCount == 0 {
		return nil
	}
	return tx.CopyContextExclusion(ctx, "workspace", revisionContextKey(v.TaskID, v.BaseRevision), workspaceContextKey(v))
}

func requireOperationWorkspace(ctx context.Context, q sessionstore.ReadView, o Operation) error {
	source := o.Capability.Source
	if o.WorkspaceRevision == 0 || (source != "script" && source != "workspace" && !isBashSource(source)) {
		return nil
	}
	return requireContext(ctx, q, "workspace", revisionContextKey(o.TaskID, o.WorkspaceRevision))
}

func validateWorkflowV1RecoverySources(ctx context.Context, q workflowTreeQuery, w WorkflowInstance) error {
	return requireContext(ctx, q, "workflow", w.ID)
}

func validateWorkflowV2RecoverySources(ctx context.Context, q workflowTreeQuery, scope WorkflowScope, node WorkflowNodeExecution) error {
	if err := requireContext(ctx, q, "workflow", scope.WorkflowID); err != nil {
		return err
	}
	return requireContext(ctx, q, "workflow-node", node.ID)
}
