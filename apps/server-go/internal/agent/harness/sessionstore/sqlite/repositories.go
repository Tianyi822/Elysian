package sqlite

import (
	"context"
	"time"

	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/tools"
)

func (v *transaction) SweepOrphanAttachments(ctx context.Context) error {
	err := v.store.sweepOrphanAttachments(ctx, v.tx)
	return normalizeError("SweepOrphanAttachments", err, true)
}

func (v *view) ReadAttachmentRows(ctx context.Context, refs []AttachmentRef, sessionID string) ([]attachmentRow, error) {
	return viewValue(ctx, v, "ReadAttachmentRows", func(ctx context.Context) ([]attachmentRow, error) {
		return readAttachmentRows(ctx, v.query(ctx), refs, sessionID)
	})
}

func (v *view) Continuation(ctx context.Context, r Run) (*Continuation, error) {
	return viewValue(ctx, v, "Continuation", func(ctx context.Context) (*Continuation, error) { return continuation(ctx, v.query(ctx), r) })
}

func (v *transaction) SaveBarrier(ctx context.Context, b ExecutionBarrier) error {
	err := saveBarrier(ctx, v.tx, b)
	return normalizeError("SaveBarrier", err, true)
}

func (v *transaction) ReadApprovalTx(ctx context.Context, runID string) ([]Approval, error) {
	value0, err := readApprovalTx(ctx, v.tx, runID)
	return value0, normalizeError("ReadApprovalTx", err, true)
}

func (v *transaction) SaveApproval(ctx context.Context, a Approval) error {
	err := saveApproval(ctx, v.tx, a)
	return normalizeError("SaveApproval", err, true)
}

func (v *view) ReadOperation(ctx context.Context, id string) (Operation, error) {
	return viewValue(ctx, v, "ReadOperation", func(ctx context.Context) (Operation, error) { return readOperation(ctx, v.query(ctx), id) })
}

func (v *transaction) SaveOperation(ctx context.Context, o Operation) error {
	err := saveOperation(ctx, v.tx, o)
	return normalizeError("SaveOperation", err, true)
}

func (v *transaction) ThawContinuousRuns(ctx context.Context) error {
	err := v.store.thawContinuousRuns(ctx, v.tx)
	return normalizeError("ThawContinuousRuns", err, true)
}

func (v *transaction) FreezeContinuousRuns(ctx context.Context) error {
	err := v.store.freezeContinuousRuns(ctx, v.tx)
	return normalizeError("FreezeContinuousRuns", err, true)
}

func (v *transaction) RecoverContinuous(ctx context.Context, r *Run) (bool, error) {
	value0, err := v.store.recoverContinuous(ctx, v.tx, r)
	return value0, normalizeError("RecoverContinuous", err, true)
}

func (v *view) UnsettledRun(ctx context.Context, id string) (bool, error) {
	return viewValue(ctx, v, "UnsettledRun", func(ctx context.Context) (bool, error) { return unsettledRun(ctx, v.query(ctx), id) })
}

func (v *transaction) ReplaceLastMessage(ctx context.Context, task *Task, run *Run, replacement *Message) error {
	err := v.store.replaceLastMessage(ctx, v.tx, task, run, replacement)
	return normalizeError("ReplaceLastMessage", err, true)
}

func (v *transaction) SettleOperationProtection(ctx context.Context, id string, ended string, unknown bool) error {
	err := settleOperationProtection(ctx, v.tx, id, ended, unknown)
	return normalizeError("SettleOperationProtection", err, true)
}

func (v *view) ReadProbeLease(ctx context.Context, id string) (ResourceLease, error) {
	return viewValue(ctx, v, "ReadProbeLease", func(ctx context.Context) (ResourceLease, error) { return readProbeLease(ctx, v.query(ctx), id) })
}

func (v *view) Events(ctx context.Context, id string, after string, n int) (Page[Event], error) {
	return viewValue(ctx, v, "Events", func(ctx context.Context) (Page[Event], error) { return v.store.events(ctx, id, after, n) })
}

