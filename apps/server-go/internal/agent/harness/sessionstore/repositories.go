package sessionstore

import (
	"context"
	"time"

	"elysian/server/internal/agent/harness/state"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/tools"
)

type AffectedRows int64

func (n AffectedRows) RowsAffected() (int64, error) { return int64(n), nil }

type AttachmentMetadataRecord struct {
	ID       string
	MimeType string
	Bytes    int
}

type AttachmentBytesRecord struct {
	ID      string
	Content []byte
}

type ToolLoadRecord struct {
	Document []byte
}

type RevocationRecord struct {
	Sequence  int64
	Kind      string
	ID        string
	Revision  int
	Reason    string
	CreatedAt string
}

type ExecutionRevocationRecord struct {
	Kind     string
	ID       string
	Revision int
}

type SkillLoadRecord struct {
	Context []byte
	Call    []byte
}

type TaskHistoryRecord struct {
	Sequence     int64
	Event        string
	Call         string
	ModelRequest string
}

type LoadedToolRecord struct {
	Document []byte
}

type WorkspaceCleanupTask struct {
	TaskID string
}

// ReadView 只读既有事实；Tx 的读取复用当前事务，不另取连接。
type ReadView interface {
	RunReader
	SessionReader
	OperationReader
	WorkflowReader
	ContextExcluded(ctx context.Context, kind, id string) (bool, error)
}

// Tx 同时保存运行检查点、会话占用、调用证据和恢复屏障。
// Run 的 Plan、Recovery、Wait、PolicyCheckpoint 与原事实一同提交，不派发外部操作。
type Tx interface {
	ReadView
	RunWriter
	SessionWriter
	OperationWriter
	WorkflowWriter
	CopyContextExclusion(ctx context.Context, kind, from, to string) error
}

type RunReader interface {
	Events(ctx context.Context, id string, after string, n int) (Page[Event], error)
	Calls(ctx context.Context, id string, rawCursor string, n int) (Page[Call], error)
	List(ctx context.Context, q ListQuery) (Page[Run], error)
	LatestRun(ctx context.Context, taskID string) (*Run, error)
	Queued(ctx context.Context) ([]string, error)
	Request(ctx context.Context, key string) (Run, string, error)
	Get(ctx context.Context, id string) (Run, error)
	Continuation(ctx context.Context, r Run) (*Continuation, error)
	UnsettledRun(ctx context.Context, id string) (bool, error)
	ReadRun(ctx context.Context, id string) (Run, error)
	TerminalResult(ctx context.Context, r Run) (*TerminalResult, error)
	ReservedResultBytes(ctx context.Context, runID string, count *int64) error
	QueuedRunCount(ctx context.Context, count *int) error
	ContinuousWaiters(ctx context.Context) ([]Run, error)
	ExtensionRevoked(ctx context.Context, kind string, id string, revision int, count *int) error
	MaintenanceRuns(ctx context.Context) ([]Run, error)
	SucceededCallCount(ctx context.Context, id string, count *int) error
	PendingToolCorrections(ctx context.Context, runID string) ([]ModelRequestRecord, error)
	CorrectionCount(ctx context.Context, runID string, code string, match bool, correctionKey string, document string, count *int) error
	FailureSummaryExists(ctx context.Context, runID string, found *bool) error
	PlanInvocation(ctx context.Context, runID string, modelRequestID string, modelCallID string, document *string) error
	FailedCallExists(ctx context.Context, runID string, found *bool) error
	RecoveryCalls(ctx context.Context, runID string) ([]Call, error)
	DeniedAccessCount(ctx context.Context, runID string, scopeKey string, count *int) error
	PendingReconciliations(ctx context.Context) ([]ExecutionBarrier, error)
}

type RunWriter interface {
	ThawContinuousRuns(ctx context.Context) error
	FreezeContinuousRuns(ctx context.Context) error
	RecoverContinuous(ctx context.Context, r *Run) (bool, error)
	RecoverRuntimePreparations(ctx context.Context) error
	InterruptCalls(ctx context.Context, id string, now time.Time) error
	SaveCall(ctx context.Context, c Call) error
	Event(ctx context.Context, r *Run, kind string, callID string, index *int, data any) error
	SaveRun(ctx context.Context, r *Run) error
	SaveTerminalResult(ctx context.Context, r *Run) error
}

