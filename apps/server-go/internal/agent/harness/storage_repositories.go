package harness

import (
	"context"
	"time"

	"elysian/server/internal/agent/harness/sessionstore"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/tools"
)

func readAttachmentRows(ctx context.Context, q sessionstore.ReadView, refs []AttachmentRef, sessionID string) ([]attachmentRow, error) {
	return readView(ctx, q).ReadAttachmentRows(ctx, refs, sessionID)
}

func continuation(ctx context.Context, q sessionstore.ReadView, r Run) (*Continuation, error) {
	return readView(ctx, q).Continuation(ctx, r)
}

func saveBarrier(ctx context.Context, tx sessionstore.Tx, b ExecutionBarrier) error {
	return tx.SaveBarrier(ctx, b)
}

func readApprovalTx(ctx context.Context, tx sessionstore.Tx, runID string) ([]Approval, error) {
	return tx.ReadApprovalTx(ctx, runID)
}

func saveApproval(ctx context.Context, tx sessionstore.Tx, a Approval) error {
	return tx.SaveApproval(ctx, a)
}

func readOperation(ctx context.Context, q sessionstore.ReadView, id string) (Operation, error) {
	return readView(ctx, q).ReadOperation(ctx, id)
}

func saveOperation(ctx context.Context, tx sessionstore.Tx, o Operation) error {
	return tx.SaveOperation(ctx, o)
}

func unsettledRun(ctx context.Context, q sessionstore.ReadView, id string) (bool, error) {
	return readView(ctx, q).UnsettledRun(ctx, id)
}

func settleOperationProtection(ctx context.Context, tx sessionstore.Tx, id string, ended string, unknown bool) error {
	return tx.SettleOperationProtection(ctx, id, ended, unknown)
}

func readProbeLease(ctx context.Context, db sessionstore.ReadView, id string) (ResourceLease, error) {
	return readView(ctx, db).ReadProbeLease(ctx, id)
}

func readResourceRule(ctx context.Context, q sessionstore.ReadView, id string, revision int) (ResourceRule, error) {
	return readView(ctx, q).ReadResourceRule(ctx, id, revision)
}

func releaseWaitingResourceLeases(ctx context.Context, tx sessionstore.Tx, runID string, now string) error {
	return tx.ReleaseWaitingResourceLeases(ctx, runID, now)
}

func settleResourceLease(ctx context.Context, tx sessionstore.Tx, operationID string, now string, unknown bool, evidence string, decision string) error {
	return tx.SettleResourceLease(ctx, operationID, now, unknown, evidence, decision)
}

func acquireResourceLease(ctx context.Context, tx sessionstore.Tx, o Operation, now string) (bool, error) {
	return tx.AcquireResourceLease(ctx, o, now)
}

func resourceLeaseAvailable(ctx context.Context, tx sessionstore.Tx, o Operation, lease ResourceLease) (bool, error) {
	return tx.ResourceLeaseAvailable(ctx, o, lease)
}

func saveResourceLease(ctx context.Context, tx sessionstore.Tx, lease ResourceLease) error {
	return tx.SaveResourceLease(ctx, lease)
}

func interruptResourceWaiter(ctx context.Context, tx sessionstore.Tx, r *Run, o Operation, now string) error {
	return tx.InterruptResourceWaiter(ctx, r, o, now)
}

func unknownResourceWait(ctx context.Context, db sessionstore.ReadView, o Operation, now string) (*ResourceWait, error) {
	return readView(ctx, db).UnknownResourceWait(ctx, o, now)
}

func resourceWaitReason(ctx context.Context, tx sessionstore.Tx, o Operation, now string) (*ResourceWait, error) {
	return tx.ResourceWaitReason(ctx, o, now)
}

func saveSessionAuthorization(ctx context.Context, tx sessionstore.Tx, a SessionAuthorization) error {
	return tx.SaveSessionAuthorization(ctx, a)
}

func createWorkflowV2Root(ctx context.Context, tx sessionstore.Tx, w WorkflowInstance, d WorkflowDefinition, newID func() string) error {
	return tx.CreateWorkflowV2Root(ctx, w, d, newID)
}

func createWorkflowV2Scope(ctx context.Context, tx sessionstore.Tx, scope WorkflowScope, newID func() string) error {
	return tx.CreateWorkflowV2Scope(ctx, scope, newID)
}

func saveWorkflowNode(ctx context.Context, tx sessionstore.Tx, node *WorkflowNodeExecution) error {
	return tx.SaveWorkflowNode(ctx, node)
}

func saveWorkflowScope(ctx context.Context, tx sessionstore.Tx, scope WorkflowScope) error {
	return tx.SaveWorkflowScope(ctx, scope)
}