func (v *view) Calls(ctx context.Context, id string, rawCursor string, n int) (Page[Call], error) {
	return viewValue(ctx, v, "Calls", func(ctx context.Context) (Page[Call], error) { return v.store.calls(ctx, id, rawCursor, n) })
}

func (v *view) List(ctx context.Context, q ListQuery) (Page[Run], error) {
	return viewValue(ctx, v, "List", func(ctx context.Context) (Page[Run], error) { return v.store.list(ctx, q) })
}

func (v *view) ReadResourceRule(ctx context.Context, id string, revision int) (ResourceRule, error) {
	return viewValue(ctx, v, "ReadResourceRule", func(ctx context.Context) (ResourceRule, error) {
		return readResourceRule(ctx, v.query(ctx), id, revision)
	})
}

func (v *transaction) ReleaseWaitingResourceLeases(ctx context.Context, runID string, now string) error {
	err := releaseWaitingResourceLeases(ctx, v.tx, runID, now)
	return normalizeError("ReleaseWaitingResourceLeases", err, true)
}

func (v *transaction) SettleResourceLease(ctx context.Context, operationID string, now string, unknown bool, evidence string, decision string) error {
	err := settleResourceLease(ctx, v.tx, operationID, now, unknown, evidence, decision)
	return normalizeError("SettleResourceLease", err, true)
}

func (v *transaction) AcquireResourceLease(ctx context.Context, o Operation, now string) (bool, error) {
	value0, err := acquireResourceLease(ctx, v.tx, o, now)
	return value0, normalizeError("AcquireResourceLease", err, true)
}

func (v *transaction) ResourceLeaseAvailable(ctx context.Context, o Operation, lease ResourceLease) (bool, error) {
	value0, err := resourceLeaseAvailable(ctx, v.tx, o, lease)
	return value0, normalizeError("ResourceLeaseAvailable", err, true)
}

func (v *transaction) SaveResourceLease(ctx context.Context, lease ResourceLease) error {
	err := saveResourceLease(ctx, v.tx, lease)
	return normalizeError("SaveResourceLease", err, true)
}

func (v *transaction) InterruptResourceWaiter(ctx context.Context, r *Run, o Operation, now string) error {
	err := interruptResourceWaiter(ctx, v.tx, v.store, r, o, now)
	return normalizeError("InterruptResourceWaiter", err, true)
}

func (v *view) UnknownResourceWait(ctx context.Context, o Operation, now string) (*ResourceWait, error) {
	return viewValue(ctx, v, "UnknownResourceWait", func(ctx context.Context) (*ResourceWait, error) {
		return unknownResourceWait(ctx, v.query(ctx), o, now)
	})
}

func (v *transaction) ResourceWaitReason(ctx context.Context, o Operation, now string) (*ResourceWait, error) {
	value0, err := resourceWaitReason(ctx, v.tx, o, now)
	return value0, normalizeError("ResourceWaitReason", err, true)
}

func (v *transaction) RecoverRuntimePreparations(ctx context.Context) error {
	err := v.store.recoverRuntimePreparations(ctx, v.tx)
	return normalizeError("RecoverRuntimePreparations", err, true)
}

func (v *transaction) SaveSessionAuthorization(ctx context.Context, a SessionAuthorization) error {
	err := saveSessionAuthorization(ctx, v.tx, a)
	return normalizeError("SaveSessionAuthorization", err, true)
}

func (v *transaction) FailWorkflowV2Budget(ctx context.Context, w *WorkflowInstance, current *Run, failure *Failure) error {
	err := v.store.failWorkflowV2Budget(ctx, v.tx, w, current, failure)
	return normalizeError("FailWorkflowV2Budget", err, true)
}

func (v *transaction) RefreshWorkflowV2(ctx context.Context, w *WorkflowInstance) error {
	err := v.store.refreshWorkflowV2(ctx, v.tx, w)
	return normalizeError("RefreshWorkflowV2", err, true)
}

func (v *transaction) FailWorkflowV2Node(ctx context.Context, w *WorkflowInstance, node *WorkflowNodeExecution, failure *Failure) error {
	err := v.store.failWorkflowV2Node(ctx, v.tx, w, node, failure)
	return normalizeError("FailWorkflowV2Node", err, true)
}

