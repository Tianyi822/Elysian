package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"elysian/server/internal/agent/execution"
	"elysian/server/internal/agent/harness/worker"
)

type RuntimePreparation struct {
	State   string `json:"state"`
	Current int64  `json:"current,omitempty"`
	Total   int64  `json:"total,omitempty"`
	Error   string `json:"error,omitempty"`
}

func (m *Manager) prepareAuthorizedRuntime(ctx context.Context, run Run, o Operation) (Operation, error) {
	e, ok := m.deps.Catalog.(*Extensions)
	if !ok || e.Executor == nil {
		return o, bad("execution-unavailable", "运行环境执行器不可用")
	}
	env := execution.RuntimeEnvironment{Profile: o.Execution.Profile, Platform: o.Access.Runtime.Platform, RequiresDownload: o.Access.Runtime.RequiresDownload}
	progress := func(p execution.RuntimeProgress) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closed || ctx.Err() != nil {
			return context.Canceled
		}
		if err := m.checkOperationAuthorization(context.Background(), o); err != nil {
			return err
		}
		if m.deps.DispatchGuard != nil {
			if err := m.deps.DispatchGuard(); err != nil {
				return err
			}
		}
		next := &RuntimePreparation{State: p.State, Current: p.Current, Total: p.Total}
		if o.Preparation != nil && *o.Preparation == *next {
			return nil
		}
		o.Preparation = next
		_, err := m.store.change(context.Background(), run.ID, "runtime-preparation", func(tx *sql.Tx, r *Run) error {
			if r.CancelRequestedAt != "" || r.Status != StateRunning {
				return context.Canceled
			}
			if err := saveOperation(context.Background(), tx, o); err != nil {
				return err
			}
			if p.State == "pulling" {
				r.Phase = "preparing-runtime"
			} else {
				r.Phase = StateRunning
			}
			return m.store.event(context.Background(), tx, r, "runtime/"+p.State, "", nil, map[string]string{"operationId": o.ID})
		})
		return storageFailure(err)
	}
	// Ensure persists the pulling transition before making the Docker mutation.
	var err error
	if o.Preparation != nil && o.Preparation.State == "unknown" {
		installed, inspectErr := e.Executor.InspectRuntime(ctx, env)
		if inspectErr == nil && installed {
			err = progress(execution.RuntimeProgress{State: "ready"})
		} else {
			err = &execution.Error{Status: 409, Code: "runtime-preparation-unknown", Message: "运行环境准备结果未确认", OutcomeUnknown: true}
		}
	} else {
		err = e.Executor.EnsureRuntime(ctx, env, progress)
	}
	if err == nil {
		return o, nil
	}
	if ctx.Err() != nil {
		if m.ctx.Err() == nil {
			return o, ctx.Err()
		}
		// Shutdown interrupts the download stream, never the durable permission wait.
		// Preserve the original Run at a new verification-only request.
		err = &execution.Error{Status: 409, Code: "runtime-preparation-unknown", Message: "面板关闭时镜像准备结果未确认", OutcomeUnknown: true}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	state := "failed"
	var execErr *execution.Error
	if errors.As(err, &execErr) && execErr.OutcomeUnknown {
		state = "unknown"
	}
	o.Preparation = &RuntimePreparation{State: state, Error: "运行环境准备失败，请核对后重试"}
	if state == "unknown" {
		o.Preparation.Error = "运行环境准备结果未确认，请先核实镜像状态"
	}
	_, saveErr := m.store.change(context.Background(), run.ID, "runtime-preparation-failed", func(tx *sql.Tx, r *Run) error {
		if r.CancelRequestedAt != "" || r.Status != StateRunning {
			return context.Canceled
		}
		if o.ApprovalID != "" {
			var raw string
			var previous Approval
			if err := tx.QueryRow("SELECT document FROM approvals WHERE id=?", o.ApprovalID).Scan(&raw); err != nil {
				return err
			}
			if err := json.Unmarshal([]byte(raw), &previous); err != nil {
				return err
			}
			previous.Status = "revoked"
			if err := saveApproval(context.Background(), tx, previous); err != nil {
				return err
			}
		}
		o.Authorization = nil
		o.Access.Revision++
		if execErr != nil && execErr.Code == "execution-runtime-missing" {
			o.Access.Runtime.RequiresDownload = true
		}
		o.Access.Reason = o.Preparation.Error
		if state == "unknown" {
			o.Access.Reason += "；再次确认仅核实本机镜像，未确认前不会重新下载或执行。"
		}
		o.Access.Digest = accessDigest(o)
		o.ApprovalID = m.deps.NewID()
		o.Status, o.Policy, o.DecisionSource = StateWaitingApproval, "approval-required", "human-approval"
		a := Approval{Kind: "operation", ID: o.ApprovalID, RunID: o.RunID, OperationID: o.ID, Status: "pending", CreatedAt: stamp(m.deps.Now()), ExpiresAt: stamp(m.deps.Now().Add(24 * time.Hour)), Access: o.Access, Operation: o}
		if err := saveApproval(context.Background(), tx, a); err != nil {
			return err
		}
		r.Status, r.Phase = StateWaitingApproval, StateWaitingApproval
		r.Resume = &RecoveryCursor{ResponseID: o.ModelRequestID, CallIndex: o.CallIndex}

		if err := saveOperation(context.Background(), tx, o); err != nil {
			return err
		}
		return m.store.event(context.Background(), tx, r, "runtime/"+state, "", nil, map[string]string{"operationId": o.ID})
	})
	if saveErr != nil {
		return o, storageFailure(saveErr)
	}
	return o, worker.ErrSuspended
}
