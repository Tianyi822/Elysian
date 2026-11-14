package harness

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"elysian/server/internal/agent/harness/model"
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
	records, err := readDocuments[ModelRequestRecord](ctx, m.store.db, "SELECT document FROM model_requests WHERE run_id=? ORDER BY request_index", a.run.ID)
	if err != nil {
		return false, m.contextStoreErrorLocked(err)
	}
	count, latest := 0, false
	for _, record := range records {
		if record.Purpose != "inference" {
			continue
		}
		latest = record.Status == StateFailed && record.Error != nil && record.Error.Code == model.ToolNotLoadedCode
		if latest {
			count++
		}
	}
	if evidenceRecoveryRun(a.run) {
		if !latest {
			return false, nil
		}
		var last ModelRequestRecord
		for _, record := range records {
			if record.Purpose == "inference" {
				last = record
			}
		}
		count = 0
		for _, record := range records {
			if record.Purpose == "inference" && record.Error != nil && record.Error.Code == model.ToolNotLoadedCode && correctionIdentity(record) == correctionIdentity(last) {
				count++
			}
		}
		return count < 3, nil
	}
	return latest && count == 1, nil
}

func (a *agentExecution) requestInference(ctx context.Context) (ModelRequestRecord, error) {
	transientAttempts := 0
	for {
		request, refs, revision, err := a.buildContext(ctx)
		if err != nil {
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
		if evidenceRecoveryRun(a.run) {
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
				return record, bad("no-progress", "相同工具参数在没有新证据的情况下连续校验失败三次，已停止重复纠正；"+failure.Message)
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
		if !errors.As(err, &failure) || failure.Code != model.ToolNotLoadedCode {
			return record, err
		}
		correct, readErr := a.pendingToolCorrection(ctx)
		if readErr != nil {
			return record, readErr
		}
		if !correct {
			if evidenceRecoveryRun(a.run) {
				return record, bad("no-progress", "相同未加载工具提议在没有新目录证据的情况下失败三次，已停止重复纠正；"+failure.Message)
			}
			return record, err
		}
		if evidenceRecoveryRun(a.run) {
			if e := a.noteModelRecovery(ctx, record.ID, "correcting", "未加载工具的提议已整批拒绝，正在重新搜索加载", 0); e != nil {
				return record, e
			}
		}
		// requestModel 已保存失败记录；重新装配上下文并沿用全部请求、token、
		// 时间与取消门禁，绝不把失败批次投影为工具执行。
	}
}

func (a *agentExecution) noteModelRecovery(ctx context.Context, id, status, message string, checks int) error {
	if !evidenceRecoveryRun(a.run) {
		return nil
	}
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	if status == "recovered" {
		r, err := m.store.get(ctx, a.run.ID)
		if err != nil {
			return err
		}
		if r.Recovery == nil || r.Recovery.Status != "correcting" || r.Recovery.Tool != "模型响应" {
			return nil
		}
	}
	_, err := m.store.change(ctx, a.run.ID, "model-recovery", func(tx *sql.Tx, r *Run) error {
		if r.Status != StateRunning || r.CancelRequestedAt != "" {
			return context.Canceled
		}
		if status == "recovered" {
			if r.Recovery == nil || r.Recovery.Status != "correcting" || r.Recovery.Tool != "模型响应" {
				return nil
			}
			r.Recovery.Status, r.Recovery.Message = status, message
		} else {
			r.Recovery = &RunRecovery{OperationID: "model:" + id, Tool: "模型响应", StartedAt: stamp(m.deps.Now()), Deadline: stamp(m.deps.Now().Add(time.Duration(r.Limits.ModelTimeoutSeconds) * time.Second)), Checks: checks, Status: status, Message: message}
		}
		return m.store.event(ctx, tx, r, "recovery/model-"+status, "", nil, r.Recovery)
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

func correctionIdentity(r ModelRequestRecord) string {
	return r.CorrectionKey + ":" + digestJSON(r.ToolNames)
}

func (a *agentExecution) schemaCorrectionCount(ctx context.Context, latest ModelRequestRecord) (int, error) {
	m := a.manager
	m.mu.Lock()
	defer m.mu.Unlock()
	records, err := readDocuments[ModelRequestRecord](ctx, m.store.db, "SELECT document FROM model_requests WHERE run_id=? AND json_extract(document,'$.purpose')='inference' ORDER BY request_index DESC", a.run.ID)
	if err != nil {
		return 0, m.contextStoreErrorLocked(err)
	}
	count := 0
	for _, r := range records {
		if r.Error != nil && r.Error.Code == "model-tool-schema-invalid" && correctionIdentity(r) == correctionIdentity(latest) {
			count++
		}
	}
	return count, nil
}

// Failure analysis uses only bounded public facts, no tools or raw provider
// diagnostics. It is optional and preflighted against the remaining Run budget.
func (a *agentExecution) summarizeFailure(ctx context.Context, cause error) {
	if !evidenceRecoveryRun(a.run) || ctx.Err() != nil {
		return
	}
	var failure *Error
	if !errors.As(cause, &failure) || budgetStopFor(a.run, failure.Code) != nil {
		return
	}
	m := a.manager
	m.mu.Lock()
	r, err := m.store.get(ctx, a.run.ID)
	if err != nil || r.Status != StateRunning || r.CancelRequestedAt != "" || m.storageError {
		m.mu.Unlock()
		return
	}
	var exists bool
	err = m.store.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM model_requests WHERE run_id=? AND json_extract(document,'$.purpose')='failure-summary')", r.ID).Scan(&exists)
	if err != nil || exists {
		m.mu.Unlock()
		return
	}
	r.Error = &Failure{Code: failure.Code, Message: failure.Message}
	report, err := buildRunReport(ctx, m.store.db, r)
	if err == nil {
		// 在追加可选模型分析前先持久保存事实，模型失败不抹掉确定结论。
		_, err = m.store.change(ctx, r.ID, "failure-facts", func(tx *sql.Tx, current *Run) error {
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
	request := model.Request{ToolChoice: "none", MaxTokens: min(1024, a.outputLimit("")), Messages: []model.Message{{Role: "system", Content: "根据给定执行事实，用简洁中文解释失败步骤、已知原因、尝试过程、剩余目标和下一步。事实不足明确说明，不猜测根因，不声称未知操作成功，不请求或执行工具，不输出隐藏推理。"}, {Role: "user", Content: report.text()}}}
	if estimateRequestTokens(request)+request.MaxTokens+r.Usage.Tokens > r.Limits.TokenBudget {
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
	_, _ = m.store.change(context.Background(), r.ID, "failure-analysis", func(tx *sql.Tx, current *Run) error {
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
