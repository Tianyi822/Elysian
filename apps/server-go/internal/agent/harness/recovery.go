package harness

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"elysian/server/internal/agent/jsonvalue"
	"elysian/server/internal/agent/tools"
)

const evidenceRecoveryPolicy = "evidence-recovery/v1"
const recoveryWindow = 2 * time.Minute

type RunRecovery struct {
	OperationID string `json:"operationId"`
	Tool        string `json:"tool"`
	StartedAt   string `json:"startedAt"`
	Deadline    string `json:"deadline"`
	NextCheckAt string `json:"nextCheckAt,omitempty"`
	Checks      int    `json:"checks"`
	Status      string `json:"status"` // verifying | recovered | unresolved
	Message     string `json:"message"`
}

type ToolAttempt struct {
	Number int      `json:"number"`
	Error  *Failure `json:"error,omitempty"`
}

func evidenceRecoveryRun(r Run) bool {
	return r.RecoveryPolicy == evidenceRecoveryPolicy && r.SessionID != "" && r.WorkflowID == "" && r.DriverVersion == "v2"
}

func businessFailure(b *tools.BusinessError) *Failure {
	e := b.Evidence
	if e == nil && b.NotDispatched {
		e = &tools.ExecutionEvidence{Execution: "not-started", Changes: "none", Recovery: "correct", Stage: "preflight", Suggestion: "根据具体原因修正参数，必要时重新读取状态；变更参数后重新审批"}
	} else if e == nil && b.NoBusinessEffect {
		e = &tools.ExecutionEvidence{Execution: "finished", Changes: "none", Recovery: "correct"}
	}
	return &Failure{Code: b.Code, Message: b.Message, Evidence: e}
}

// External error flags do not attest absence of mutations. Isolated scripts
// can continue only when the host has captured all effects in a workspace
// version; writable host/network grants require separate verification.
func classifyRecoveryResult(s CapabilitySnapshot, o Operation, result CapabilityResult) CapabilityResult {
	if s.RecoveryPolicy != evidenceRecoveryPolicy || result.BusinessError == nil {
		return result
	}
	failure := *result.BusinessError
	result.BusinessError = &failure
	switch o.Capability.Source {
	case "mcp-tool":
		failure.Evidence = &tools.ExecutionEvidence{Execution: "finished", Changes: "unknown", Recovery: "verify", Stage: "mcp-response", Suggestion: "工具错误响应不能证明没有变更；请只读核实外部服务实际状态"}
		if o.Capability.ReadOnly {
			failure.Evidence.Changes, failure.Evidence.Recovery = "none", "correct"
		} else {
			result.Unknown = true
		}
	case "script", BashSource, BashExec, BashScript:
		if o.Execution == nil || result.Workspace == nil {
			result.Unknown = true
			break
		}
		isolated := true
		if grant := o.Execution.Grant; grant != nil {
			isolated = len(grant.Network) == 0 && len(grant.PrivateCIDRs) == 0
			for _, dir := range grant.Directories {
				if dir.Access != "read" {
					isolated = false
				}
			}
			for _, resource := range grant.Resources {
				if resource.Access != "read" {
					isolated = false
				}
			}
		}
		failure.Evidence = &tools.ExecutionEvidence{Execution: "finished", Changes: "confirmed", Recovery: "correct", Stage: "workspace-verified", Suggestion: "执行已结束且工作区快照已核对；请读取实际文件变化后调整方案"}
		if !isolated {
			result.Unknown = true
			failure.Evidence.Changes, failure.Evidence.Recovery, failure.Evidence.Suggestion = "unknown", "verify", "执行已结束，工作区快照已保留；宿主或网络变更仍须只读核实，不能重复提交"
		}
	}
	return result
}