type SessionReader interface {
	SessionsByActivity(ctx context.Context, cursorRaw string, n int) (Page[Session], error)
	ModelRequests(ctx context.Context, id string, cursorRaw string, n int) (Page[ModelRequestRecord], error)
	Memory(ctx context.Context, taskID string, revision int) (WorkingMemory, error)
	Messages(ctx context.Context, sessionID string, after string, n int) (Page[Message], error)
	Tasks(ctx context.Context, sessionID string, cursorRaw string, n int) (Page[Task], error)
	Sessions(ctx context.Context, cursorRaw string, n int) (Page[Session], error)
	ReadAttachmentRows(ctx context.Context, refs []AttachmentRef, sessionID string) ([]state.AttachmentRecord, error)
	ReadTask(ctx context.Context, id string) (Task, error)
	ReadSession(ctx context.Context, id string) (Session, error)
	LatestMemory(ctx context.Context, task string) (WorkingMemory, error)
	ModelRequest(ctx context.Context, responseID string, runID string, document *string) error
	AttachmentContent(ctx context.Context, id string, mimeType *string, content *[]byte) error
	AttachmentOwner(ctx context.Context, id string, document *string) error
	SessionModelRequests(ctx context.Context, id string) ([]ModelRequestRecord, error)
	SessionCalls(ctx context.Context, id string) ([]Call, error)
	SessionUserInputs(ctx context.Context, id string) ([]UserInputRequest, error)
	AttachmentMetadata(ctx context.Context, ids []string) ([]AttachmentMetadataRecord, error)
	AttachmentBytes(ctx context.Context, ids []string) ([]AttachmentBytesRecord, error)
	TaskSnapshot(ctx context.Context, taskID string, document *string) error
	ModelRequestCount(ctx context.Context, runID string, count *int) error
	PendingTaskCancellations(ctx context.Context, now string) ([]tools.TaskReference, error)
	SessionRuns(ctx context.Context, id string) ([]Run, error)
	TaskHistory(ctx context.Context, taskID string, cursor int64, runID string, seq int64, keyword string) ([]TaskHistoryRecord, error)
	TaskHistoryInvocationExists(ctx context.Context, runID string, modelRequestID string, modelCallID string, found *bool) error
	UserInputRecord(ctx context.Context, inputID string, runID string, document *string) error
	UserInputCall(ctx context.Context, callID string, runID string, document *string) error
	TaskRunCount(ctx context.Context, taskID string, count *int) error
	TaskExists(ctx context.Context, id string, count *int) error
}

type SessionWriter interface {
	SweepOrphanAttachments(ctx context.Context) error
	ReplaceLastMessage(ctx context.Context, task *Task, run *Run, replacement *Message) error
	FinalizeAgent(ctx context.Context, r *Run, answer string, memory *WorkingMemory) error
	SaveWorkingMemory(ctx context.Context, memory WorkingMemory) error
	InterruptModelRequests(ctx context.Context, runID string, now time.Time) error
	SaveStoppedReply(ctx context.Context, run Run) error
	SaveModelRequest(ctx context.Context, record ModelRequestRecord) error
	SweepSessions(ctx context.Context, cutoff string) error
	ReleaseSession(ctx context.Context, r *Run) error
	AppendMessage(ctx context.Context, msg *Message) error
	SaveSession(ctx context.Context, session Session) error
	EnqueueTaskCancellation(ctx context.Context, ref tools.TaskReference) error
	CancelUserInputs(ctx context.Context, runID string, endedAt string) error
	SaveUserInput(ctx context.Context, q UserInputRequest) error
	InsertAttachment(ctx context.Context, id string, mimeType string, bytes int, width int, height int, name string, now string, content []byte) (AffectedRows, error)
	RemoveUnboundAttachment(ctx context.Context, id string) (AffectedRows, error)
	RecordTaskCancellationFailure(ctx context.Context, now string, value string) (AffectedRows, error)
	RemoveTaskCancellation(ctx context.Context, value string) (AffectedRows, error)
}