func (v *transaction) AdvanceWorkflowV2Scope(ctx context.Context, w *WorkflowInstance, scope *WorkflowScope, node WorkflowNodeExecution, step WorkflowStepDefinition, next string) error {
	err := v.store.advanceWorkflowV2Scope(ctx, v.tx, w, scope, node, step, next)
	return normalizeError("AdvanceWorkflowV2Scope", err, true)
}

func (v *transaction) FinishWorkflowV2Run(ctx context.Context, r *Run) error {
	err := v.store.finishWorkflowV2Run(ctx, v.tx, r)
	return normalizeError("FinishWorkflowV2Run", err, true)
}

func (v *transaction) SyncWorkflowV2Run(ctx context.Context, r *Run) error {
	err := v.store.syncWorkflowV2Run(ctx, v.tx, r)
	return normalizeError("SyncWorkflowV2Run", err, true)
}

func (v *transaction) CreateWorkflowV2Root(ctx context.Context, w WorkflowInstance, d WorkflowDefinition, newID func() string) error {
	err := createWorkflowV2Root(ctx, v.tx, w, d, newID)
	return normalizeError("CreateWorkflowV2Root", err, true)
}

func (v *transaction) CreateWorkflowV2Scope(ctx context.Context, scope WorkflowScope, newID func() string) error {
	err := createWorkflowV2Scope(ctx, v.tx, scope, newID)
	return normalizeError("CreateWorkflowV2Scope", err, true)
}

func (v *transaction) SaveWorkflowNode(ctx context.Context, node *WorkflowNodeExecution) error {
	err := saveWorkflowNode(ctx, v.tx, node)
	return normalizeError("SaveWorkflowNode", err, true)
}

func (v *transaction) SaveWorkflowScope(ctx context.Context, scope WorkflowScope) error {
	err := saveWorkflowScope(ctx, v.tx, scope)
	return normalizeError("SaveWorkflowScope", err, true)
}

func (v *view) ReadWorkflowNode(ctx context.Context, id string) (WorkflowNodeExecution, error) {
	return viewValue(ctx, v, "ReadWorkflowNode", func(ctx context.Context) (WorkflowNodeExecution, error) {
		return readWorkflowNode(ctx, v.query(ctx), id)
	})
}

func (v *view) ReadWorkflowScope(ctx context.Context, id string) (WorkflowScope, error) {
	return viewValue(ctx, v, "ReadWorkflowScope", func(ctx context.Context) (WorkflowScope, error) { return readWorkflowScope(ctx, v.query(ctx), id) })
}

func (v *view) SessionsByActivity(ctx context.Context, cursorRaw string, n int) (Page[Session], error) {
	return viewValue(ctx, v, "SessionsByActivity", func(ctx context.Context) (Page[Session], error) { return v.store.sessionsByActivity(ctx, cursorRaw, n) })
}

func (v *view) LatestRun(ctx context.Context, taskID string) (*Run, error) {
	return viewValue(ctx, v, "LatestRun", func(ctx context.Context) (*Run, error) { return v.store.latestRun(ctx, taskID) })
}

func (v *view) ModelRequests(ctx context.Context, id string, cursorRaw string, n int) (Page[ModelRequestRecord], error) {
	return viewValue(ctx, v, "ModelRequests", func(ctx context.Context) (Page[ModelRequestRecord], error) {
		return v.store.modelRequests(ctx, id, cursorRaw, n)
	})
}

func (v *view) Memory(ctx context.Context, taskID string, revision int) (WorkingMemory, error) {
	return viewValue(ctx, v, "Memory", func(ctx context.Context) (WorkingMemory, error) { return v.store.memory(ctx, taskID, revision) })
}

func (v *view) Messages(ctx context.Context, sessionID string, after string, n int) (Page[Message], error) {
	return viewValue(ctx, v, "Messages", func(ctx context.Context) (Page[Message], error) { return v.store.messages(ctx, sessionID, after, n) })
}