func (m *Manager) executeRegistryWithRetry(ctx context.Context, s CapabilitySnapshot, o Operation, args map[string]any) (any, error) {
	for attempt := 1; ; attempt++ {
		value, err := m.toolRuntime.Execute(ctx, o.Capability.Name, args)
		b, safe := tools.AsBusinessError(err)
		if s.RecoveryPolicy != evidenceRecoveryPolicy || !o.Capability.ReadOnly || o.Capability.Metadata.Async || !safe || !b.Retryable || ctx.Err() != nil {
			return value, err
		}
		m.mu.Lock()
		_, saveErr := m.store.change(context.Background(), o.RunID, "tool-retry", func(tx *sql.Tx, r *Run) error {
			var call Call
			var raw string
			if err := tx.QueryRowContext(context.Background(), "SELECT document FROM calls WHERE id=?", o.CallID).Scan(&raw); err != nil {
				return err
			}
			if err := json.Unmarshal([]byte(raw), &call); err != nil {
				return err
			}
			call.Attempts = append(call.Attempts, ToolAttempt{Number: attempt, Error: businessFailure(b)})
			if err := saveCall(context.Background(), tx, call); err != nil {
				return err
			}
			if attempt < 3 {
				if r.Status != StateRunning || r.CancelRequestedAt != "" {
					return context.Canceled
				}
				if err := toolTokenBudget(*r); err != nil {
					return err
				}
				if callLimitReached(*r) {
					return bad("call-budget", "工具调用次数达到上限")
				}
				r.Recovery = &RunRecovery{OperationID: o.ID, Tool: o.Capability.Name, StartedAt: stamp(m.deps.Now()), Deadline: stamp(m.deps.Now().Add(time.Duration(r.Limits.CallTimeoutSeconds) * time.Second)), Checks: attempt, Status: "correcting", Message: "只读查询暂时失败，正在按原参数进行有界重试"}
				r.Usage.Calls++
			}
			return m.store.event(context.Background(), tx, r, "recovery/tool-retry", o.CallID, nil, map[string]any{"attempt": attempt, "error": businessFailure(b)})
		})
		m.mu.Unlock()
		if saveErr != nil {
			return nil, saveErr
		}
		if attempt >= 3 {
			return value, err
		}
		if err := waitRecoveryRetry(ctx, attempt); err != nil {
			return nil, err
		}
		authorized, authErr := m.authorizeDispatch(ctx, s, o)
		if authErr != nil {
			return nil, authErr
		}
		ctx = authorized
	}
}