type OperationReader interface {
	ReadOperation(ctx context.Context, id string) (Operation, error)
	ReadProbeLease(ctx context.Context, id string) (ResourceLease, error)
	ReadResourceRule(ctx context.Context, id string, revision int) (ResourceRule, error)
	UnknownResourceWait(ctx context.Context, o Operation, now string) (*ResourceWait, error)
	ReadBarrier(ctx context.Context, id string) (ExecutionBarrier, error)
	ReadWorkspaceVersion(ctx context.Context, taskID string) (workspace.Version, error)
	ResourceBlockedOperations(ctx context.Context, runID string) ([]Operation, error)
	UnknownBarriers(ctx context.Context) ([]ExecutionBarrier, error)
	UnknownResourceLeases(ctx context.Context) ([]ResourceLease, error)
	UnverifiedOperations(ctx context.Context, runID string) ([]Operation, error)
	EnvironmentSnapshot(ctx context.Context, id string, document *string) error
	Operations(ctx context.Context, value string) ([]Operation, error)
	ContextItems(ctx context.Context, value string) ([]ContextItem, error)
	Approvals(ctx context.Context, workflowID string, workflowID2 string, runID string, runID2 string) ([]Approval, error)
	Barriers(ctx context.Context, workflowID string, workflowID2 string) ([]ExecutionBarrier, error)
	ApprovalRecord(ctx context.Context, id string, document *string) error
	ExpiredApprovals(ctx context.Context, now string) ([]Approval, error)
	SessionOperations(ctx context.Context, id string) ([]Operation, error)
	SessionApprovals(ctx context.Context, id string) ([]Approval, error)
	ContextRuns(ctx context.Context, taskID string, runNumber int, runNumber2 int) ([]Run, error)
	ContextModelRequests(ctx context.Context, runID string, coverage int64) ([]ModelRequestRecord, error)
	ContextCalls(ctx context.Context, runID string, coverage int64) ([]Call, error)
	ContextOperations(ctx context.Context, runID string, coverage int64) ([]Operation, error)
	ContextEvents(ctx context.Context, runID string, coverage int64) ([]Event, error)
	ContextMessages(ctx context.Context, sessionID string, taskID string, historySeq string) ([]Message, error)
	LoadedInstructions(ctx context.Context, taskID string, runNumber int) ([]ContextItem, error)
	LatestInstructionResult(ctx context.Context, id string, document *string) error
	ToolLoadHistory(ctx context.Context, runID string, toolDiscoverySource string, toolSearchName string, digest string) ([]ToolLoadRecord, error)
	MaintenanceOperations(ctx context.Context, runID string) ([]Operation, error)
	Revocations(ctx context.Context, cursor int64, kind string, id string, limit int) ([]RevocationRecord, error)
	ExecutionRevocations(ctx context.Context) ([]ExecutionRevocationRecord, error)
	OperationInvocation(ctx context.Context, runID string, originID string, index int, document *string) error
	OperationContext(ctx context.Context, taskID string) ([]ContextItem, error)
	PendingApprovalCount(ctx context.Context, count *int) error
	PriorOperationAttempts(ctx context.Context, id string, taskDomain string) ([]Operation, error)
	OperationCalls(ctx context.Context, runID string) ([]Call, error)
	OperationReceiptSettled(ctx context.Context, runID string, callID string, found *bool) error
	PendingProbeLeases(ctx context.Context) ([]ResourceLease, error)
	ProbeLeaseRecord(ctx context.Context, id string, document *string) error
	ResourceRules(ctx context.Context) ([]ResourceRule, error)
	ResourceRuleRevision(ctx context.Context, id string, count *int) error
	WaitingResourceLeases(ctx context.Context) ([]ResourceLease, error)
	ResourceLeases(ctx context.Context) ([]ResourceLease, error)
	SessionAuthorizations(ctx context.Context, sessionID string) ([]SessionAuthorization, error)
	MatchingAuthorizations(ctx context.Context, sessionID string, scopeKey string) ([]SessionAuthorization, error)
	AuthorizationRecord(ctx context.Context, id string, document *string) error
	AuthorizationExists(ctx context.Context, sessionID string, count *int) error
	SessionAuthorizationRecord(ctx context.Context, id string, sessionID string, document *string) error
	AuthorizedOperations(ctx context.Context, id string) ([]Operation, error)
	UnresolvedBarrierCount(ctx context.Context, count *int) error
	DispatchedOperationCount(ctx context.Context, runID string, count *int) error
	SkillLoadHistory(ctx context.Context, taskID string, runNumber int, replacement string) ([]SkillLoadRecord, error)
	MonitoredOperations(ctx context.Context) ([]Operation, error)
	TaskBarriers(ctx context.Context, operationID string) ([]ExecutionBarrier, error)
	ReportOperations(ctx context.Context, runID string) ([]Operation, error)
	LoadedToolHistory(ctx context.Context, runID string, toolDiscoverySource string, digest string) ([]LoadedToolRecord, error)
	WorkspaceCleanup(ctx context.Context) ([]WorkspaceCleanupTask, error)
}

