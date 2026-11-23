package harness

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	execconfig "elysian/server/internal/agent/execution/config"
	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
)

func (m *Manager) SessionAuthorizations(ctx context.Context, sessionID string) ([]SessionAuthorization, error) {
	if _, err := readSession(ctx, m.store, sessionID); err != nil {
		return nil, storageFailure(err)
	}
	rows, err := readView(ctx, m.store).SessionAuthorizations(ctx, sessionID)
	if rows == nil {
		rows = []SessionAuthorization{}
	}
	return rows, storageFailure(err)
}
func (m *Manager) matchingAuthorization(ctx context.Context, run Run, o Operation) (*SessionAuthorization, error) {
	if o.Access == nil {
		return nil, nil
	}
	rows, err := readView(ctx, m.store).MatchingAuthorizations(ctx, run.SessionID, o.Access.ScopeKey)
	if err != nil {
		return nil, storageFailure(err)
	}
	if len(rows) > 0 {
		if o.Execution != nil && (rows[0].ExecutionProfile == nil || o.Execution.Profile.TimeoutSeconds > rows[0].ExecutionProfile.TimeoutSeconds) {
			return nil, nil
		}
		if o.Access.Runtime != nil && o.Access.Runtime.RequiresDownload && (rows[0].Access.Runtime == nil || !rows[0].Access.Runtime.RequiresDownload) {
			return nil, nil
		}
		return &rows[0], nil
	}
	return nil, nil
}
func (m *Manager) checkOperationAuthorization(ctx context.Context, o Operation) error {
	if o.Access == nil {
		return nil
	}
	if o.Authorization == nil || o.Authorization.ID != o.ID || o.Authorization.Digest != o.Access.Digest || hstate.AccessDigest(o) != o.Access.Digest {
		return bad("authorization-required", "操作尚未获得匹配的运行时授权")
	}
	if id := o.Authorization.SessionAuthorizationID; id != "" {
		var raw string
		if err := readView(ctx, m.store).AuthorizationRecord(ctx, id, &raw); err != nil {
			return bad("authorization-revoked", "本会话授权已撤回")
		}
		var a SessionAuthorization
		if json.Unmarshal([]byte(raw), &a) != nil {
			return bad("authorization-invalid", "会话授权记录无效")
		}
		run, err := readView(ctx, m.store).Get(ctx, o.RunID)
		if err != nil {
			return err
		}
		if a.SessionID != run.SessionID || a.Access.ScopeKey != o.Access.ScopeKey || o.Execution != nil && (a.ExecutionProfile == nil || o.Execution.Profile.TimeoutSeconds > a.ExecutionProfile.TimeoutSeconds) {
			return bad("authorization-changed", "会话授权范围不匹配")
		}
	}
	return nil
}
func (m *Manager) DecideAccess(ctx context.Context, id string, in AccessDecision) (Approval, error) {
	guardErr := m.checkDispatchGuard()
	m.mu.Lock()
	defer m.mu.Unlock()
	var a Approval
	if m.closed {
		return a, closedError()
	}
	if !requestPattern.MatchString(in.RequestID) || in.ExpectedRevision < 1 || in.ExpectedDigest == "" || (in.Decision != "once" && in.Decision != "session" && in.Decision != "denied") {
		return a, bad("invalid-access-decision", "授权决定或请求编号无效")
	}
	if err := m.store.DispatchError(); err != nil {
		return a, storageFailure(err)
	}
	if guardErr != nil {
		return a, guardErr
	}
	err := writeStore(m.store, ctx, "access-decision", func(tx sessionstore.Tx) error {
		var raw string
		if err := tx.ApprovalRecord(ctx, id, &raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &a); err != nil {
			return err
		}
		if a.Access == nil {
			return bad("invalid-access-decision", "该审批不支持运行时授权")
		}
		if a.AccessDecision != nil {
			if *a.AccessDecision == in {
				return nil
			}
			return &Error{Status: 409, Code: "decision-conflict", Message: "该申请已有其他决定"}
		}
		if a.Status != "pending" || approvalExpired(a, m.deps.Now()) || a.Access.Revision != in.ExpectedRevision || a.Access.Digest != in.ExpectedDigest {
			return &Error{Status: 409, Code: "access-conflict", Message: "授权申请已变化、过期或处理，请重新读取"}
		}
		r, err := readRun(ctx, tx, a.RunID)
		if err != nil {
			return err
		}
		if r.Status != StateWaitingApproval || r.CancelRequestedAt != "" || r.WorkflowID != "" || r.Snapshot == nil || r.Snapshot.AuthorizationMode != AuthorizationOnDemand {
			return &Error{Status: 409, Code: "run-state-conflict", Message: "运行已不在授权等待状态"}
		}
		if in.Decision == "session" && (r.Snapshot.PolicyVersion == PermissionPolicyVersion || !a.Access.SessionAllowed) {
			return bad("session-authorization-denied", "该操作只能授权本次")
		}
		var queued int
		if err = tx.QueuedRunCount(ctx, &queued); err != nil {
			return err
		}
		if queued >= r.Limits.QueueCapacity {
			return &Error{Status: 429, Code: "queue-full", Message: "任务队列已满，授权保持待处理"}
		}
		o, err := readOperation(ctx, tx, a.OperationID)
		if err != nil {
			return err
		}
		if o.Access == nil || hstate.AccessDigest(o) != a.Access.Digest || !hstate.ApprovedOperationMatches(a.Operation, o) {
			return &Error{Status: 409, Code: "access-changed", Message: "待执行操作与授权申请不符"}
		}
		now := stamp(m.deps.Now())
		if in.Decision != "denied" {
			o.Authorization = &OperationAuthorization{ID: o.ID, Digest: a.Access.Digest, Decision: in.Decision, CreatedAt: now}
			if in.Decision == "session" {
				var count int
				if err = tx.AuthorizationExists(ctx, r.SessionID, &count); err != nil {
					return err
				}
				if count >= 128 {
					return &Error{Status: 429, Code: "authorizations-full", Message: "本会话允许项达到 128 条，请先撤回不需要的授权"}
				}
				var profile *execconfig.Profile
				if o.Execution != nil {
					value := o.Execution.Profile
					profile = &value
				}
				remembered := SessionAuthorization{ExecutionProfile: profile, ID: m.deps.NewID(), SessionID: r.SessionID, Revision: 1, Status: "active", CreatedAt: now, Tool: o.Capability.Name, Access: *a.Access}
				if err = saveSessionAuthorization(ctx, tx, remembered); err != nil {
					return err
				}
				o.Authorization.SessionAuthorizationID = remembered.ID
			}
			a.Status, a.Decision = "approved", "approved"
		} else {
			a.Status, a.Decision = "denied", "denied"
		}
		a.AccessDecision = &in
		a.DecidedAt = now
		if err = saveOperation(ctx, tx, o); err != nil {
			return err
		}
		if err = saveApproval(ctx, tx, a); err != nil {
			return err
		}
		r.Status, r.Phase = StateQueued, StateQueued
		return tx.Event(ctx, &r, "access/"+in.Decision, "", nil, map[string]string{"approvalId": a.ID, "operationId": o.ID})
	})
	if err == nil {
		m.signal()
	}
	return a, storageFailure(err)
}
func (m *Manager) RevokeSessionAuthorization(ctx context.Context, sessionID, id string, in RevokeAuthorizationInput) (SessionAuthorization, error) {
	var a SessionAuthorization
	if !requestPattern.MatchString(in.RequestID) || in.ExpectedRevision < 1 {
		return a, bad("invalid-revocation", "撤回请求编号或版本无效")
	}
	guardErr := m.checkDispatchGuard()
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return a, closedError()
	}
	if guardErr != nil {
		m.mu.Unlock()
		return a, guardErr
	}
	var affected []Operation
	err := writeStore(m.store, ctx, "session-authorization-revoke", func(tx sessionstore.Tx) error {
		var raw string
		if err := tx.SessionAuthorizationRecord(ctx, id, sessionID, &raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &a); err != nil {
			return err
		}
		replayed := a.Status == "revoked" && a.RevokeRequestID == in.RequestID && a.Revision == in.ExpectedRevision+1
		if !replayed && (a.Status != "active" || a.Revision != in.ExpectedRevision) {
			return &Error{Status: 409, Code: "authorization-conflict", Message: "会话授权已变化，请重新读取"}
		}
		if !replayed {
			a.Status = "revoked"
			a.Revision++
			a.RevokedAt = stamp(m.deps.Now())
			a.RevokeRequestID = in.RequestID
			if err := saveSessionAuthorization(ctx, tx, a); err != nil {
				return err
			}
		}
		var err error
		affected, err = tx.AuthorizedOperations(ctx, id)
		return err
	})
	m.mu.Unlock()
	if err != nil {
		return a, storageFailure(err)
	}
	var cleanupErr error
	for _, o := range affected {
		if _, cancelErr := m.Cancel(ctx, o.RunID); cancelErr != nil {
			cleanupErr = errors.Join(cleanupErr, cancelErr)
		}
		if e, ok := m.deps.Catalog.(*Extensions); ok && e.Executor != nil {
			stopCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			stopErr := e.Executor.RevokeRuntimeAuthorization(stopCtx, o.ID)
			cancel()
			cleanupErr = errors.Join(cleanupErr, stopErr)
		}
	}
	return a, cleanupErr
}

