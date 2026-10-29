package harness

import (
	"context"
	"database/sql"
	execconfig "elysian/server/internal/agent/execution/config"
	"encoding/json"
	"errors"
	"time"
)

func saveSessionAuthorization(ctx context.Context, tx *sql.Tx, a SessionAuthorization) error {
	raw, err := json.Marshal(a)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO session_authorizations(id,session_id,scope_key,state,document) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,document=excluded.document`, a.ID, a.SessionID, a.Access.ScopeKey, a.Status, string(raw))
	return err
}
func (m *Manager) SessionAuthorizations(ctx context.Context, sessionID string) ([]SessionAuthorization, error) {
	if _, err := readSession(ctx, m.store.db, sessionID); err != nil {
		return nil, storageFailure(err)
	}
	rows, err := readDocuments[SessionAuthorization](ctx, m.store.db, "SELECT document FROM session_authorizations WHERE session_id=? AND state='active' ORDER BY rowid DESC", sessionID)
	if rows == nil {
		rows = []SessionAuthorization{}
	}
	return rows, storageFailure(err)
}
func (m *Manager) matchingAuthorization(ctx context.Context, run Run, o Operation) (*SessionAuthorization, error) {
	if o.Access == nil {
		return nil, nil
	}
	rows, err := readDocuments[SessionAuthorization](ctx, m.store.db, "SELECT document FROM session_authorizations WHERE session_id=? AND scope_key=? AND state='active' ORDER BY rowid DESC LIMIT 1", run.SessionID, o.Access.ScopeKey)
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
	if o.Authorization == nil || o.Authorization.ID != o.ID || o.Authorization.Digest != o.Access.Digest || accessDigest(o) != o.Access.Digest {
		return bad("authorization-required", "操作尚未获得匹配的运行时授权")
	}
	if id := o.Authorization.SessionAuthorizationID; id != "" {
		var raw string
		if err := m.store.db.QueryRowContext(ctx, "SELECT document FROM session_authorizations WHERE id=? AND state='active'", id).Scan(&raw); err != nil {
			return bad("authorization-revoked", "本会话授权已撤回")
		}
		var a SessionAuthorization
		if json.Unmarshal([]byte(raw), &a) != nil {
			return bad("authorization-invalid", "会话授权记录无效")
		}
		run, err := m.store.get(ctx, o.RunID)
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
	m.mu.Lock()
	defer m.mu.Unlock()
	var a Approval
	if m.closed {
		return a, closedError()
	}
	if !requestPattern.MatchString(in.RequestID) || in.ExpectedRevision < 1 || in.ExpectedDigest == "" || (in.Decision != "once" && in.Decision != "session" && in.Decision != "denied") {
		return a, bad("invalid-access-decision", "授权决定或请求编号无效")
	}
	if err := m.store.recordsFault(); err != nil {
		return a, storageFailure(err)
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			return a, err
		}
	}
	err := m.store.write(ctx, "access-decision", func(tx *sql.Tx) error {
		var raw string
		if err := tx.QueryRowContext(ctx, "SELECT document FROM approvals WHERE id=?", id).Scan(&raw); err != nil {
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
			return &Error{409, "decision-conflict", "该申请已有其他决定"}
		}
		if a.Status != "pending" || approvalExpired(a, m.deps.Now()) || a.Access.Revision != in.ExpectedRevision || a.Access.Digest != in.ExpectedDigest {
			return &Error{409, "access-conflict", "授权申请已变化、过期或处理，请重新读取"}
		}
		r, err := readRun(ctx, tx, a.RunID)
		if err != nil {
			return err
		}
		if r.Status != StateWaitingApproval || r.CancelRequestedAt != "" || r.WorkflowID != "" || r.Snapshot == nil || r.Snapshot.AuthorizationMode != AuthorizationOnDemand {
			return &Error{409, "run-state-conflict", "运行已不在授权等待状态"}
		}
		if in.Decision == "session" && (r.Snapshot.PolicyVersion == PermissionPolicyVersion || !a.Access.SessionAllowed) {
			return bad("session-authorization-denied", "该操作只能授权本次")
		}
		var queued int
		if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM runs WHERE state='queued'").Scan(&queued); err != nil {
			return err
		}
		if queued >= r.Limits.QueueCapacity {
			return &Error{429, "queue-full", "任务队列已满，授权保持待处理"}
		}
		if err = m.validateWikiRun(ctx, tx, r.ID); err != nil {
			return err
		}
		o, err := readOperation(ctx, tx, a.OperationID)
		if err != nil {
			return err
		}
		if o.Access == nil || accessDigest(o) != a.Access.Digest || !approvedOperationMatches(a.Operation, o) {
			return &Error{409, "access-changed", "待执行操作与授权申请不符"}
		}
		now := stamp(m.deps.Now())
		if in.Decision != "denied" {
			o.Authorization = &OperationAuthorization{ID: o.ID, Digest: a.Access.Digest, Decision: in.Decision, CreatedAt: now}
			if in.Decision == "session" {
				var count int
				if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM session_authorizations WHERE session_id=? AND state='active'", r.SessionID).Scan(&count); err != nil {
					return err
				}
				if count >= 128 {
					return &Error{429, "authorizations-full", "本会话允许项达到 128 条，请先撤回不需要的授权"}
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
		return m.store.event(ctx, tx, &r, "access/"+in.Decision, "", nil, map[string]string{"approvalId": a.ID, "operationId": o.ID})
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
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return a, closedError()
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			m.mu.Unlock()
			return a, err
		}
	}
	var affected []Operation
	err := m.store.write(ctx, "session-authorization-revoke", func(tx *sql.Tx) error {
		var raw string
		if err := tx.QueryRowContext(ctx, "SELECT document FROM session_authorizations WHERE id=? AND session_id=?", id, sessionID).Scan(&raw); err != nil {
			return err
		}
		if err := json.Unmarshal([]byte(raw), &a); err != nil {
			return err
		}
		replayed := a.Status == "revoked" && a.RevokeRequestID == in.RequestID && a.Revision == in.ExpectedRevision+1
		if !replayed && (a.Status != "active" || a.Revision != in.ExpectedRevision) {
			return &Error{409, "authorization-conflict", "会话授权已变化，请重新读取"}
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
		affected, err = readDocuments[Operation](ctx, tx, "SELECT document FROM operations WHERE json_extract(document,'$.authorization.sessionAuthorizationId')=? AND (state IN ('dispatched','waiting-task') OR json_extract(document,'$.preparation.state')='pulling')", id)
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
	_, err := m.store.change(ctx, run.ID, "access-denied-result", func(tx *sql.Tx, r *Run) error {
		if r.CancelRequestedAt != "" || r.Status != StateRunning {
			return context.Canceled
		}
		if r.Usage.Calls >= r.Limits.MaxSteps {
			return bad("call-budget", "工具调用次数达到上限")
		}
		now := stamp(m.deps.Now())
		o.Status = "completed"
		o.EndedAt = now
		o.Error = &Failure{Code: "access-denied", Message: "用户拒绝此权限；请使用更小范围或其他办法，不得重复申请相同权限"}
		call := Call{ID: o.CallID, RunID: o.RunID, OperationID: o.ID, ModelRequestID: o.ModelRequestID, ModelCallID: o.ModelCallID, Tool: o.Capability.Name, ArgumentsJSON: o.ArgumentsJSON, Status: StateFailed, StartedAt: now, EndedAt: now, StepIndex: r.Usage.Calls, Error: o.Error, Result: json.RawMessage(`{"denied":true}`)}
		if err := saveOperation(ctx, tx, o); err != nil {
			return err
		}
		if err := saveCall(ctx, tx, call); err != nil {
			return err
		}
		r.Usage.Calls++
		r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: o.CallIndex + 1}
		return m.store.event(ctx, tx, r, "access/denied", call.ID, &call.StepIndex, nil)
	})
	return storageFailure(err)
}
func (m *Manager) accessWasDenied(ctx context.Context, run Run, o Operation) (bool, error) {
	var count int
	err := m.store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM operations WHERE run_id=? AND json_extract(document,'$.access.scopeKey')=? AND json_extract(document,'$.error.code')='access-denied'`, run.ID, o.Access.ScopeKey).Scan(&count)
	return count > 0, err
}
