package harness

import (
	"bytes"
	"context"
	"database/sql"
	"elysian/server/internal/agent/tools"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"
)

type toolResponse struct {
	value any
	err   error
}

func (m *Manager) invoke(ctx context.Context, run Run, index int, name string, args json.RawMessage) (json.RawMessage, error) {
	m.mu.Lock()
	execution := m.executionLocked(run.ID)
	if m.closed || execution == nil || execution.finishing || m.blocked != "" || ctx.Err() != nil {
		m.mu.Unlock()
		return nil, context.Canceled
	}
	agentCall := run.SessionID != ""
	var expected Step
	var proposalID, modelRequestID string
	if agentCall {
		if execution.agent == nil || execution.agent.pending == nil || execution.agent.pending.Response == nil || execution.agent.pendingIndex >= len(execution.agent.pending.Response.ToolCalls) {
			m.mu.Unlock()
			return nil, bad("invalid-worker-call", "模型工具提议不存在")
		}
		proposal := execution.agent.pending.Response.ToolCalls[execution.agent.pendingIndex]
		modelRequestID, proposalID = execution.agent.pending.ID, proposal.ID
		expected.Tool = proposal.Name
		if err := json.Unmarshal(proposal.Arguments, &expected.Args); err != nil {
			m.mu.Unlock()
			return nil, bad("invalid-worker-call", "模型工具参数无效")
		}
	} else if index >= 0 && index < len(run.Task.Steps) {
		expected = run.Task.Steps[index]
	}
	if index != execution.nextStep || index < 0 || name != expected.Tool {
		m.mu.Unlock()
		return nil, &Error{Status: 400, Code: "invalid-worker-call", Message: "Worker 工具请求与任务步骤不符"}
	}
	var parameters map[string]any
	if err := json.Unmarshal(args, &parameters); err != nil || parameters == nil {
		m.mu.Unlock()
		return nil, bad("invalid-worker-call", "Worker 参数无效")
	}
	want, _ := json.Marshal(expected.Args)
	got, _ := json.Marshal(parameters)
	if !bytes.Equal(want, got) || !allowed(name) {
		m.mu.Unlock()
		return nil, bad("tool-denied", "Worker 工具请求未获准")
	}
	call := Call{ModelRequestID: modelRequestID, ModelCallID: proposalID, ID: m.deps.NewID(), RunID: run.ID, StepIndex: index, Tool: name, Args: parameters, Status: StateRunning, StartedAt: stamp(m.deps.Now())}
	// 取消不能阻止已经开始的持久化收尾；意图事务独立于 HTTP/Worker 请求上下文。
	dbCtx := context.Background()
	_, err := m.store.change(dbCtx, run.ID, "call-intent", func(tx *sql.Tx, r *Run) error {
		if r.Status != StateRunning || r.CancelRequestedAt != "" {
			return context.Canceled
		}
		if r.Usage.Calls >= r.Limits.MaxSteps {
			return &Error{Status: 400, Code: "call-budget", Message: "工具调用次数达到上限"}
		}
		if err := saveCall(dbCtx, tx, call); err != nil {
			return err
		}
		r.Usage.Calls++
		return m.store.event(dbCtx, tx, r, "call/started", call.ID, &index, map[string]any{"tool": name})
	})
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			if _, ok := err.(*Error); !ok {
				m.storageFailedLocked()
			}
		}
		m.mu.Unlock()
		return nil, err
	}
	callDone := make(chan struct{})
	execution.callDone = callDone
	defer close(callDone)
	m.mu.Unlock()
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(run.Limits.CallTimeoutSeconds)*time.Second)
	defer cancel()
	response := make(chan toolResponse, 1)
	go func() {
		var result toolResponse
		defer func() {
			if recover() != nil {
				result = toolResponse{err: errors.New("工具发生内部错误")}
			}
			response <- result
		}()
		if result.err = m.store.recordsFault(); result.err != nil {
			return
		}
		if m.deps.Tools == nil || !m.deps.Tools.Available() {
			result.err = errors.New("工具依赖不可用")
		} else {
			authorized, err := m.toolAuthority.Authorize(callCtx, tools.AuthorizationBinding{OperationID: call.ID, DispatchID: call.ID, Tool: name, ArgumentsDigest: tools.ArgumentsDigest(parameters)}, nil, func(ctx context.Context) error {
				var raw string
				var stored Call
				if err := m.store.db.QueryRowContext(ctx, "SELECT document FROM calls WHERE id=?", call.ID).Scan(&raw); err != nil {
					return err
				}
				if err := json.Unmarshal([]byte(raw), &stored); err != nil {
					return err
				}
				if stored.Status != StateRunning || stored.Tool != name || !reflect.DeepEqual(stored.Args, parameters) {
					return bad("dispatch-changed", "旧版工具调用与持久化派发不符")
				}
				current, err := m.store.get(ctx, run.ID)
				if err != nil {
					return err
				}
				if current.Status != StateRunning || current.CancelRequestedAt != "" {
					return context.Canceled
				}
				return nil
			})
			if err != nil {
				result.err = err
				return
			}
			result.value, result.err = m.deps.Tools.Execute(authorized, name, parameters)
		}
	}()
	var result toolResponse
	select {
	case result = <-response:
	case <-callCtx.Done():
		grace := time.NewTimer(time.Duration(run.Limits.CancelGraceSeconds) * time.Second)
		select {
		case result = <-response:
			grace.Stop()
		case <-grace.C:
			m.mu.Lock()
			execution.unresponsive = true
			m.blocked = "工具未确认停止，任务派发已暂停，请重启面板后检查"
			m.mu.Unlock()
			return nil, &Error{Status: 503, Code: "tool-unresponsive", Message: "工具未确认停止，结果未确认"}
		}
	}
	// 宽限期只用于确认工具停止，不延长执行预算；迟到的成功不得推进下一步。
	if errors.Is(callCtx.Err(), context.DeadlineExceeded) {
		result.err = context.DeadlineExceeded
	}
	call.EndedAt = stamp(m.deps.Now())
	var value json.RawMessage
	if result.err == nil {
		value, call.Truncated, err = projectResult(result.value, run.Limits.ResultBytes)
		if err != nil {
			result.err = err
		} else {
			call.Status = StateSucceeded
			call.Result = value
		}
	}
	if result.err != nil {
		call.Status = StateFailed
		call.Error = &Failure{Code: "tool-failed", Message: "工具执行失败，请检查对应域的可用性"}
		if errors.Is(result.err, context.Canceled) {
			call.Status = StateCancelled
			call.Error = &Failure{Code: "cancelled", Message: "工具调用已取消"}
		}
		if errors.Is(callCtx.Err(), context.DeadlineExceeded) || errors.Is(result.err, context.DeadlineExceeded) {
			call.Status = StateFailed
			call.Error = &Failure{Code: "call-timeout", Message: "工具调用超过时间限制"}
		}
		var denied *tools.DeniedError
		if errors.As(result.err, &denied) {
			call.Error = &Failure{Code: "tool-denied", Message: "工具调用被策略拒绝"}
		}
		var typed *Error
		if errors.As(result.err, &typed) {
			call.Error = &Failure{Code: typed.Code, Message: typed.Message}
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	// 存储故障或旧运行的晚到返回不得补写成成功。
	if m.closed || m.storageError || m.executionLocked(run.ID) != execution {
		return nil, context.Canceled
	}
	_, err = m.store.change(dbCtx, run.ID, "call-result", func(tx *sql.Tx, r *Run) error {
		if r.Status != StateRunning {
			return context.Canceled
		}
		if r.Usage.ResultBytes+len(value) > r.Limits.RunResultBytes {
			call.Status = StateFailed
			call.Result = nil
			value = nil
			call.Error = &Failure{Code: "result-budget", Message: "运行结果总量达到上限"}
		}
		r.Usage.ResultBytes += len(value)
		if err := saveCall(dbCtx, tx, call); err != nil {
			return err
		}
		return m.store.event(dbCtx, tx, r, "call/finished", call.ID, &index, map[string]any{"tool": name, "status": call.Status, "truncated": call.Truncated, "error": call.Error})
	})
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			m.storageFailedLocked()
		}
		return nil, storageFailure(err)
	}
	execution.nextStep++
	if call.Error != nil {
		if agentCall && call.Error.Code == "tool-failed" && ctx.Err() == nil {
			return nil, nil
		}
		return nil, &Error{Status: 500, Code: call.Error.Code, Message: call.Error.Message}
	}
	return value, nil
}

