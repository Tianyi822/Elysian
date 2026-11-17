package harness

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/sessionstore"
	hstate "elysian/server/internal/agent/harness/state"
)

// 纠正仅限普通聊天的按需工具发现；不重放任何被拒绝的工具调用。
func (a *agentExecution) toolCorrectionEligible() bool {
	return a.DriverVersion() == 2 && a.run.WorkflowID == "" && a.onDemandTools()
}

// 配额由持久化请求决定。新策略只限制相同提议与相同已加载目录的重复
// 失败；改变参数或取得新工具定义后仍可继续纠正。旧策略保留一次纠正。
func (a *agentExecution) pendingToolCorrection(ctx context.Context) (bool, error) {
	if !a.toolCorrectionEligible() {
		return false, nil
	}
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()

	records, err := storeRead(ctx, m.store, "pending-tool-correction", func(ctx context.Context) ([]ModelRequestRecord, error) {
		return readView(ctx, m.store).PendingToolCorrections(ctx, a.run.ID)
	})
	if err != nil {
		return false, m.contextStoreErrorLocked(err)
	}
	if len(records) == 0 || records[0].Status != StateFailed || records[0].Error == nil || records[0].Error.Code != model.ToolNotLoadedCode {
		return false, nil
	}
	count, err := a.correctionCount(ctx, records[0], model.ToolNotLoadedCode, hstate.EvidenceRecoveryRun(a.run))
	if err != nil {
		return false, m.contextStoreErrorLocked(err)
	}
	if hstate.EvidenceRecoveryRun(a.run) {
		return count < 3, nil
	}
	return count == 1, nil
}

func (a *agentExecution) requestInference(ctx context.Context) (ModelRequestRecord, error) {
	transientAttempts := 0
	for {
		if hstate.ContinuousRun(a.run) && a.manager.store.DispatchError() != nil {
			return ModelRequestRecord{}, a.suspendForRecovery(StateWaitingStorage, &Failure{Code: "record-storage-unavailable", Message: "记录副本暂时无法同步，已保存检查点并暂停新派发，恢复后自动继续"}, "")
		}
		request, refs, revision, err := a.buildContext(ctx)
		if err != nil {
			var failure *Error
			if hstate.ContinuousRun(a.run) && errors.As(err, &failure) && failure.Code == "storage-read-transient" {
				return ModelRequestRecord{}, a.suspendForRecovery(StateWaitingStorage, &Failure{Code: failure.Code, Message: failure.Message}, "")
			}
			return ModelRequestRecord{}, err
		}
		record, err := a.requestModel(ctx, "inference", request, refs, revision)
		var failure *Error
		if err == nil || ctx.Err() != nil {
			if err == nil {
				a.protocolCorrection = ""
				if e := a.noteModelRecovery(ctx, record.ID, "recovered", "模型响应已恢复，继续任务", 0); e != nil {
					return record, e
				}
			}
			return record, err
		}
		if hstate.EvidenceRecoveryRun(a.run) {
			code := ""
			if errors.As(err, &failure) {
				code = failure.Code
			}
			if code == "model-tool-schema-invalid" {
				count, readErr := a.schemaCorrectionCount(ctx, record)
				if readErr != nil {
					return record, readErr
				}
				if count < 3 {
					a.protocolCorrection = failure.Message
					if e := a.noteModelRecovery(ctx, record.ID, "correcting", "工具参数未通过校验，整批未执行；正在修正参数", count); e != nil {
						return record, e
					}
					continue
				}
				if hstate.ContinuousRun(a.run) {
					if e := a.diagnoseModelFailure(ctx, record.CorrectionKey, failure.Message); e != nil {
						return record, e
					}
					continue
				}
				return record, bad("no-progress", "相同工具参数在没有新证据的情况下连续校验失败三次，已停止重复纠正；"+failure.Message)
			}
			if hstate.ContinuousRun(a.run) && code == "record-storage-unavailable" {
				return record, a.suspendForRecovery(StateWaitingStorage, record.Error, record.ID)
			}
			if hstate.ContinuousRun(a.run) && (transientModelFailure(code) || record.Error != nil && record.Error.Retryable) {
				reason := record.Error
				if reason == nil {
					reason = &Failure{Code: code, Message: failure.Message}
				}
				return record, a.suspendForRecovery(StateWaitingModel, reason, record.ID)
			}
			if (transientModelFailure(code) || record.Error != nil && record.Error.Retryable) && transientAttempts < 2 {
				transientAttempts++
				if e := a.noteModelRecovery(ctx, record.ID, "correcting", "模型通道暂时不可用，正在进行有界重试", transientAttempts); e != nil {
					return record, e
				}
				if e := waitRecoveryRetry(ctx, transientAttempts); e != nil {
					return record, e
				}
				if record.Error != nil && record.Error.RetryAfterSeconds > 0 {
					timer := time.NewTimer(time.Duration(min(record.Error.RetryAfterSeconds, 30)) * time.Second)
					select {
					case <-ctx.Done():
						timer.Stop()
						return record, ctx.Err()
					case <-timer.C:
					}
				}
				continue
			}
		}
		if hstate.ContinuousRun(a.run) && errors.As(err, &failure) && failure.Code == "method-blocked" {
			if e := a.diagnoseModelFailure(ctx, record.CorrectionKey, failure.Message); e != nil {
				return record, e
			}
			continue
		}
		if !errors.As(err, &failure) || failure.Code != model.ToolNotLoadedCode {
			return record, err
		}
		correct, readErr := a.pendingToolCorrection(ctx)
		if readErr != nil {
			return record, readErr
		}
		if !correct {
			if hstate.ContinuousRun(a.run) {
				if e := a.diagnoseModelFailure(ctx, record.CorrectionKey, failure.Message); e != nil {
					return record, e
				}
				continue
			}
			if hstate.EvidenceRecoveryRun(a.run) {
				return record, bad("no-progress", "相同未加载工具提议在没有新目录证据的情况下失败三次，已停止重复纠正；"+failure.Message)
			}
			return record, err
		}
		if hstate.EvidenceRecoveryRun(a.run) {
			if e := a.noteModelRecovery(ctx, record.ID, "correcting", "未加载工具的提议已整批拒绝，正在重新搜索加载", 0); e != nil {
				return record, e
			}
		}
		// requestModel 已保存失败记录；重新装配上下文并沿用全部请求、token、
		// 时间与取消门禁，绝不把失败批次投影为工具执行。
	}
}