type OperationWriter interface {
	SaveBarrier(ctx context.Context, b ExecutionBarrier) error
	ReadApprovalTx(ctx context.Context, runID string) ([]Approval, error)
	SaveApproval(ctx context.Context, a Approval) error
	SaveOperation(ctx context.Context, o Operation) error
	SettleOperationProtection(ctx context.Context, id string, ended string, unknown bool) error
	ReleaseWaitingResourceLeases(ctx context.Context, runID string, now string) error
	SettleResourceLease(ctx context.Context, operationID string, now string, unknown bool, evidence string, decision string) error
	AcquireResourceLease(ctx context.Context, o Operation, now string) (bool, error)
	ResourceLeaseAvailable(ctx context.Context, o Operation, lease ResourceLease) (bool, error)
	SaveResourceLease(ctx context.Context, lease ResourceLease) error
	InterruptResourceWaiter(ctx context.Context, r *Run, o Operation, now string) error
	ResourceWaitReason(ctx context.Context, o Operation, now string) (*ResourceWait, error)
	SaveSessionAuthorization(ctx context.Context, a SessionAuthorization) error
	CommitWorkspaceVersion(ctx context.Context, version workspace.Version) error
	InsertEnvironment(ctx context.Context, id string, revision int, document string) (AffectedRows, error)
	RevokeCapability(ctx context.Context, kind string, id string, revision int, reason string, now string) (AffectedRows, error)
	InsertContextItem(ctx context.Context, id string, runID string, taskID string, document string) (AffectedRows, error)
	InsertResourceRule(ctx context.Context, id string, revision int, document string) (AffectedRows, error)
	EnqueueWorkspaceCleanup(ctx context.Context, taskID string) (AffectedRows, error)
	RemoveWorkspaceCleanup(ctx context.Context, id string) (AffectedRows, error)
}

type WorkflowReader interface {
	ReadWorkflowNode(ctx context.Context, id string) (WorkflowNodeExecution, error)
	ReadWorkflowScope(ctx context.Context, id string) (WorkflowScope, error)
	WorkflowOutput(ctx context.Context, a WorkflowAttempt) (string, error)
	ReadWorkflowAttempt(ctx context.Context, runID string) (WorkflowAttempt, error)
	ReadWorkflowDefinition(ctx context.Context, id string, revision int) (WorkflowDefinition, error)
	ReadWorkflow(ctx context.Context, id string) (WorkflowInstance, error)
	WorkflowApprovals(ctx context.Context, workflowID string) ([]Approval, error)
	WorkflowActiveNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error)
	NodeApprovals(ctx context.Context, runID string) ([]Approval, error)
	NodeBarriers(ctx context.Context, runID string) ([]ExecutionBarrier, error)
	ActiveWorkflowApprovalCount(ctx context.Context, runID string, count *int) error
	RecoverableWorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error)
	UnsettledWorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error)
	WorkflowScopes(ctx context.Context, workflowID string) ([]WorkflowScope, error)
	WorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error)
	WorkflowScopeNodes(ctx context.Context, scopeID string) ([]WorkflowNodeExecution, error)
	SchedulableWorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error)
	JoiningWorkflowNodes(ctx context.Context, workflowID string) ([]WorkflowNodeExecution, error)
	WorkflowNodeCount(ctx context.Context, workflowID string, count *int) error
	WorkflowRunCount(ctx context.Context, taskID string, count *int) error
	ChildWorkflowScopes(ctx context.Context, nodeID string) ([]WorkflowScope, error)
	PriorWorkflowRuns(ctx context.Context, workflowID string, activeRunID string) ([]Run, error)
	WorkflowExists(ctx context.Context, id string, count *int) error
	WorkflowDefinitionRevision(ctx context.Context, id string, count *int) error
	WorkflowRequest(ctx context.Context, requestID string, document *string, document2 *string) error
	ActiveWorkflowCount(ctx context.Context, count *int) error
	ReadyWorkflows(ctx context.Context) ([]WorkflowInstance, error)
	WorkflowAttemptCount(ctx context.Context, workflowID string, id string, count *int) error
	WorkflowAttempts(ctx context.Context, workflowID string) ([]WorkflowAttempt, error)
	RunWorkflowNode(ctx context.Context, id string, document *string) error
	WorkflowRecoveryRequest(ctx context.Context, id string, requestID string, document *string, document2 *string) error
	PendingWorkflowApprovalCount(ctx context.Context, runID string, count *int) error
	WorkflowStepAttemptCount(ctx context.Context, workflowID string, id string, count *int) error
	WorkflowRuns(ctx context.Context) ([]Run, error)
	ActiveWorkflows(ctx context.Context) ([]WorkflowInstance, error)
}