// projectResult 在完整 JSON 条目边界截断，避免把非法 JSON 或无界结果写进数据库。
func projectResult(value any, max int) (json.RawMessage, bool, error) {
	v := reflect.ValueOf(value)
	if v.IsValid() && (v.Kind() == reflect.Slice || v.Kind() == reflect.Array) {
		out := make([]json.RawMessage, 0)
		size := 2
		truncated := false
		for i := 0; i < v.Len(); i++ {
			if i >= 200 {
				truncated = true
				break
			}
			b, err := json.Marshal(v.Index(i).Interface())
			if err != nil {
				return nil, false, &Error{Status: 500, Code: "invalid-result", Message: "工具返回了无效的 JSON 结果"}
			}
			extra := len(b)
			if len(out) > 0 {
				extra++
			}
			if size+extra > max {
				truncated = true
				break
			}
			out = append(out, b)
			size += extra
		}
		b, err := json.Marshal(out)
		return b, truncated, err
	}
	b, err := json.Marshal(value)
	if err != nil {
		return nil, false, &Error{Status: 500, Code: "invalid-result", Message: "工具返回了无效的 JSON 结果"}
	}
	if len(b) > max {
		return nil, false, &Error{Status: 500, Code: "result-too-large", Message: fmt.Sprintf("工具结果超过 %d 字节限制", max)}
	}
	return b, false, nil
}