func (v *view) Tasks(ctx context.Context, sessionID string, cursorRaw string, n int) (Page[Task], error) {
	return viewValue(ctx, v, "Tasks", func(ctx context.Context) (Page[Task], error) { return v.store.tasks(ctx, sessionID, cursorRaw, n) })
}

func (v *view) Sessions(ctx context.Context, cursorRaw string, n int) (Page[Session], error) {
	return viewValue(ctx, v, "Sessions", func(ctx context.Context) (Page[Session], error) { return v.store.sessions(ctx, cursorRaw, n) })
}

func (v *transaction) FinalizeAgent(ctx context.Context, r *Run, answer string, memory *WorkingMemory) error {
	err := v.store.finalizeAgent(ctx, v.tx, r, answer, memory)
	return normalizeError("FinalizeAgent", err, true)
}

func (v *transaction) SaveWorkingMemory(ctx context.Context, memory WorkingMemory) error {
	err := saveWorkingMemory(ctx, v.tx, memory)
	return normalizeError("SaveWorkingMemory", err, true)
}

func (v *transaction) InterruptModelRequests(ctx context.Context, runID string, now time.Time) error {
	err := interruptModelRequests(ctx, v.tx, runID, now)
	return normalizeError("InterruptModelRequests", err, true)
}

func (v *transaction) SaveStoppedReply(ctx context.Context, run Run) error {
	err := v.store.saveStoppedReply(ctx, v.tx, run)
	return normalizeError("SaveStoppedReply", err, true)
}

func (v *transaction) SaveModelRequest(ctx context.Context, record ModelRequestRecord) error {
	err := saveModelRequest(ctx, v.tx, record)
	return normalizeError("SaveModelRequest", err, true)
}

func (v *transaction) SweepSessions(ctx context.Context, cutoff string) error {
	err := v.store.sweepSessions(ctx, v.tx, cutoff)
	return normalizeError("SweepSessions", err, true)
}

func (v *Store) DeleteSession(ctx context.Context, id string, extraTasks ...tools.TaskReference) error {
	err := v.store.deleteSession(ctx, id, extraTasks...)
	return normalizeError("DeleteSession", err, true)
}

func (v *Store) RenameSession(ctx context.Context, id string, title string) (Session, error) {
	value0, err := v.store.renameSession(ctx, id, title)
	return value0, normalizeError("RenameSession", err, true)
}

func (v *transaction) ReleaseSession(ctx context.Context, r *Run) error {
	err := v.store.releaseSession(ctx, v.tx, r)
	return normalizeError("ReleaseSession", err, true)
}

func (v *Store) AcceptAgent(ctx context.Context, task Task, run Run, canonical string, messageID string, newTask bool) (Run, bool, error) {
	value0, value1, err := v.store.acceptAgent(ctx, task, run, canonical, messageID, newTask)
	return value0, value1, normalizeError("AcceptAgent", err, true)
}

func (v *transaction) AppendMessage(ctx context.Context, msg *Message) error {
	err := v.store.appendMessage(ctx, v.tx, msg)
	return normalizeError("AppendMessage", err, true)
}

func (v *Store) SwitchModel(ctx context.Context, id string, profile string, revision int) (Session, error) {
	value0, err := v.store.switchModel(ctx, id, profile, revision)
	return value0, normalizeError("SwitchModel", err, true)
}

func (v *Store) CreateSession(ctx context.Context, session Session) error {
	err := v.store.createSession(ctx, session)
	return normalizeError("CreateSession", err, true)
}

func (v *transaction) SaveSession(ctx context.Context, session Session) error {
	err := saveSession(ctx, v.tx, session)
	return normalizeError("SaveSession", err, true)
}

func (v *view) ReadTask(ctx context.Context, id string) (Task, error) {
	return viewValue(ctx, v, "ReadTask", func(ctx context.Context) (Task, error) { return readTask(ctx, v.query(ctx), id) })
}

func (v *view) ReadSession(ctx context.Context, id string) (Session, error) {
	return viewValue(ctx, v, "ReadSession", func(ctx context.Context) (Session, error) { return readSession(ctx, v.query(ctx), id) })
}

