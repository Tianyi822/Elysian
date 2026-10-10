package harness

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/worker"
	"elysian/server/internal/agent/jsonvalue"
)

// agentExecution 只保存本次运行的控制状态；事实均先写入父进程数据库。
// 字段由 Manager.mu 保护，外部操作串行推进。
type agentExecution struct {
	manager           *Manager
	run               Run
	busy              bool
	pending           *ModelRequestRecord
	pendingIndex      int
	finalized         bool
	finalAnswer       string
	finalMemory       *WorkingMemory
	stale             bool
	contextItemIDs    []string
	sharedWikiRefs    [][]WikiRef
	inferenceWikiRefs []WikiRef
	workflowOutput    *workflowAgentOutput
}

func (a *agentExecution) DriverVersion() int {
	if a.run.DriverVersion == "v2" {
		return 2
	}
	return 1
}
func (a *agentExecution) projection(r ModelRequestRecord, start int) (worker.ModelResponse, error) {
	if r.Response == nil {
		return worker.ModelResponse{}, bad("model-protocol", "模型响应缺失")
	}
	out := worker.ModelResponse{ID: r.ID, StartIndex: start, Final: len(r.Response.ToolCalls) == 0}
	for _, c := range r.Response.ToolCalls {
		out.ToolCalls = append(out.ToolCalls, worker.AgentToolCall{ID: c.ID, Name: c.Name, Args: c.Arguments})
	}
	return out, nil
}

func validateAgentLimits(l Limits) error {
	if err := validateLimits(l); err != nil {
		return err
	}
	if l.MaxModelRequests < 2 || l.MaxModelRequests > 16 || l.ModelTimeoutSeconds < 1 || l.OutputTokens < 1 || l.OutputTokens > 4096 || l.TokenBudget < 1 || l.TokenBudget > 128000 || l.UserBytes < 1 || l.UserBytes > 32768 || l.MemoryBytes < 1 || l.MemoryBytes > 16384 || l.ModelResponseBytes < 1 || l.ModelResponseBytes > 524288 {
		return errors.New("Agent 模型、输入和记忆限额无效")
	}
	return nil
}

func (m *Manager) agentAvailableLocked() error {
	if m.closed {
		return closedError()
	}
	if m.blocked != "" {
		return &Error{Status: 503, Code: "runtime-unavailable", Message: m.blocked}
	}
	if m.workerState != "ready" {
		return &Error{Status: 503, Code: "worker-unavailable", Message: "任务 Worker 尚未就绪"}
	}
	if m.deps.ModelConfigError != "" {
		return &Error{Status: 503, Code: "model-config-unavailable", Message: m.deps.ModelConfigError}
	}
	if m.deps.Profiles != nil && m.deps.Profiles.Available() {
		return nil
	}
	return &Error{Status: 503, Code: "model-unavailable", Message: "请先配置支持文本与函数调用的模型"}
}

func (a *agentExecution) begin(ctx context.Context) (func(), error) {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	execution := m.executionLocked(a.run.ID)
	if m.closed || execution == nil || execution.finishing || m.blocked != "" || ctx.Err() != nil {
		return nil, context.Canceled
	}
	if a.busy || a.finalized {
		return nil, bad("invalid-agent-operation", "Agent 操作顺序无效")
	}
	a.busy = true
	done := make(chan struct{})
	execution.callDone = done
	return func() { m.mu.Lock(); a.busy = false; close(done); m.mu.Unlock() }, nil
}