// Rejected requests are real tool results, without a dispatch, resource lease, or side effect.
// The caller holds Manager.mu. Replaying the same model call reuses its completed result.
func (m *Manager) finishAccessDenied(ctx context.Context, run Run, o Operation) error {
	_, err := m.store.ChangeRun(ctx, run.ID, "access-denied-result", func(tx sessionstore.Tx, r *Run) error {
		if r.CancelRequestedAt != "" || r.Status != StateRunning {
			return context.Canceled
		}
		if callLimitReached(*r) {
			return bad("call-budget", "工具调用次数达到上限")
		}
		now := stamp(m.deps.Now())
		o.Status = "completed"
		o.EndedAt = now
		o.Error = &Failure{Code: "access-denied", Message: "用户拒绝此权限；请使用更小范围或其他办法，不得重复申请相同权限"}
		call := Call{ID: o.CallID, RunID: o.RunID, OperationID: o.ID, ModelRequestID: o.ModelRequestID, ModelCallID: o.ModelCallID, Tool: o.Capability.Name, ArgumentsJSON: o.ArgumentsJSON, Status: StateFailed, StartedAt: now, EndedAt: now, StepIndex: r.Usage.Calls, Error: o.Error, Result: json.RawMessage(`{"denied":true}`)}
		if resourceBudgetRun(*r) {
			if err := ensureResultBudget(ctx, tx, *r, len(call.Result)); err != nil {
				return err
			}
			r.Usage.ResultBytes += len(call.Result)
		}
		if err := saveOperation(ctx, tx, o); err != nil {
			return err
		}
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		r.Usage.Calls++
		r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: o.CallIndex + 1}
		return tx.Event(ctx, r, "access/denied", call.ID, &call.StepIndex, nil)
	})
	return storageFailure(err)
}
func (m *Manager) accessWasDenied(ctx context.Context, run Run, o Operation) (bool, error) {
	var count int
	err := readView(ctx, m.store).DeniedAccessCount(ctx, run.ID, o.Access.ScopeKey, &count)
	return count > 0, err
}