func (a *agentExecution) noteModelRecovery(ctx context.Context, id, status, message string, checks int) error {
	if !hstate.EvidenceRecoveryRun(a.run) {
		return nil
	}
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if status == "recovered" {
		r, err := readView(ctx, m.store).Get(ctx, a.run.ID)
		if err != nil {
			return err
		}
		if r.Wait == nil && (r.Recovery == nil || r.Recovery.Status != "correcting" || r.Recovery.Tool != "模型响应") {
			return nil
		}
	}
	_, err := m.store.ChangeRun(ctx, a.run.ID, "model-recovery", func(tx sessionstore.Tx, r *Run) error {
		if r.Status != StateRunning || r.CancelRequestedAt != "" {
			return context.Canceled
		}
		if status == "recovered" {
			if r.Wait == nil && (r.Recovery == nil || r.Recovery.Status != "correcting" || r.Recovery.Tool != "模型响应") {
				return nil
			}
			r.Wait = nil
			if r.Recovery == nil {
				r.Recovery = &RunRecovery{Tool: "模型响应"}
			}
			r.Recovery.Status, r.Recovery.Message = status, message
		} else {
			r.Recovery = &RunRecovery{OperationID: "model:" + id, Tool: "模型响应", StartedAt: stamp(m.deps.Now()), Deadline: stamp(m.deps.Now().Add(time.Duration(r.Limits.ModelTimeoutSeconds) * time.Second)), Checks: checks, Status: status, Message: message}
		}
		return tx.Event(ctx, r, "recovery/model-"+status, "", nil, r.Recovery)
	})
	return err
}