func (a *agentExecution) NextModel(ctx context.Context) (worker.ModelResponse, error) {
	end, err := a.begin(ctx)
	if err != nil {
		return worker.ModelResponse{}, err
	}
	defer end()
	m := a.manager
	m.mu.Lock()
	if a.run.Resume != nil && a.pending == nil {
		var raw string
		var record ModelRequestRecord
		err = m.store.db.QueryRowContext(ctx, "SELECT document FROM model_requests WHERE id=? AND run_id=?", a.run.Resume.ResponseID, a.run.ID).Scan(&raw)
		if err == nil {
			err = json.Unmarshal([]byte(raw), &record)
		}
		if err != nil {
			m.mu.Unlock()
			return worker.ModelResponse{}, storageFailure(err)
		}
		a.pending = &record
		a.pendingIndex = a.run.Resume.CallIndex
		if record.Response == nil || a.pendingIndex < 0 || a.pendingIndex > len(record.Response.ToolCalls) {
			m.mu.Unlock()
			return worker.ModelResponse{}, bad("invalid-resume", "恢复位置无效")
		}
		if a.pendingIndex < len(record.Response.ToolCalls) {
			out, err := a.projection(record, a.pendingIndex)
			m.mu.Unlock()
			return out, err
		}
	}
	if a.pending != nil && (a.pending.Response == nil || len(a.pending.Response.ToolCalls) == 0 || a.pendingIndex != len(a.pending.Response.ToolCalls)) {
		m.mu.Unlock()
		return worker.ModelResponse{}, bad("invalid-agent-operation", "上一模型响应尚未完成")
	}
	m.mu.Unlock()
	if selected, err := a.selectedMaterials(ctx); err != nil {
		return worker.ModelResponse{}, err
	} else if selected != nil {
		return *selected, nil
	}
	request, refs, revision, err := a.buildContext(ctx)
	if err != nil {
		return worker.ModelResponse{}, err
	}
	record, err := a.requestModel(ctx, "inference", request, refs, revision)
	if err != nil {
		return worker.ModelResponse{}, err
	}
	response := record.Response
	if response == nil {
		return worker.ModelResponse{}, bad("model-protocol", "模型未返回完整响应")
	}
	out := worker.ModelResponse{ID: record.ID}
	if len(response.ToolCalls) > 0 {
		if response.FinishReason != "tool_calls" {
			return out, bad("model-protocol", "工具提议缺少完整结束标记")
		}
		for _, call := range response.ToolCalls {
			if err := a.validateProposal(call.Name, call.Arguments); err != nil {
				return out, bad("tool-denied", "模型请求了未获准的工具或参数")
			}
			out.ToolCalls = append(out.ToolCalls, worker.AgentToolCall{ID: call.ID, Name: call.Name, Args: call.Arguments})
		}
	} else {
		if response.FinishReason != "stop" || strings.TrimSpace(response.Content) == "" {
			return out, bad("model-incomplete", "模型未返回完整最终答复")
		}
		out.Final = true
	}
	m.mu.Lock()
	a.pending = &record
	a.pendingIndex = 0
	m.mu.Unlock()
	return out, nil
}

func (a *agentExecution) ExecuteAgent(ctx context.Context, responseID string, index int, callID, name string, args json.RawMessage) error {
	m := a.manager
	m.mu.Lock()
	if a.busy || a.finalized || a.pending == nil || a.pending.ID != responseID || a.pending.Response == nil || index != a.pendingIndex || index < 0 || index >= len(a.pending.Response.ToolCalls) {
		m.mu.Unlock()
		return bad("invalid-worker-call", "Worker 工具请求不属于已持久化模型响应")
	}
	proposal := a.pending.Response.ToolCalls[index]
	gb, ge := jsonvalue.Canonical(args)
	wb, we := jsonvalue.Canonical(proposal.Arguments)
	if ge != nil || we != nil {
		m.mu.Unlock()
		return bad("invalid-worker-call", "Worker 工具参数无效")
	}
	if proposal.ID != callID || proposal.Name != name || !bytes.Equal(gb, wb) {
		m.mu.Unlock()
		return bad("invalid-worker-call", "Worker 工具请求与模型提议不符")
	}
	execution := m.executionLocked(a.run.ID)
	if execution == nil || execution.finishing || ctx.Err() != nil {
		m.mu.Unlock()
		return context.Canceled
	}
	a.busy = true
	step := execution.nextStep
	m.mu.Unlock()
	var err error
	if a.run.DriverVersion == "v2" {
		err = a.executeOperation(ctx, index, proposal, gb)
	} else {
		_, err = m.invoke(ctx, a.run, step, name, args)
	}
	m.mu.Lock()
	a.busy = false
	if err == nil {
		a.pendingIndex++
	}
	m.mu.Unlock()
	return err
}

