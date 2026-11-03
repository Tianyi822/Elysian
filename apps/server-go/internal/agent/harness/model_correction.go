package harness

import (
	"context"
	"errors"

	"elysian/server/internal/agent/harness/model"
)

// 纠正仅限普通聊天的按需工具发现；不重放任何被拒绝的工具调用。
func (a *agentExecution) toolCorrectionEligible() bool {
	return a.DriverVersion() == 2 && a.run.WorkflowID == "" && a.onDemandTools()
}

// 配额由持久化请求决定，恢复或重新进入 NextModel 不会重置。只在最近一条
// 推理是本 Run 唯一一次未加载工具失败时，为下一次请求提供纠正提示。
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
	return latest && count == 1, nil
}

func (a *agentExecution) requestInference(ctx context.Context) (ModelRequestRecord, error) {
	for {
		request, refs, revision, err := a.buildContext(ctx)
		if err != nil {
			return ModelRequestRecord{}, err
		}
		record, err := a.requestModel(ctx, "inference", request, refs, revision)
		var failure *Error
		if err == nil || ctx.Err() != nil || !errors.As(err, &failure) || failure.Code != model.ToolNotLoadedCode {
			return record, err
		}
		correct, readErr := a.pendingToolCorrection(ctx)
		if readErr != nil {
			return record, readErr
		}
		if !correct {
			return record, err
		}
		// requestModel 已保存失败记录；重新装配上下文并沿用全部请求、token、
		// 时间与取消门禁，绝不把失败批次投影为工具执行。
	}
}