func transientModelFailure(code string) bool {
	switch code {
	case "model-request-failed", "model-rate-limited", "model-resource-unavailable", "model-timeout", "model-server-error":
		return true
	}
	return false
}

func (a *agentExecution) schemaCorrectionCount(ctx context.Context, latest ModelRequestRecord) (int, error) {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()

	return a.correctionCount(ctx, latest, "model-tool-schema-invalid", true)
}

func (a *agentExecution) correctionCount(ctx context.Context, latest ModelRequestRecord, code string, match bool) (int, error) {
	names, _ := json.Marshal(latest.ToolNames)
	return storeRead(ctx, a.manager.store, "correction-count", func(ctx context.Context) (int, error) {
		var count int
		err := readView(ctx, a.manager.store).CorrectionCount(ctx, a.run.ID, code, match, latest.CorrectionKey, string(names), &count)
		return count, err
	})
}

// Failure analysis uses only bounded public facts, no tools or raw provider
// diagnostics. It is optional and preflighted against the remaining Run budget.
func (a *agentExecution) summarizeFailure(ctx context.Context, cause error) {
	if !hstate.EvidenceRecoveryRun(a.run) || ctx.Err() != nil {
		return
	}
	var failure *Error
	if !errors.As(cause, &failure) || budgetStopFor(a.run, failure.Code) != nil || hstate.ContinuousRun(a.run) && (strings.HasPrefix(failure.Code, "storage-") || strings.HasPrefix(failure.Code, "record-storage") || transientModelFailure(failure.Code) || failure.Code == "model-unavailable" || failure.Code == "model-auth-failed" || failure.Code == "model-http-failed" || failure.Code == "model-unresponsive") {
		return
	}
	m := a.manager
	m.mu.Lock()
	r, err := readView(ctx, m.store).Get(ctx, a.run.ID)
	if err != nil || r.Status != StateRunning || r.CancelRequestedAt != "" || m.storageError {
		m.mu.Unlock()
		return
	}
	var exists bool
	err = readView(ctx, m.store).FailureSummaryExists(ctx, r.ID, &exists)
	if err != nil || exists {
		m.mu.Unlock()
		return
	}
	r.Error = &Failure{Code: failure.Code, Message: failure.Message}
	report, err := buildRunReport(ctx, m.store, r)
	if err == nil {
		// 在追加可选模型分析前先持久保存事实，模型失败不抹掉确定结论。
		_, err = m.store.ChangeRun(ctx, r.ID, "failure-facts", func(tx sessionstore.Tx, current *Run) error {
			if current.Status != StateRunning || current.CancelRequestedAt != "" {
				return context.Canceled
			}
			current.Report = report
			return saveRun(ctx, tx, current)
		})
	}
	m.mu.Unlock()
	if err != nil {
		return
	}
	request := model.Request{ToolChoice: "none", MaxTokens: min(2048, a.outputLimit("")), Messages: []model.Message{{Role: "system", Content: "根据给定执行事实，用简洁中文解释失败步骤、已知原因、尝试过程、剩余目标和下一步。事实不足明确说明，不猜测根因，不声称未知操作成功，不请求或执行工具，不输出隐藏推理。"}, {Role: "user", Content: report.Text()}}}
	if estimateRequestTokens(request) > 8192 {
		return
	}
	if !hstate.ContinuousRun(r) && estimateRequestTokens(request)+request.MaxTokens+r.Usage.Tokens > r.Limits.TokenBudget {
		return
	}
	summaryCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	record, err := a.requestModel(summaryCtx, "failure-summary", request, nil, r.InitialMemoryRevision)
	if err != nil || record.Response == nil || len(record.Response.ToolCalls) > 0 || record.Response.FinishReason != "stop" {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed || m.storageError {
		return
	}
	_, _ = m.store.ChangeRun(context.Background(), r.ID, "failure-analysis", func(tx sessionstore.Tx, current *Run) error {
		if current.Status != StateRunning || current.CancelRequestedAt != "" {
			return nil
		}
		current.FailureAnalysis = record.Response.Content
		if current.Report != nil {
			current.Report.Analysis = record.Response.Content
		}
		return saveRun(context.Background(), tx, current)
	})
}