func readWorkflowNode(ctx context.Context, q sessionstore.ReadView, id string) (WorkflowNodeExecution, error) {
	return readView(ctx, q).ReadWorkflowNode(ctx, id)
}

func readWorkflowScope(ctx context.Context, q sessionstore.ReadView, id string) (WorkflowScope, error) {
	return readView(ctx, q).ReadWorkflowScope(ctx, id)
}

func saveWorkingMemory(ctx context.Context, tx sessionstore.Tx, memory WorkingMemory) error {
	return tx.SaveWorkingMemory(ctx, memory)
}

func interruptModelRequests(ctx context.Context, tx sessionstore.Tx, runID string, now time.Time) error {
	return tx.InterruptModelRequests(ctx, runID, now)
}

func saveModelRequest(ctx context.Context, tx sessionstore.Tx, record ModelRequestRecord) error {
	return tx.SaveModelRequest(ctx, record)
}

func saveSession(ctx context.Context, tx sessionstore.Tx, session Session) error {
	return tx.SaveSession(ctx, session)
}

func readTask(ctx context.Context, q sessionstore.ReadView, id string) (Task, error) {
	return readView(ctx, q).ReadTask(ctx, id)
}

func readSession(ctx context.Context, q sessionstore.ReadView, id string) (Session, error) {
	return readView(ctx, q).ReadSession(ctx, id)
}

func enqueueTaskCancellation(ctx context.Context, tx sessionstore.Tx, ref tools.TaskReference) error {
	return tx.EnqueueTaskCancellation(ctx, ref)
}

func interruptCalls(ctx context.Context, tx sessionstore.Tx, id string, now time.Time) error {
	return tx.InterruptCalls(ctx, id, now)
}

func saveCall(ctx context.Context, tx sessionstore.Tx, c Call) error { return tx.SaveCall(ctx, c) }

func saveRun(ctx context.Context, tx sessionstore.Tx, r *Run) error { return tx.SaveRun(ctx, r) }

func readRun(ctx context.Context, q sessionstore.ReadView, id string) (Run, error) {
	return readView(ctx, q).ReadRun(ctx, id)
}

func readBarrier(ctx context.Context, q sessionstore.ReadView, id string) (ExecutionBarrier, error) {
	return readView(ctx, q).ReadBarrier(ctx, id)
}

func cancelUserInputs(ctx context.Context, tx sessionstore.Tx, runID string, endedAt string) error {
	return tx.CancelUserInputs(ctx, runID, endedAt)
}

func saveUserInput(ctx context.Context, tx sessionstore.Tx, q UserInputRequest) error {
	return tx.SaveUserInput(ctx, q)
}

func latestMemory(ctx context.Context, q sessionstore.ReadView, task string) (WorkingMemory, error) {
	return readView(ctx, q).LatestMemory(ctx, task)
}

func workflowOutputs(ctx context.Context, tx sessionstore.Tx, id string) (map[string]string, error) {
	return tx.WorkflowOutputs(ctx, id)
}

func workflowOutput(ctx context.Context, q sessionstore.ReadView, a WorkflowAttempt) (string, error) {
	return readView(ctx, q).WorkflowOutput(ctx, a)
}

func saveWorkflowAttempt(ctx context.Context, tx sessionstore.Tx, a WorkflowAttempt) error {
	return tx.SaveWorkflowAttempt(ctx, a)
}

func readWorkflowAttempt(ctx context.Context, q sessionstore.ReadView, runID string) (WorkflowAttempt, error) {
	return readView(ctx, q).ReadWorkflowAttempt(ctx, runID)
}

func saveWorkflow(ctx context.Context, tx sessionstore.Tx, w *WorkflowInstance) error {
	return tx.SaveWorkflow(ctx, w)
}

func readWorkflowDefinition(ctx context.Context, q sessionstore.ReadView, id string, revision int) (WorkflowDefinition, error) {
	return readView(ctx, q).ReadWorkflowDefinition(ctx, id, revision)
}

func readWorkflow(ctx context.Context, q sessionstore.ReadView, id string) (WorkflowInstance, error) {
	return readView(ctx, q).ReadWorkflow(ctx, id)
}

func commitWorkspaceVersion(ctx context.Context, tx sessionstore.Tx, version workspace.Version) error {
	return tx.CommitWorkspaceVersion(ctx, version)
}

func readWorkspaceVersion(ctx context.Context, q sessionstore.ReadView, taskID string) (workspace.Version, error) {
	return readView(ctx, q).ReadWorkspaceVersion(ctx, taskID)
}