type WorkflowWriter interface {
	FailWorkflowV2Budget(ctx context.Context, w *WorkflowInstance, current *Run, failure *Failure) error
	RefreshWorkflowV2(ctx context.Context, w *WorkflowInstance) error
	FailWorkflowV2Node(ctx context.Context, w *WorkflowInstance, node *WorkflowNodeExecution, failure *Failure) error
	AdvanceWorkflowV2Scope(ctx context.Context, w *WorkflowInstance, scope *WorkflowScope, node WorkflowNodeExecution, step WorkflowStepDefinition, next string) error
	FinishWorkflowV2Run(ctx context.Context, r *Run) error
	SyncWorkflowV2Run(ctx context.Context, r *Run) error
	CreateWorkflowV2Root(ctx context.Context, w WorkflowInstance, d WorkflowDefinition, newID func() string) error
	CreateWorkflowV2Scope(ctx context.Context, scope WorkflowScope, newID func() string) error
	SaveWorkflowNode(ctx context.Context, node *WorkflowNodeExecution) error
	SaveWorkflowScope(ctx context.Context, scope WorkflowScope) error
	ReleaseWorkflowSession(ctx context.Context, w WorkflowInstance) error
	FailWorkflowActiveBudget(ctx context.Context, w *WorkflowInstance, current *Run) error
	SyncWorkflowRun(ctx context.Context, r *Run) error
	AdvanceWorkflow(ctx context.Context, w *WorkflowInstance, a WorkflowAttempt, next string) error
	FinishWorkflowRun(ctx context.Context, r *Run) error
	WorkflowOutputs(ctx context.Context, id string) (map[string]string, error)
	WorkflowEvent(ctx context.Context, w *WorkflowInstance, kind string, detail string) error
	SaveWorkflowAttempt(ctx context.Context, a WorkflowAttempt) error
	SaveWorkflow(ctx context.Context, w *WorkflowInstance) error
	InsertWorkflowRecovery(ctx context.Context, workflowID string, requestID string, canonical string, document string) (AffectedRows, error)
	WakeWorkflowRuns(ctx context.Context) (AffectedRows, error)
	WakeWorkflowApprovals(ctx context.Context) (AffectedRows, error)
	WakeWorkflowOperations(ctx context.Context) (AffectedRows, error)
	WakeWorkflowCalls(ctx context.Context) (AffectedRows, error)
	WakeWorkflowNodes(ctx context.Context) (AffectedRows, error)
	WakeWorkflowAttempts(ctx context.Context) (AffectedRows, error)
	InsertWorkflowTask(ctx context.Context, taskID string, requestID string, canonical string, document string, sessionID string) (AffectedRows, error)
	InsertWorkflowRun(ctx context.Context, runID string, taskID string, status string, createdAt string, document string, sessionID string, requestID string, input string, number int, workflowID string) (AffectedRows, error)
	InsertWorkflowDefinition(ctx context.Context, id string, revision int, document string) (AffectedRows, error)
	InsertWorkflow(ctx context.Context, workflowID string, requestID string, canonical string, sessionID string, status string, readyAt string, document string) (AffectedRows, error)
}

// Commands 提供完整的持久化动作；接收请求时原子核对 requestId、canonical 输入、
// 目标会话和任务。相同输入返回原 Run，变参或更换目标返回冲突，均不重复追加消息。
type Commands interface {
	Sweep(context.Context, int) error
	DeleteSession(ctx context.Context, id string, extraTasks ...tools.TaskReference) error
	RenameSession(ctx context.Context, id string, title string) (Session, error)
	AcceptAgent(ctx context.Context, task Task, run Run, canonical string, messageID string, newTask bool) (Run, bool, error)
	SwitchModel(ctx context.Context, id string, profile string, revision int) (Session, error)
	CreateSession(ctx context.Context, session Session) error
	Recover(ctx context.Context, freezeContinuous bool) error
	Create(ctx context.Context, t Task, r Run, input string) error
}