func waitRecoveryRetry(ctx context.Context, attempt int) error {
	delay := time.Second
	if attempt > 1 {
		delay = 3 * time.Second
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Exclude transport identities, never business identifiers such as container id.
func recoveryArguments(c Call) string {
	raw := json.RawMessage(c.ArgumentsJSON)
	if len(raw) == 0 {
		raw, _ = json.Marshal(c.Args)
	}
	key, _ := jsonvalue.RecoveryFingerprint(raw)
	return key
}

// Rebuild from durable facts: restarts cannot reset the no-progress limit.
// New read evidence counts once; search, planning and identical reads do not.
func (a *agentExecution) checkRecoveryProgress(ctx context.Context) error {
	if !evidenceRecoveryRun(a.run) {
		return nil
	}
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	calls, err := readDocuments[Call](ctx, m.store.db, "SELECT document FROM calls WHERE run_id=? ORDER BY step_index", a.run.ID)
	if err != nil {
		return m.contextStoreErrorLocked(err)
	}
	counts, seen := map[string]int{}, map[string]bool{}
	for _, c := range calls {
		if c.Tool == toolSearchName || c.Tool == planTool || c.Tool == userInputTool {
			continue
		}
		args := c.Args
		if args == nil {
			args, _ = jsonvalue.Object([]byte(c.ArgumentsJSON))
		}
		target := c.Tool
		for _, field := range []string{"id", "name", "target"} {
			if value, ok := args[field].(string); ok && value != "" {
				target = value
				break
			}
		}
		key := target + "|" + c.Tool + ":" + recoveryArguments(c)
		if c.Status == StateSucceeded {
			fact := key + ":" + digestJSON(c.Result)
			if !seen[fact] {
				for failed := range counts {
					if strings.HasPrefix(failed, target+"|") {
						delete(counts, failed)
					}
				}
				seen[fact] = true
			}
		} else if c.Status == StateFailed && c.Error != nil {
			key += ":" + c.Error.Code
			attempts := 1
			for i, attempt := range c.Attempts {
				if i > 0 && attempt.Error != nil && attempt.Error.Code == c.Error.Code {
					attempts++
				}
			}
			counts[key] += attempts
			if counts[key] >= 3 {
				return bad("no-progress", "相同操作在没有新证据或进展的情况下失败三次，已停止重复尝试；请根据结果总结调整方案后继续")
			}
		}
	}
	return nil
}

func beginRecovery(r *Run, o *Operation, now time.Time) {
	if o.Recovery == nil {
		o.Recovery = &RunRecovery{OperationID: o.ID, Tool: o.Capability.Name, StartedAt: stamp(now), Deadline: stamp(now.Add(recoveryWindow)), Status: "verifying", Message: "正在核实操作是否结束及实际变更，期间不重复提交"}
	}
	r.Status, r.Phase = StateWaitingRecovery, StateWaitingRecovery
	r.Recovery = o.Recovery
}

// One bounded observation is durably scheduled before I/O, including after restart.
func (m *Manager) recoveryObservation(expected Operation) (bool, error) {
	if expected.Recovery == nil {
		return true, nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError {
		return false, nil
	}
	now := m.deps.Now()
	next, _ := time.Parse(time.RFC3339Nano, expected.Recovery.NextCheckAt)
	if now.Before(next) {
		return false, nil
	}
	allowed := false
	_, err := m.store.change(context.Background(), expected.RunID, "recovery-observation", func(tx *sql.Tx, r *Run) error {
		o, err := readOperation(context.Background(), tx, expected.ID)
		if err != nil {
			return err
		}
		if o.Recovery == nil || o.Recovery.Status == "recovered" {
			return nil
		}
		deadline, err := time.Parse(time.RFC3339Nano, o.Recovery.Deadline)
		if err != nil {
			return errors.New("恢复核实截止时间无效")
		}
		if !now.Before(deadline) && r.Status == StateWaitingRecovery {
			o.Recovery.Status, o.Recovery.Message = "unresolved", "自动核实已超过两分钟，仍缺少可信结束证据；请核实实际状态后继续"
			r.Recovery = o.Recovery
			r.Status, r.Phase, r.EndReason, r.EndedAt = StateInterrupted, "completed", "outcome-unknown", stamp(now)
			r.Error = &Failure{Code: "outcome-unknown", Message: o.Recovery.Message}
			if o.Error != nil {
				copy := *o.Error
				copy.Message += "；" + o.Recovery.Message
				r.Error = &copy
			}
			if err := saveOperation(context.Background(), tx, o); err != nil {
				return err
			}
			return m.store.event(context.Background(), tx, r, "run/interrupted", o.CallID, nil, r.Error)
		}
		o.Recovery.Checks++
		delay := time.Duration(min(15, 1<<min(o.Recovery.Checks, 4))) * time.Second
		o.Recovery.NextCheckAt = stamp(now.Add(delay))
		if r.Status == StateWaitingRecovery {
			r.Recovery = o.Recovery
		}
		allowed = true
		if err := saveRun(context.Background(), tx, r); err != nil {
			return err
		}
		return saveOperation(context.Background(), tx, o)
	})
	return allowed, err
}

// The intent is committed before entering the domain fence. The final binding
// is conditional on the same dispatch; retry after any crash is idempotent.
func (m *Manager) verifyMissingTask(ctx context.Context, expected Operation) (tools.TaskReference, error) {
	m.mu.Lock()
	if m.closed || m.storageError || m.deps.VerifyTask == nil {
		m.mu.Unlock()
		return tools.TaskReference{}, closedError()
	}
	if e := m.executionLocked(expected.RunID); e != nil {
		if e.unresponsive {
			m.mu.Unlock()
			return tools.TaskReference{}, bad("verification-running", "原提交尚未确认退出")
		}
		if e.callDone != nil {
			select {
			case <-e.callDone:
			default:
				m.mu.Unlock()
				return tools.TaskReference{}, bad("verification-running", "原提交仍在进行")
			}
		}
	}
	var v tools.TaskVerification
	err := m.store.write(ctx, "submission-verification-intent", func(tx *sql.Tx) error {
		o, err := readOperation(ctx, tx, expected.ID)
		if err != nil {
			return err
		}
		if o.Status != "unknown" || o.DispatchID != expected.DispatchID || o.Task == nil || o.Task.ID != "" || o.Task.RequestID == "" || o.Capability.Source != "builtin" || !o.Capability.Metadata.Async {
			return bad("verification-changed", "操作不再满足未受理核实条件")
		}
		version := o.Capability.Metadata.Version
		if !(o.Capability.Name == "docker_container_create_service" && version == "3" || o.Capability.Name == "docker_container_exec" && version == "2") {
			return bad("verification-unsupported", "旧工具没有经过审核的提交前无变更契约")
		}
		v = tools.TaskVerification{OperationID: o.ID, DispatchID: o.DispatchID, Task: *o.Task, Tool: o.Capability.Name, ArgumentsJSON: o.ArgumentsJSON}
		if o.Recovery == nil {
			o.Recovery = &RunRecovery{OperationID: o.ID, Tool: o.Capability.Name, StartedAt: stamp(m.deps.Now()), Deadline: stamp(m.deps.Now().Add(recoveryWindow)), Status: "verifying", Message: "正在核实未受理提交并封存原请求"}
		}
		return saveOperation(ctx, tx, o)
	})
	if err == nil {
		err = m.store.recordsFault()
	}
	m.mu.Unlock()
	if err != nil {
		return tools.TaskReference{}, err
	}
	ref, err := m.deps.VerifyTask(ctx, v)
	if err != nil {
		return ref, err
	}
	if ref.Domain != v.Task.Domain || ref.RequestID != v.Task.RequestID || ref.ID == "" || ref.Digest == "" || ref.Target == "" || v.Task.Target != "" && v.Task.Target != ref.Target || v.Task.Digest != "" && v.Task.Digest != ref.Digest {
		return ref, bad("verification-identity", "核实回执身份不完整")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError {
		return ref, closedError()
	}
	err = m.store.write(context.Background(), "submission-verification-result", func(tx *sql.Tx) error {
		o, err := readOperation(context.Background(), tx, expected.ID)
		if err != nil {
			return err
		}
		if o.Status != "unknown" || o.DispatchID != v.DispatchID || o.ArgumentsJSON != v.ArgumentsJSON || o.Task == nil || o.Task.RequestID != ref.RequestID || o.Task.ID != "" && digestJSON(o.Task) != digestJSON(&ref) {
			return bad("verification-changed", "核实操作身份已变化")
		}
		o.Task = &ref
		return saveOperation(context.Background(), tx, o)
	})
	return ref, err
}

// VerifyRecovery only observes/fences the original task; it grants no execution
// permission and never starts a new Run. It also supports historical orphans.
func (m *Manager) VerifyRecovery(ctx context.Context, id string) (Run, error) {
	m.mu.Lock()
	if m.closed || m.storageError {
		m.mu.Unlock()
		return Run{}, closedError()
	}
	r, err := m.store.get(ctx, id)
	if err != nil {
		m.mu.Unlock()
		return r, err
	}
	ops, err := readDocuments[Operation](ctx, m.store.db, "SELECT document FROM operations WHERE run_id=? AND state='unknown'", id)
	m.mu.Unlock()
	if err != nil {
		return r, err
	}
	for _, o := range ops {
		if o.Task == nil {
			continue
		}
		if o.Task.ID == "" {
			ref, err := m.verifyMissingTask(ctx, o)
			if err != nil {
				return r, err
			}
			o.Task = &ref
		}
		if m.deps.InspectTask == nil {
			continue
		}
		status, err := m.deps.InspectTask(ctx, *o.Task)
		if err != nil {
			return r, bad("verification-unavailable", "核实通道暂不可用，资源保护保留")
		}
		if status.EffectiveOutcome() == tools.TaskRunning {
			continue
		}
		m.mu.Lock()
		err = m.settleDomainTask(o, status)
		m.mu.Unlock()
		if err != nil {
			return r, err
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.store.get(ctx, id)
}
