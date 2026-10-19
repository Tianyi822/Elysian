package harness

import (
	"context"
	"database/sql"
	"elysian/server/internal/agent/execution"
	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/skills"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/harness/workspace"
	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/mcp"
	"elysian/server/internal/agent/tools"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

func (a *agentExecution) capability(name string) (Capability, bool) {
	if a.run.Snapshot != nil {
		for _, c := range a.run.Snapshot.Tools {
			if c.Name == name {
				return c, true
			}
		}
		for _, c := range a.run.Snapshot.Materials {
			if c.Name == name {
				return c, true
			}
		}
	}
	return Capability{}, false
}
func (a *agentExecution) validateProposal(name string, args json.RawMessage) error {
	obj, err := jsonvalue.Object(args)
	if err != nil {
		return bad("invalid-arguments", "工具参数必须是无重复键的 JSON 对象")
	}
	if a.run.DriverVersion != "v2" {
		if _, workspaceTool := taskWorkspaceCapability(name); workspaceTool || name == BashExec || name == BashScript {
			return bad("tool-denied", "该能力只允许 Agent v2 运行调用")
		}
		if !allowed(name) || len(obj) != 0 {
			return bad("tool-denied", "工具未获准")
		}
		return nil
	}
	c, ok := a.capability(name)
	if !ok {
		return bad("tool-denied", "工具不在运行固定的能力目录中")
	}
	if c.Source == "mcp-prompt" {
		selected := false
		if a.run.Selection != nil {
			for _, p := range a.run.Selection.Prompts {
				if p.ServerID == c.Ref.ID && p.Name == c.OriginalName {
					want, e := jsonvalue.Canonical(p.Arguments)
					got, g := jsonvalue.Canonical(args)
					selected = e == nil && g == nil && string(want) == string(got)
				}
			}
		}
		if !selected {
			return bad("prompt-denied", "提示模板只能由用户在本轮输入显式选择")
		}
	}
	if c.Source == "builtin" {
		return mcp.Validate(c.Parameters, args)
	}
	if c.Source == "wiki" {
		return mcp.Validate(c.Parameters, args)
	}
	if c.Source == toolDiscoverySource {
		_, err := parseToolSearch(args)
		return err
	}
	if a.manager.deps.Catalog == nil {
		return bad("capability-unavailable", "扩展能力不可用")
	}
	return a.manager.deps.Catalog.Validate(c, args)
}
func (m *Manager) validateSelection(s CapabilitySnapshot, input AgentInput) error {
	for _, r := range input.Skills {
		ok := false
		allowedSkills := s.Environment.Skills
		if s.Automatic != nil {
			allowedSkills = s.Automatic.Skills
		}
		for _, allowed := range allowedSkills {
			if r.ID == allowed.ID && r.Revision == allowed.Revision && (r.Digest == "" || r.Digest == allowed.Digest) {
				ok = true
			}
		}
		if !ok {
			return bad("skill-denied", "显式技能不在会话环境中")
		}
	}
	for _, r := range input.Resources {
		ok := false
		for _, allowed := range s.Environment.Resources {
			if r == allowed {
				ok = true
			}
		}
		if !ok {
			return bad("resource-denied", "显式资料不在会话授权范围中")
		}
	}
	for _, p := range input.Prompts {
		ok := false
		for _, server := range s.Environment.Servers {
			if server.ID == p.ServerID {
				ok = true
			}
		}
		if !ok {
			return bad("prompt-denied", "提示模板服务不在会话环境中")
		}
		if _, err := jsonvalue.Object(p.Arguments); err != nil {
			return bad("invalid-prompt", "提示模板参数无效")
		}
	}
	return nil
}
func trusted(s CapabilitySnapshot, c Capability) bool {
	if c.Source == toolDiscoverySource {
		return c.Name == toolSearchName && c.ReadOnly
	}
	if c.Source == "builtin" {
		return confirmedPlatformRead(c)
	}
	// Task workspace reads are local immutable reads. They do not need the
	// explicit trustedReadOnly opt-in required for external MCP capabilities;
	// writes remain approval-gated because ReadOnly is false.
	if c.Source == "workspace" {
		return c.Name == TaskWorkspaceList || c.Name == TaskWorkspaceRead
	}
	if !c.ReadOnly || c.Source == "script" {
		return false
	}
	if s.ToolLoading == onDemandToolsV2 && (c.Source == "mcp-tool" || c.Source == "mcp-resource" || c.Source == "mcp-prompt") {
		return c.ReadOnly
	}
	for _, name := range s.Environment.TrustedReadOnly {
		if name == c.Name {
			return true
		}
	}
	return c.Source == "skill-load"
}

func (a *agentExecution) executeOperation(ctx context.Context, index int, proposal model.ToolCall, args json.RawMessage) (operationErr error) {
	defer func() { operationErr = capabilityError(operationErr) }()
	m := a.manager
	c, ok := a.capability(proposal.Name)
	if !ok {
		return bad("tool-denied", "能力不存在")
	}
	if err := a.validateProposal(proposal.Name, args); err != nil {
		return err
	}
	if a.pending != nil {
		if err := a.validateVisibleProposal(*a.pending, proposal.Name); err != nil {
			return err
		}
	}
	m.mu.Lock()
	execution := m.executionLocked(a.run.ID)
	dbCtx := context.Background()
	run, err := m.store.get(dbCtx, a.run.ID)
	if err != nil {
		m.storageFailedLocked()
		m.mu.Unlock()
		return storageFailure(err)
	}
	if m.closed || execution == nil || execution.finishing || run.Status != StateRunning || run.CancelRequestedAt != "" || ctx.Err() != nil {
		m.mu.Unlock()
		return context.Canceled
	}
	originID := ""
	if a.pending != nil {
		originID = a.pending.ID
	}
	var raw string
	var o Operation
	scopeClosed := false
	var scopeCloseError error
	closeScope := func() error {
		if scopeClosed || o.ID == "" {
			return scopeCloseError
		}
		scopeClosed = true
		if closer, ok := m.deps.Catalog.(operationScopeCloser); ok {
			scopeCloseError = closer.CloseOperation(context.Background(), o)
		}
		return scopeCloseError
	}
	// The admitted catalogue check may open a stdio process. Reap its scope
	// on every return, including cancellation and storage errors.
	defer func() {
		if closeErr := closeScope(); closeErr != nil {
			m.mu.Lock()
			execution.unresponsive = true
			m.blocked = "MCP 容器停止未确认，任务派发已暂停"
			m.mu.Unlock()
			operationErr = errors.Join(operationErr, closeErr)
		}
	}()
	err = m.store.db.QueryRowContext(dbCtx, "SELECT document FROM operations WHERE run_id=? AND model_request_id=? AND call_index=?", run.ID, originID, index).Scan(&raw)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &o)
	} else if errors.Is(err, sql.ErrNoRows) {
		err = nil
		o = Operation{ID: m.deps.NewID(), RunID: run.ID, TaskID: run.TaskID, ModelRequestID: originID, CallIndex: index, ModelCallID: proposal.ID, ArgumentsJSON: string(args), Capability: c, SnapshotDigest: a.run.Snapshot.Digest, Status: "planned", CreatedAt: stamp(m.deps.Now()), CallID: m.deps.NewID()}
		o.Source = "model"
		if workflowDriver(run) == "operation" {
			o.Source = "workflow"
		}
		o.WorkflowID = run.WorkflowID
		o.ScopeID, o.NodeID = run.ScopeID, run.NodeID
		o.WorkflowStepID = run.WorkflowStepID
		o.WorkflowAttempt = run.WorkflowAttempt
		v, readErr := readWorkspaceVersion(dbCtx, m.store.db, run.TaskID)
		if readErr != nil {
			m.mu.Unlock()
			return storageFailure(readErr)
		}
		o.WorkspaceRevision = v.Revision
		if c.Source == "script" {
			if err = m.inheritWorkspaceWikiLocked(dbCtx, run, v); err != nil {
				m.mu.Unlock()
				return err
			}
		}
		if preparer, ok := m.deps.Catalog.(operationPreparer); ok {
			o, err = preparer.Prepare(ctx, *a.run.Snapshot, o)
			if err != nil {
				m.mu.Unlock()
				return err
			}
		}
		o.FileChanges, err = m.prepareOperationChanges(ctx, o)
		if err != nil {
			m.mu.Unlock()
			return err
		}
		// Resource identity is derived from the immutable capability snapshot and
		// the exact JSON argument string before an approval can be created.
		o.ResourceClaims, o.ResourceRules = operationResourceClaims(*a.run.Snapshot, o)
		o.ClaimsDigest = digestJSON(o.ResourceClaims)
	} else {
		m.storageFailedLocked()
		m.mu.Unlock()
		return storageFailure(err)
	}
	if o.SnapshotDigest != a.run.Snapshot.Digest || o.ArgumentsJSON != string(args) || o.ModelCallID != proposal.ID {
		m.mu.Unlock()
		return bad("operation-changed", "操作内容与原始快照不符")
	}
	if o.ClaimsDigest == "" {
		if len(o.ResourceClaims) != 0 || len(o.ResourceRules) != 0 {
			m.mu.Unlock()
			return bad("resource-claims-changed", "操作资源声明缺少固定摘要")
		}
		o.ResourceClaims, o.ResourceRules = operationResourceClaims(*a.run.Snapshot, o)
		o.ClaimsDigest = digestJSON(o.ResourceClaims)
	} else {
		claims, refs := operationResourceClaims(*a.run.Snapshot, o)
		storedClaims := o.ResourceClaims
		if storedClaims == nil {
			storedClaims = []ResourceClaim{} // Empty claims are omitted in persisted JSON.
		}
		if digestJSON(claims) != o.ClaimsDigest || digestJSON(storedClaims) != o.ClaimsDigest || digestJSON(refs) != digestJSON(o.ResourceRules) {
			m.mu.Unlock()
			return bad("resource-claims-changed", "操作资源声明与固定快照不符")
		}
	}
	if o.Status == "completed" {
		m.mu.Unlock()
		return nil
	}
	if o.Status == "dispatched" || o.Status == "unknown" {
		m.mu.Unlock()
		return bad("outcome-unknown", "已派发操作结果未确认，禁止重复执行")
	}
	if err = m.checkRevocations(ctx, *a.run.Snapshot, o); err != nil {
		m.mu.Unlock()
		_ = closeScope()
		return err
	}
	if m.deps.DispatchGuard != nil {
		if err = m.deps.DispatchGuard(); err != nil {
			m.mu.Unlock()
			return err
		}
	}
	if c.Source == "script" {
		items, readErr := readDocuments[ContextItem](ctx, m.store.db, "SELECT document FROM context_items WHERE task_id=?", run.TaskID)
		if readErr != nil {
			m.mu.Unlock()
			return storageFailure(readErr)
		}
		loaded := false
		for _, item := range items {
			if item.Source == "skill-load" && item.Path == "SKILL.md" && item.Ref == c.Ref {
				loaded = true
			}
		}
		if a.run.Snapshot.ToolLoading == onDemandToolsV2 {
			valid, readErr := m.effectiveSkills(ctx, run)
			if readErr != nil {
				m.mu.Unlock()
				return readErr
			}
			loaded = false
			for _, item := range valid {
				if item.Item.Ref == c.Ref {
					loaded = true
				}
			}
		}
		if !loaded {
			m.mu.Unlock()
			return bad("skill-not-loaded", "执行脚本前必须加载该修订的 SKILL.md")
		}
	}

	if err = authorizeOperationScope(*a.run.Snapshot, o); err != nil {
		m.mu.Unlock()
		return err
	}
	direct, decisionSource := operationDecision(*a.run.Snapshot, o)
	o.PolicyVersion = a.run.Snapshot.PolicyVersion
	o.PermissionMode = a.run.Snapshot.PermissionMode
	o.DecisionSource = decisionSource
	if m.deps.DispatchGuard != nil {
		if err = m.deps.DispatchGuard(); err != nil {
			m.mu.Unlock()
			return err
		}
	}
	if !direct && o.ApprovalID == "" {
		var count int
		if err = m.store.db.QueryRowContext(dbCtx, "SELECT COUNT(*) FROM approvals WHERE state='pending'").Scan(&count); err != nil {
			m.mu.Unlock()
			return storageFailure(err)
		}
		if count >= 32 {
			m.mu.Unlock()
			return &Error{429, "approvals-full", "待审批运行已达 32 个上限"}
		}
		o.Policy = "approval-required"
		o.Status = StateWaitingApproval
		o.ApprovalID = m.deps.NewID()
		approval := Approval{Kind: "operation", WorkflowID: run.WorkflowID, WorkflowStepID: run.WorkflowStepID, WorkflowAttempt: run.WorkflowAttempt, ID: o.ApprovalID, RunID: o.RunID, OperationID: o.ID, Status: "pending", CreatedAt: o.CreatedAt, ExpiresAt: stamp(m.deps.Now().Add(24 * time.Hour)), Operation: o}
		approval.ScopeID, approval.NodeID = run.ScopeID, run.NodeID
		_, err = m.store.change(dbCtx, run.ID, "approval-intent", func(tx *sql.Tx, r *Run) error {
			if err := saveOperation(dbCtx, tx, o); err != nil {
				return err
			}
			if err := saveApproval(dbCtx, tx, approval); err != nil {
				return err
			}
			r.Status = StateWaitingApproval
			r.Phase = StateWaitingApproval
			r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: index}
			return m.store.event(dbCtx, tx, r, "approval/request", "", nil, map[string]string{"approvalId": approval.ID, "operationId": o.ID})
		})
		if err != nil {
			m.storageFailedLocked()
			m.mu.Unlock()
			return storageFailure(err)
		}
		m.mu.Unlock()
		_ = closeScope()
		return worker.ErrSuspended
	}
	var approval *Approval
	if !direct {
		var aa Approval
		if err = m.store.db.QueryRowContext(dbCtx, "SELECT document FROM approvals WHERE id=?", o.ApprovalID).Scan(&raw); err == nil {
			err = json.Unmarshal([]byte(raw), &aa)
		}
		if err != nil {
			m.mu.Unlock()
			return storageFailure(err)
		}
		if aa.Status != "approved" || approvalExpired(aa, m.deps.Now()) || !approvedOperationMatches(aa.Operation, o) {
			m.mu.Unlock()
			return bad("approval-invalid", "审批已失效或操作发生变化")
		}
		approval = &aa
		o.DecisionSource = "human-approval"
	}
	dispatchedAt := stamp(m.deps.Now())
	call := Call{ID: o.CallID, RunID: run.ID, OperationID: o.ID, ModelRequestID: o.ModelRequestID, ModelCallID: o.ModelCallID, Tool: c.Name, ArgumentsJSON: o.ArgumentsJSON, Status: StateRunning, StartedAt: dispatchedAt, StepIndex: run.Usage.Calls}
	barrier := ExecutionBarrier{WorkflowID: run.WorkflowID, ID: m.deps.NewID(), RunID: run.ID, OperationID: o.ID, Status: "dispatched", CreatedAt: dispatchedAt}
	barrier.ScopeID, barrier.NodeID = run.ScopeID, run.NodeID
	resourceWaiting := false
	_, err = m.store.change(dbCtx, run.ID, "operation-dispatch", func(tx *sql.Tx, r *Run) error {
		if err := recordWikiRunArtifact(dbCtx, tx, *r, "operation", o.ID); err != nil {
			return err
		}
		if r.CancelRequestedAt != "" || r.Status != StateRunning {
			return context.Canceled
		}
		acquired, acquireErr := acquireResourceLease(dbCtx, tx, o, dispatchedAt)
		if acquireErr != nil {
			return acquireErr
		}
		if !acquired {
			resourceWaiting = true
			// Keep approval-bound fields intact while waiting. Legacy resource
			// metadata is derived locally; dispatch starts only after acquisition.
			if err := saveOperation(dbCtx, tx, o); err != nil {
				return err
			}
			r.Status = StateWaitingResource
			r.Phase = StateWaitingResource
			r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: index}
			return m.store.event(dbCtx, tx, r, "resource/waiting", o.CallID, &index, map[string]string{"operationId": o.ID})
		}
		if r.Usage.Calls >= r.Limits.MaxSteps {
			return bad("call-budget", "工具调用次数达到上限")
		}
		if err := m.workflowReserveCall(dbCtx, tx, r); err != nil {
			return err
		}
		if approval != nil {
			approval.Status = "consumed"
			if err := saveApproval(dbCtx, tx, *approval); err != nil {
				return err
			}
		}
		o.Status = "dispatched"
		o.DispatchID = m.deps.NewID()
		if c.Metadata.Async && c.Metadata.TaskDomain != "" {
			arguments, _ := jsonvalue.Object([]byte(o.ArgumentsJSON))
			requestID := taskArgument(arguments, c.Metadata.TaskRequestArgument)
			taskID := taskArgument(arguments, c.Metadata.TaskIDArgument)
			o.Task = &tools.TaskReference{Domain: c.Metadata.TaskDomain, ID: taskID, RequestID: requestID}
		}
		o.DispatchedAt = dispatchedAt
		if direct {
			o.Policy = decisionSource
		}
		if err := saveOperation(dbCtx, tx, o); err != nil {
			return err
		}
		if !c.ReadOnly || externalOperation(o) {
			if err := saveBarrier(dbCtx, tx, barrier); err != nil {
				return err
			}
		}
		if err := saveCall(dbCtx, tx, call); err != nil {
			return err
		}
		r.Usage.Calls++
		return m.store.event(dbCtx, tx, r, "call/started", call.ID, &call.StepIndex, map[string]string{"operationId": o.ID, "dispatchId": o.DispatchID})
	})
	if err != nil {
		if _, ok := err.(*Error); !ok {
			m.storageFailedLocked()
		}
		m.mu.Unlock()
		return err
	}
	if resourceWaiting {
		m.mu.Unlock()
		_ = closeScope()
		return worker.ErrSuspended
	}
	done := make(chan struct{})
	execution.callDone = done
	m.mu.Unlock()
	defer close(done)
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(run.Limits.CallTimeoutSeconds)*time.Second)
	defer cancel()
	type outcome struct {
		r CapabilityResult
		e error
	}
	results := make(chan outcome, 1)
	go func() {
		var result outcome
		defer func() {
			if recover() != nil {
				result.e = bad("operation-failed", "操作内部错误")
				result.r.Unknown = !c.ReadOnly || externalOperation(o)
			}
			results <- result
		}()
		if result.e = m.store.recordsFault(); result.e != nil {
			return
		}
		m.mu.Lock()
		if m.closed || execution.finishing || m.storageError || callCtx.Err() != nil {
			result.e = context.Canceled
		} else if m.store.recordsFault() != nil {
			result.e = m.store.recordsFault()
		} else if result.e = m.checkRevocations(callCtx, *a.run.Snapshot, o); result.e == nil && m.deps.DispatchGuard != nil {
			result.e = m.deps.DispatchGuard()
		}
		m.mu.Unlock()
		if result.e != nil {
			return
		}
		authorized, authErr := m.authorizeDispatch(callCtx, *a.run.Snapshot, o)
		if authErr != nil {
			result.e = authErr
			return
		}
		result.r, result.e = m.executeRegistryOperation(authorized, *a.run.Snapshot, o, run.Limits.ResultBytes)
	}()
	var result outcome
	select {
	case result = <-results:
	case <-callCtx.Done():
		timer := time.NewTimer(time.Duration(run.Limits.CancelGraceSeconds) * time.Second)
		select {
		case result = <-results:
			timer.Stop()
		case <-timer.C:
			result.e = bad("operation-unresponsive", "操作未确认停止")
			result.r.Unknown = true
			m.mu.Lock()
			execution.unresponsive = true
			m.blocked = "操作未确认停止，任务派发已暂停"
			m.mu.Unlock()
		}
	}
	if callCtx.Err() != nil {
		result.e = callCtx.Err()
		result.r.Unknown = externalOperation(o) || result.r.Unknown
	}
	if closeErr := closeScope(); closeErr != nil {
		result.r.Unknown = externalOperation(o) || result.r.Unknown
		if result.e == nil {
			result.e = closeErr
		}
	}
	// 只有同一任务、同一审批基线且已发布的实体版本可以推进数据库指针。
	if v := result.r.Workspace; v != nil && !result.r.Unknown {
		valid := v.TaskID == run.TaskID && v.BaseRevision == o.WorkspaceRevision && v.Revision > v.BaseRevision && m.deps.Workspaces != nil
		if valid {
			actual, verifyErr := m.deps.Workspaces.Version(ctx, v.TaskID, v.Revision)
			valid = verifyErr == nil && actual == *v
		}
		if !valid {
			result.r.Workspace = nil
			result.e = bad("workspace-result-invalid", "工作区结果与任务、已批准基线或文件版本不符，保留原工作区")
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.storageError {
		return storageFailure(errors.New("存储失败"))
	}
	if result.r.Task != nil {
		o.Task = result.r.Task
		o.PendingResult = append(json.RawMessage(nil), result.r.Value...)
		o.Status = StateWaitingTask
		_, err = m.store.change(dbCtx, run.ID, "operation-task-accepted", func(tx *sql.Tx, r *Run) error {
			if err := saveOperation(dbCtx, tx, o); err != nil {
				return err
			}
			if err := saveCall(dbCtx, tx, call); err != nil {
				return err
			}
			r.Status = StateWaitingTask
			r.Phase = StateWaitingTask
			r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: index}
			return m.store.event(dbCtx, tx, r, "operation/task-accepted", call.ID, &call.StepIndex, map[string]any{"operationId": o.ID, "task": o.Task})
		})
		if err != nil {
			m.storageFailedLocked()
			return storageFailure(err)
		}
		return worker.ErrSuspended
	}
	o.EndedAt = stamp(m.deps.Now())
	call.EndedAt = o.EndedAt
	o.Status = "completed"
	call.Status = StateSucceeded
	if result.r.Unknown {
		o.Status = "unknown"
		call.Status = StateInterrupted
		call.Error = &Failure{Code: "outcome-unknown", Message: "操作已派发，结果未确认"}
	}
	if result.e != nil && call.Error == nil {
		call.Status = StateFailed
		call.Error = &Failure{Code: "operation-failed", Message: "操作执行失败，运行已停止"}
		var typed *Error
		if errors.As(capabilityError(result.e), &typed) {
			call.Error = &Failure{Code: typed.Code, Message: typed.Message}
		}
	}
	if result.r.BusinessError != nil {
		call.Status = StateFailed
		call.Error = result.r.BusinessError
	}
	if len(result.r.Value) > run.Limits.ResultBytes {
		call.Status = StateFailed
		call.Error = &Failure{Code: "result-too-large", Message: "操作结果超过单次容量限制"}
		result.r.Value = nil
		result.e = bad("result-too-large", call.Error.Message)
	}
	o.Error = call.Error
	call.Result = result.r.Value
	_, err = m.store.change(dbCtx, run.ID, "operation-result", func(tx *sql.Tx, r *Run) error {
		if r.Usage.ResultBytes+len(call.Result) > r.Limits.RunResultBytes {
			call.Result = nil
			call.Status = StateFailed
			call.Error = &Failure{Code: "result-budget", Message: "运行结果总量达到上限"}
			o.Error = call.Error
			result.e = bad("result-budget", call.Error.Message)
		}
		if err := m.workflowSettleCall(dbCtx, tx, r, len(call.Result)); err != nil {
			return err
		}
		r.Usage.ResultBytes += len(call.Result)
		if result.r.Workspace != nil && !result.r.Unknown {
			if err := commitWorkspaceVersion(dbCtx, tx, *result.r.Workspace); err != nil {
				return err
			}
			refs, e := wikiArtifactRefs(dbCtx, tx, "run", r.ID)
			if e != nil {
				return e
			}
			baseRefs, e := wikiArtifactRefs(dbCtx, tx, "workspace", r.TaskID+":"+strconv.Itoa(result.r.Workspace.BaseRevision))
			if e != nil {
				return e
			}
			refs = mergeWikiRefs(refs, baseRefs)
			// 即使派发后来源撤回，也保留文件事实并隔离其来源，不丢弃外部结果。
			key := r.TaskID + ":" + strconv.Itoa(result.r.Workspace.Revision)
			if _, e = tx.ExecContext(dbCtx, "INSERT OR IGNORE INTO wiki_artifacts(kind,id,task_id,run_id) VALUES('workspace',?,?,?)", key, r.TaskID, r.ID); e != nil {
				return e
			}
			for _, ref := range refs {
				if _, e = tx.ExecContext(dbCtx, "INSERT OR IGNORE INTO wiki_dependencies(kind,id,page_id,revision,digest) VALUES('workspace',?,?,?,?)", key, ref.PageID, ref.Revision, ref.Digest); e != nil {
					return e
				}
			}
			if invalid, e := wikiArtifactInvalid(dbCtx, tx, "run", r.ID); e != nil {
				return e
			} else if invalid {
				if _, e = tx.ExecContext(dbCtx, "UPDATE wiki_artifacts SET invalidated=1 WHERE kind='workspace' AND id=?", key); e != nil {
					return e
				}
			}
		}
		if !c.ReadOnly || externalOperation(o) || result.r.Unknown {
			if result.r.Unknown {
				barrier.Status = "unknown"
			} else {
				barrier.Status = "confirmed"
			}
			if err := saveBarrier(dbCtx, tx, barrier); err != nil {
				return err
			}
		}
		// Every operation owns a resource lease, including trusted built-ins.
		// Built-ins do not create an execution barrier, but their lease still
		// must be released after the result or it would block later dispatches.
		if err := settleResourceLease(dbCtx, tx, o.ID, o.EndedAt, result.r.Unknown, "", ""); err != nil {
			return err
		}
		if err := saveOperation(dbCtx, tx, o); err != nil {
			return err
		}
		if err := saveCall(dbCtx, tx, call); err != nil {
			return err
		}
		if result.r.Context != nil && !result.r.Unknown && result.e == nil && call.Status == StateSucceeded && call.Error == nil {
			item := *result.r.Context
			item.ID = m.deps.NewID()
			item.RunID = r.ID
			item.TaskID = r.TaskID
			item.CreatedAt = o.EndedAt
			item.EventSeq = nextSeq(r.LastSeq)
			item.CallID = call.ID
			item.Content = ""
			b, _ := json.Marshal(item)
			if _, err := tx.ExecContext(dbCtx, "INSERT INTO context_items(id,run_id,task_id,document) VALUES(?,?,?,?)", item.ID, item.RunID, item.TaskID, string(b)); err != nil {
				return err
			}
		}
		r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: index + 1}
		if workflowDriver(*r) == "operation" && call.Status == StateSucceeded && r.CancelRequestedAt == "" && ctx.Err() == nil {
			output := string(call.Result)
			if output == "" {
				output = "null"
			}
			if e := validateWorkflowJSON(r.WorkflowOutputSchemaJSON, output); e != nil {
				result.e = e
			} else {
				r.WorkflowOutputCallID = call.ID
				r.Status = StateSucceeded
				r.EndedAt = o.EndedAt
				r.EndReason = "completed"
			}
		}
		return m.store.event(dbCtx, tx, r, "call/finished", call.ID, &call.StepIndex, map[string]any{"operationId": o.ID, "status": call.Status, "error": call.Error})
	})
	if err != nil {
		m.storageFailedLocked()
		return storageFailure(err)
	}
	execution.nextStep++
	if result.r.Unknown {
		return bad("outcome-unknown", "操作结果未知，必须人工核实")
	}
	if result.e != nil {
		return result.e
	}
	if workflowDriver(run) == "operation" && call.Status != StateSucceeded {
		return bad("operation-failed", "步骤能力调用失败，需要人工恢复")
	}
	return nil
}

// 仅转交各扩展包明确公开的错误，不输出底层诊断或服务正文。
func capabilityError(err error) error {
	var remote *mcp.Error
	var container *execution.Error
	var config *execconfig.Error
	var skill *skills.Error
	var files *workspace.Error
	switch {
	case errors.As(err, &remote):
		return &Error{remote.Status, remote.Code, remote.Message}
	case errors.As(err, &container):
		return &Error{container.Status, container.Code, container.Message}
	case errors.As(err, &config):
		return &Error{config.Status, config.Code, config.Message}
	case errors.As(err, &skill):
		return &Error{skill.Status, skill.Code, skill.Message}
	case errors.As(err, &files):
		return &Error{files.Status, files.Code, files.Message}
	default:
		return err
	}
}