func (a *agentExecution) Finalize(ctx context.Context, responseID string) error {
	end, err := a.begin(ctx)
	if err != nil {
		return err
	}
	defer end()
	m := a.manager
	m.mu.Lock()
	if a.pending == nil || a.pending.ID != responseID || a.pending.Response == nil || len(a.pending.Response.ToolCalls) != 0 || a.pending.Response.FinishReason != "stop" {
		m.mu.Unlock()
		return bad("invalid-agent-operation", "最终答复尚未确认")
	}
	answer := a.pending.Response.Content
	m.mu.Unlock()
	if a.run.WorkflowID != "" {
		output, err := a.finishWorkflowOutput(ctx)
		if err != nil {
			return err
		}
		m.mu.Lock()
		a.workflowOutput = output
		m.mu.Unlock()
	}
	memory, err := a.consolidate(ctx, true)
	if err != nil && (ctx.Err() != nil || a.mustStop(err)) {
		return err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	execution := m.executionLocked(a.run.ID)
	if m.closed || m.storageError || execution == nil || execution.unresponsive || execution.finishing || ctx.Err() != nil {
		return context.Canceled
	}
	a.finalAnswer = answer
	a.finalMemory = memory
	a.stale = err != nil
	a.finalized = true
	return nil
}

func (a *agentExecution) mustStop(err error) bool {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	execution := m.executionLocked(a.run.ID)
	if m.storageError || execution == nil || execution.unresponsive || m.blocked != "" {
		return true
	}
	var e *Error
	return errors.As(err, &e) && (e.Code == "storage-unavailable" || e.Code == "invalid-agent-operation" || a.run.WorkflowID != "" && (e.Code == "workflow-budget" || e.Code == "workflow-step-budget"))
}

func (a *agentExecution) commitFinal(ctx context.Context, tx *sql.Tx, r *Run) error {
	if r.WorkflowID != "" {
		if a.workflowOutput == nil || a.workflowOutput.JSON == "" || a.workflowOutput.RequestID == "" {
			return bad("workflow-output-missing", "工作流步骤尚未确认结构化输出")
		}
		r.WorkflowOutputJSON = a.workflowOutput.JSON
		r.WorkflowOutputRequestID = a.workflowOutput.RequestID
	}
	if a.stale {
		r.MemoryStatus = "stale"
		r.Warning = &Failure{Code: "memory-stale", Message: "答复已保存，工作记忆整理未完成；下轮将补入未整理事实"}
	} else {
		r.MemoryStatus = "updated"
	}
	r.Phase = "completed"
	if err := a.manager.store.finalizeAgent(ctx, tx, r, a.finalAnswer, a.finalMemory); err != nil {
		return err
	}
	if err := recordWikiFinal(ctx, tx, *r, a.finalMemory); err != nil {
		return err
	}
	return a.manager.enqueueWikiRunExtraction(ctx, tx, r, a.finalAnswer)
}

type modelOutcome struct {
	response model.Response
	err      error
}

// requestModel 的返回只可能来自已持久化响应；HTTP 错误不携带供应商正文或凭据。
func (a *agentExecution) requestModel(ctx context.Context, purpose string, request model.Request, refs []EvidenceRef, revision int) (ModelRequestRecord, error) {
	m := a.manager
	m.mu.Lock()
	empty := ModelRequestRecord{}
	execution := m.executionLocked(a.run.ID)
	if m.closed || execution == nil || execution.finishing || m.blocked != "" || ctx.Err() != nil {
		m.mu.Unlock()
		return empty, context.Canceled
	}
	run, err := m.store.get(context.Background(), a.run.ID)
	if err != nil {
		m.storageFailedLocked()
		m.mu.Unlock()
		return empty, storageFailure(err)
	}
	if run.CancelRequestedAt != "" || run.Status != StateRunning {
		m.mu.Unlock()
		return empty, context.Canceled
	}
	if err = m.validateWikiRun(ctx, m.store.db, run.ID); err != nil {
		m.mu.Unlock()
		return empty, err
	}
	if m.deps.DispatchGuard != nil {
		if err := m.deps.DispatchGuard(); err != nil {
			m.mu.Unlock()
			return empty, err
		}
	}
	if run.Model == nil || m.deps.Profiles == nil {
		m.mu.Unlock()
		return empty, bad("model-unavailable", "运行模型版本不存在")
	}
	profile, err := m.deps.Profiles.Resolve(run.Model.ID, run.Model.Revision, true)
	if err != nil {
		m.mu.Unlock()
		return empty, bad("model-unavailable", "运行固定的模型版本不可用")
	}
	maxRequests := run.Limits.MaxModelRequests - a.modelRequestReserve(purpose)
	estimate := estimateRequest(request)
	if run.Usage.ModelRequests >= maxRequests || run.Usage.Tokens+estimate+request.MaxTokens > run.Limits.TokenBudget {
		m.mu.Unlock()
		return empty, bad("model-budget", "模型请求次数或 token 预算已耗尽")
	}
	record := ModelRequestRecord{ID: m.deps.NewID(), RunID: run.ID, Index: run.Usage.ModelRequests, Purpose: purpose, Status: StateRunning, StartedAt: stamp(m.deps.Now()), ContextRefs: refs, MemoryRevision: revision, EstimatedTokens: estimate, HistorySeq: run.HistorySeq}
	record.WikiSources, err = a.modelWikiSourcesLocked(ctx, purpose, refs, revision)
	if err != nil {
		m.mu.Unlock()
		return empty, err
	}
	if purpose == "inference" {
		record.ContextItemIDs = append([]string(nil), a.contextItemIDs...)
	}
	_, err = m.store.change(context.Background(), run.ID, "model-intent", func(tx *sql.Tx, r *Run) error {
		g, e := wikiGeneration(ctx, tx, r.TaskID)
		if e != nil {
			return e
		}
		if e = saveWikiArtifact(ctx, tx, "run", r.ID, r.TaskID, r.ID, g, record.WikiSources); e != nil {
			return e
		}
		if err := recordWikiRunArtifact(context.Background(), tx, *r, "model-request", record.ID); err != nil {
			return err
		}
		if r.WorkflowID != "" {
			if err := m.workflowReserveModel(context.Background(), tx, r, estimate+request.MaxTokens); err != nil {
				return err
			}
		}
		r.Usage.ModelRequests++
		r.Usage.Tokens += estimate
		r.Usage.EstimatedTokens += estimate
		r.Phase = purpose
		if err := saveModelRequest(context.Background(), tx, record); err != nil {
			return err
		}
		return m.store.event(context.Background(), tx, r, "model/started", "", nil, map[string]any{"modelRequestId": record.ID, "purpose": purpose})
	})
	if err != nil {
		var typed *Error
		if !errors.As(err, &typed) {
			m.storageFailedLocked()
		}
		m.mu.Unlock()
		return empty, storageFailure(err)
	}
	m.mu.Unlock()
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(run.Limits.ModelTimeoutSeconds)*time.Second)
	defer cancel()
	resultCh := make(chan modelOutcome, 1)
	go func() {
		var result modelOutcome
		defer func() {
			if recover() != nil {
				result.err = errors.New("模型客户端发生内部错误")
			}
			resultCh <- result
		}()
		result.response, result.err = m.deps.ModelClient.Complete(callCtx, profile, request)
	}()
	var result modelOutcome
	select {
	case result = <-resultCh:
	case <-callCtx.Done():
		timer := time.NewTimer(time.Duration(run.Limits.CancelGraceSeconds) * time.Second)
		select {
		case result = <-resultCh:
			timer.Stop()
		case <-timer.C:
			m.mu.Lock()
			execution.unresponsive = true
			m.blocked = "模型请求未确认停止，任务派发已暂停，请重启面板后检查"
			m.mu.Unlock()
			return record, &Error{Status: 503, Code: "model-unresponsive", Message: "模型请求未确认停止，运行结果未确认"}
		}
	}
	if callCtx.Err() != nil {
		result.err = callCtx.Err()
	}
	record.EndedAt = stamp(m.deps.Now())
	record.Status = StateSucceeded
	if result.err == nil {
		data, marshalErr := json.Marshal(result.response)
		if marshalErr != nil || len(data) > run.Limits.ModelResponseBytes {
			result.err = bad("model-response-too-large", "模型响应超过容量限制")
		}
	}
	if result.err == nil {
		// IPC 使用父进程规范化后的调用标识，不信任供应商编号的长度或跨响应唯一性。
		seen := map[string]bool{}
		for i := range result.response.ToolCalls {
			call := &result.response.ToolCalls[i]
			canonical, e := jsonvalue.Canonical(call.Arguments)
			if e != nil {
				result.err = bad("model-protocol", "模型参数包含重复键或无效 JSON")
				break
			}
			call.Arguments = canonical
			if call.ID == "" || seen[call.ID] {
				result.err = bad("model-protocol", "模型工具调用标识无效或重复")
				break
			}
			seen[call.ID] = true
			call.ID = record.ID + "_" + strconv.Itoa(i)
		}
		for _, count := range []*int{result.response.Usage.TotalTokens, result.response.Usage.PromptTokens, result.response.Usage.CompletionTokens, result.response.Usage.CachedTokens} {
			if count != nil && (*count < 0 || *count > 10000000) {
				result.err = bad("model-protocol", "模型用量字段无效")
			}
		}
	}
	if result.err == nil {
		normalized, marshalErr := json.Marshal(result.response)
		if marshalErr != nil || len(normalized) > run.Limits.ModelResponseBytes {
			result.err = bad("model-response-too-large", "规范化模型响应超过容量限制")
		}
	}
	if result.err == nil {
		record.Response = &result.response
	} else {
		record.Status = StateFailed
		record.Error = &Failure{Code: "model-failed", Message: "模型请求失败，请检查模型服务与凭据"}
		var typed *model.Error
		if errors.As(result.err, &typed) {
			record.Error = &Failure{Code: typed.Code, Message: typed.Message}
		}
		var own *Error
		if errors.As(result.err, &own) {
			record.Error = &Failure{Code: own.Code, Message: own.Message}
		}
		if errors.Is(result.err, context.Canceled) {
			record.Status = StateCancelled
			record.Error = &Failure{Code: "cancelled", Message: "模型请求已取消"}
		}
		if errors.Is(result.err, context.DeadlineExceeded) {
			record.Error = &Failure{Code: "model-timeout", Message: "模型请求超过时间限制"}
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError || m.executionLocked(run.ID) != execution {
		return record, context.Canceled
	}
	_, err = m.store.change(context.Background(), run.ID, "model-result", func(tx *sql.Tx, r *Run) error {
		if r.Status != StateRunning {
			return context.Canceled
		}
		workflowCharge := estimate + request.MaxTokens
		if record.Response != nil {
			normalized, _ := json.Marshal(record.Response)
			outputEstimate := len(normalized) + 32
			r.Usage.EstimatedTokens += outputEstimate
			charged := estimate + outputEstimate
			usage := record.Response.Usage
			if usage.TotalTokens != nil {
				charged = *usage.TotalTokens
			}
			if usage.TotalTokens != nil && (record.Index == 0 || r.Usage.ActualTokens != nil) {
				sum := *usage.TotalTokens
				if r.Usage.ActualTokens != nil {
					sum += *r.Usage.ActualTokens
				}
				r.Usage.ActualTokens = &sum
			} else {
				r.Usage.ActualTokens = nil
			}
			if usage.CachedTokens != nil && (record.Index == 0 || r.Usage.CachedTokens != nil) {
				sum := *usage.CachedTokens
				if r.Usage.CachedTokens != nil {
					sum += *r.Usage.CachedTokens
				}
				r.Usage.CachedTokens = &sum
			} else {
				r.Usage.CachedTokens = nil
			}
			r.Usage.Tokens += charged - estimate
			workflowCharge = charged
		} else {
			r.Usage.ActualTokens = nil
			r.Usage.CachedTokens = nil
		}
		if r.WorkflowID != "" {
			if err := m.workflowSettleModel(context.Background(), tx, r, estimate+request.MaxTokens, workflowCharge); err != nil {
				return err
			}
		}
		seq, _ := strconv.ParseInt(r.LastSeq, 10, 64)
		record.EventSeq = strconv.FormatInt(seq+1, 10)
		if err := saveModelRequest(context.Background(), tx, record); err != nil {
			return err
		}
		return m.store.event(context.Background(), tx, r, "model/finished", "", nil, map[string]any{"modelRequestId": record.ID, "purpose": purpose, "status": record.Status, "error": record.Error})
	})
	if err != nil {
		if !errors.Is(err, context.Canceled) {
			m.storageFailedLocked()
		}
		return record, storageFailure(err)
	}
	if record.Error != nil {
		return record, &Error{Status: 502, Code: record.Error.Code, Message: record.Error.Message}
	}
	if ctx.Err() != nil {
		return record, ctx.Err()
	}
	current, readErr := m.store.get(context.Background(), run.ID)
	if readErr != nil {
		m.storageFailedLocked()
		return record, storageFailure(readErr)
	}
	if run.WorkflowID != "" {
		workflow, readErr := readWorkflow(context.Background(), m.store.db, run.WorkflowID)
		if readErr != nil {
			m.storageFailedLocked()
			return record, storageFailure(readErr)
		}
		if workflow.Usage.Tokens > workflow.Limits.Tokens {
			return record, bad("workflow-budget", "模型累计 token 用量超过工作流实例预算")
		}
		if current.Usage.ActualTokens != nil && *current.Usage.ActualTokens > current.Limits.TokenBudget {
			return record, bad("workflow-step-budget", "已确认的模型 token 用量超过步骤运行预算")
		}
	}
	if current.Usage.Tokens > current.Limits.TokenBudget && len(record.Response.ToolCalls) > 0 {
		return record, bad("model-budget", "模型累计 token 用量超过预算")
	}
	return record, nil
}

// UTF-8 字节数加结构开销是与模型无关的保守估算，不宣称等于供应商用量。
func estimateRequest(request model.Request) int {
	b, _ := json.Marshal(request)
	return len(b) + 256 + 128*len(request.Tools) + 64*len(request.Messages)
}