func (v *transaction) EnqueueTaskCancellation(ctx context.Context, ref tools.TaskReference) error {
	err := enqueueTaskCancellation(ctx, v.tx, ref)
	return normalizeError("EnqueueTaskCancellation", err, true)
}

func (v *transaction) InterruptCalls(ctx context.Context, id string, now time.Time) error {
	err := interruptCalls(ctx, v.tx, id, now)
	return normalizeError("InterruptCalls", err, true)
}

func (v *Store) Recover(ctx context.Context, freezeContinuous bool) error {
	err := func() error {
		v.store.freezeContinuous = freezeContinuous
		return v.store.recover(ctx)
	}()
	return normalizeError("Recover", err, true)
}

func (v *view) Queued(ctx context.Context) ([]string, error) {
	return viewValue(ctx, v, "Queued", func(ctx context.Context) ([]string, error) { return v.store.queued(ctx) })
}

func (v *transaction) SaveCall(ctx context.Context, c Call) error {
	err := saveCall(ctx, v.tx, c)
	return normalizeError("SaveCall", err, true)
}

func (v *Store) Create(ctx context.Context, t Task, r Run, input string) error {
	err := v.store.create(ctx, t, r, input)
	return normalizeError("Create", err, true)
}

func (v *view) Request(ctx context.Context, key string) (Run, string, error) {
	var value0 Run
	var value1 string
	err := v.read(ctx, "Request", func(ctx context.Context) error {
		var readErr error
		value0, value1, readErr = v.store.request(ctx, key)
		return readErr
	})
	return value0, value1, normalizeError("Request", err, v.tx != nil)
}

func (v *view) Get(ctx context.Context, id string) (Run, error) {
	return viewValue(ctx, v, "Get", func(ctx context.Context) (Run, error) { return v.store.get(ctx, id) })
}

func (v *transaction) Event(ctx context.Context, r *Run, kind string, callID string, index *int, data any) error {
	err := v.store.event(ctx, v.tx, r, kind, callID, index, data)
	return normalizeError("Event", err, true)
}

func (v *transaction) SaveRun(ctx context.Context, r *Run) error {
	err := saveRun(ctx, v.tx, r)
	return normalizeError("SaveRun", err, true)
}

func (v *view) ReadRun(ctx context.Context, id string) (Run, error) {
	return viewValue(ctx, v, "ReadRun", func(ctx context.Context) (Run, error) { return readRun(ctx, v.query(ctx), id) })
}

func (v *view) ReadBarrier(ctx context.Context, id string) (ExecutionBarrier, error) {
	return viewValue(ctx, v, "ReadBarrier", func(ctx context.Context) (ExecutionBarrier, error) { return readBarrier(ctx, v.query(ctx), id) })
}

func (v *transaction) SaveTerminalResult(ctx context.Context, r *Run) error {
	err := v.store.saveTerminalResult(ctx, v.tx, r)
	return normalizeError("SaveTerminalResult", err, true)
}

func (v *view) TerminalResult(ctx context.Context, r Run) (*TerminalResult, error) {
	return viewValue(ctx, v, "TerminalResult", func(ctx context.Context) (*TerminalResult, error) {
		return v.store.terminalResult(ctx, v.query(ctx), r)
	})
}

func (v *transaction) CancelUserInputs(ctx context.Context, runID string, endedAt string) error {
	err := cancelUserInputs(ctx, v.tx, runID, endedAt)
	return normalizeError("CancelUserInputs", err, true)
}

func (v *transaction) SaveUserInput(ctx context.Context, q UserInputRequest) error {
	err := saveUserInput(ctx, v.tx, q)
	return normalizeError("SaveUserInput", err, true)
}

func (v *transaction) ReleaseWorkflowSession(ctx context.Context, w WorkflowInstance) error {
	err := v.store.releaseWorkflowSession(ctx, v.tx, w)
	return normalizeError("ReleaseWorkflowSession", err, true)
}

