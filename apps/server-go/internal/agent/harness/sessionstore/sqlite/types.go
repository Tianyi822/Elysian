package sqlite

import (
	"elysian/server/internal/agent/harness/state"
)

type WorkflowDefinition = state.WorkflowDefinition

type WorkflowStepDefinition = state.WorkflowStepDefinition

type WorkflowBinding = state.WorkflowBinding

type WorkflowBody = state.WorkflowBody

type WorkflowOutputBinding = state.WorkflowOutputBinding

type WorkflowSubworkflow = state.WorkflowSubworkflow
type WorkflowCondition = state.WorkflowCondition
type WorkflowParallel = state.WorkflowParallel
type WorkflowBranch = state.WorkflowBranch
type WorkflowForeach = state.WorkflowForeach
type ProbeAccessRequest = state.ProbeAccessRequest
type MCPCatalogProjection = state.MCPCatalogProjection
type UserInputOption = state.UserInputOption
type UserInputQuestion = state.UserInputQuestion
type UserInputAnswer = state.UserInputAnswer
type AnswerUserInput = state.AnswerUserInput
type UserInputReceipt = state.UserInputReceipt
type PermissionMode = state.PermissionMode
type SubmitInput = state.SubmitInput
type RevisionRef = state.RevisionRef
type ResourceRef = state.ResourceRef
type PromptRef = state.PromptRef
type Environment = state.Environment
type CapabilitySnapshot = state.CapabilitySnapshot
type SkillSummary = state.SkillSummary
type OperationFileContent = state.OperationFileContent
type OperationFileChange = state.OperationFileChange
type ContextItem = state.ContextItem
type ExtensionUnavailable = state.ExtensionUnavailable
type AutomaticExtensions = state.AutomaticExtensions
type CapabilityRevocation = state.CapabilityRevocation
type LoadingBudget = state.LoadingBudget
type ResourceSelector = state.ResourceSelector
type ResourceMapping = state.ResourceMapping
type ResourceRuleInput = state.ResourceRuleInput
type ToolInventory = state.ToolInventory
type AttachmentRecord = state.AttachmentRecord
type WorkflowExecutionTree = state.WorkflowExecutionTree
type WorkflowLimits = state.WorkflowLimits
type WorkflowUsage = state.WorkflowUsage
type CreateWorkflowInput = state.CreateWorkflowInput
type WorkflowRecoveryInput = state.WorkflowRecoveryInput
type RuntimePreparation = state.RuntimePreparation
type BlockedMethod = state.BlockedMethod
type RunDiagnosis = state.RunDiagnosis
type AccessRuntime = state.AccessRuntime
type OperationAuthorization = state.OperationAuthorization
type RevokeAuthorizationInput = state.RevokeAuthorizationInput
type CreateSessionInput = state.CreateSessionInput
type SwitchModelInput = state.SwitchModelInput
type RenameSessionInput = state.RenameSessionInput
type AgentInput = state.AgentInput
type MessageRunConfig = state.MessageRunConfig
type EvidenceRef = state.EvidenceRef

const StateWaitingApproval = "waiting-approval"

const StateWaitingResource = "waiting-resource"

const StateWaitingTask = "waiting-task"

const StateWaitingRecovery = "waiting-recovery"

type Capability = state.Capability

type RecoveryCursor = state.RecoveryCursor

type Operation = state.Operation

type Approval = state.Approval

type ExecutionBarrier = state.ExecutionBarrier

type ExecutionPlan = state.ExecutionPlan

type ResourceRule = state.ResourceRule

type ResourceLease = state.ResourceLease

const resourceSchema = `
CREATE TABLE IF NOT EXISTS resource_rules (
 id TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL,
 PRIMARY KEY(id,revision)
);
CREATE TABLE IF NOT EXISTS resource_leases (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 run_id TEXT NOT NULL DEFAULT '', operation_id TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL, document TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resource_leases_state ON resource_leases(state,sequence);
CREATE INDEX IF NOT EXISTS resource_leases_run ON resource_leases(run_id);
`

type ResourceClaim = state.ResourceClaim

type WorkflowScope = state.WorkflowScope

type WorkflowNodeExecution = state.WorkflowNodeExecution

const (
	WorkflowV2LanguageVersion = "workflow/v2"
	workflowV2MaxDepth        = 4
	workflowV2MaxNodes        = 256
	workflowV2MaxParallel     = 8
	workflowV2MaxForeach      = 32
)

const StateRecoveryRequired = "recovery-required"

const StateReady = "ready"

type WorkflowInstance = state.WorkflowInstance

type WorkflowAttempt = state.WorkflowAttempt

type WorkflowEvent = state.WorkflowEvent

const AuthorizationOnDemand = "on-demand"

type AccessDecision = state.AccessDecision

type SessionAuthorization = state.SessionAuthorization

const sessionAuthorizationSchema = `CREATE TABLE session_authorizations (
 id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
 scope_key TEXT NOT NULL, state TEXT NOT NULL, document TEXT NOT NULL);
 CREATE INDEX session_authorization_scope ON session_authorizations(session_id,scope_key,state);`

type FileRootIdentity = state.FileRootIdentity

type AccessRequest = state.AccessRequest

type Session = state.Session

type ModelChange = state.ModelChange

type AttachmentRef = state.AttachmentRef

type MessageAttachment = state.MessageAttachment

type Message = state.Message

type MemoryCursor = state.MemoryCursor

type MemoryFact = state.MemoryFact

type WorkingMemory = state.WorkingMemory

type ModelRequestRecord = state.ModelRequestRecord

type Task = state.Task

type Failure = state.Failure

type Run = state.Run

type Call = state.Call

type Event = state.Event

type Usage = state.Usage

type Limits = state.Limits

type ListQuery = state.ListQuery

type Page[T any] = state.Page[T]

type Error = state.Error

type Step = state.Step

const (
	StateWaitingModel   = "waiting-model"
	StateWaitingStorage = "waiting-storage"
	StateQueued         = "queued"
	StateRunning        = "running"
	StateSucceeded      = "succeeded"
	StateFailed         = "failed"
	StateCancelled      = "cancelled"
	StateInterrupted    = "interrupted"
)

const (
	// Both task Bash operations share one persisted source. Their names are
	// intentionally distinct so the model schema can tell command and script
	// execution apart without treating source strings as policy.
	BashSource      = "bash"
	TaskBashCommand = "task_bash_command"
	TaskBashScript  = "task_bash_script"
	BashExec        = TaskBashCommand
	BashScript      = TaskBashScript
)