func (v *view) LatestMemory(ctx context.Context, task string) (WorkingMemory, error) {
	return viewValue(ctx, v, "LatestMemory", func(ctx context.Context) (WorkingMemory, error) { return latestMemory(ctx, v.query(ctx), task) })
}

func (v *transaction) FailWorkflowActiveBudget(ctx context.Context, w *WorkflowInstance, current *Run) error {
	err := v.store.failWorkflowActiveBudget(ctx, v.tx, w, current)
	return normalizeError("FailWorkflowActiveBudget", err, true)
}

func (v *transaction) SyncWorkflowRun(ctx context.Context, r *Run) error {
	err := v.store.syncWorkflowRun(ctx, v.tx, r)
	return normalizeError("SyncWorkflowRun", err, true)
}

func (v *transaction) AdvanceWorkflow(ctx context.Context, w *WorkflowInstance, a WorkflowAttempt, next string) error {
	err := v.store.advanceWorkflow(ctx, v.tx, w, a, next)
	return normalizeError("AdvanceWorkflow", err, true)
}

func (v *transaction) FinishWorkflowRun(ctx context.Context, r *Run) error {
	err := v.store.finishWorkflowRun(ctx, v.tx, r)
	return normalizeError("FinishWorkflowRun", err, true)
}

func (v *transaction) WorkflowOutputs(ctx context.Context, id string) (map[string]string, error) {
	value0, err := workflowOutputs(ctx, v.tx, id)
	return value0, normalizeError("WorkflowOutputs", err, true)
}

func (v *view) WorkflowOutput(ctx context.Context, a WorkflowAttempt) (string, error) {
	return viewValue(ctx, v, "WorkflowOutput", func(ctx context.Context) (string, error) { return workflowOutput(ctx, v.query(ctx), a) })
}

func (v *transaction) WorkflowEvent(ctx context.Context, w *WorkflowInstance, kind string, detail string) error {
	err := v.store.workflowEvent(ctx, v.tx, w, kind, detail)
	return normalizeError("WorkflowEvent", err, true)
}

func (v *transaction) SaveWorkflowAttempt(ctx context.Context, a WorkflowAttempt) error {
	err := saveWorkflowAttempt(ctx, v.tx, a)
	return normalizeError("SaveWorkflowAttempt", err, true)
}

func (v *view) ReadWorkflowAttempt(ctx context.Context, runID string) (WorkflowAttempt, error) {
	return viewValue(ctx, v, "ReadWorkflowAttempt", func(ctx context.Context) (WorkflowAttempt, error) {
		return readWorkflowAttempt(ctx, v.query(ctx), runID)
	})
}

func (v *transaction) SaveWorkflow(ctx context.Context, w *WorkflowInstance) error {
	err := saveWorkflow(ctx, v.tx, w)
	return normalizeError("SaveWorkflow", err, true)
}

func (v *view) ReadWorkflowDefinition(ctx context.Context, id string, revision int) (WorkflowDefinition, error) {
	return viewValue(ctx, v, "ReadWorkflowDefinition", func(ctx context.Context) (WorkflowDefinition, error) {
		return readWorkflowDefinition(ctx, v.query(ctx), id, revision)
	})
}

func (v *view) ReadWorkflow(ctx context.Context, id string) (WorkflowInstance, error) {
	return viewValue(ctx, v, "ReadWorkflow", func(ctx context.Context) (WorkflowInstance, error) { return readWorkflow(ctx, v.query(ctx), id) })
}

func (v *transaction) CommitWorkspaceVersion(ctx context.Context, version workspace.Version) error {
	err := commitWorkspaceVersion(ctx, v.tx, version)
	return normalizeError("CommitWorkspaceVersion", err, true)
}

func (v *view) ReadWorkspaceVersion(ctx context.Context, taskID string) (workspace.Version, error) {
	return viewValue(ctx, v, "ReadWorkspaceVersion", func(ctx context.Context) (workspace.Version, error) {
		return readWorkspaceVersion(ctx, v.query(ctx), taskID)
	})
}

func (v *Store) Sweep(ctx context.Context, days int) error {
	err := v.store.sweep(ctx, days)
	return normalizeError("Sweep", err, true)
}
