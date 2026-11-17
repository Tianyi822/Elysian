package harness

import (
	"context"

	hstate "elysian/server/internal/agent/harness/state"
)

const resourceBudgetPolicy = "resource-budget/v1"
const continuousBudgetPolicy = "resource-budget/v2"

func resourceBudgetRun(r Run) bool {
	return r.BudgetPolicy == resourceBudgetPolicy && r.SessionID != "" && r.WorkflowID == "" && r.DriverVersion == "v2"
}

func callLimitReached(r Run) bool {
	return !hstate.ContinuousRun(r) && !(resourceBudgetRun(r) && r.Limits.MaxSteps == 0) && r.Usage.Calls >= r.Limits.MaxSteps
}

func modelLimitReached(r Run, additional, reserve int) bool {
	return !hstate.ContinuousRun(r) && !(resourceBudgetRun(r) && r.Limits.MaxModelRequests == 0) && r.Usage.ModelRequests+additional > r.Limits.MaxModelRequests-reserve
}

func toolTokenBudget(r Run) error {
	if resourceBudgetRun(r) && r.Usage.Tokens >= r.Limits.TokenBudget {
		return bad("token-budget", "本轮 token 额度已用完")
	}
	return nil
}

// 每个已派发调用在自身回执中预留容量，暂停、重启和异步结算均可恢复。
// 内部同步工具按实际结果检查；等待用户回答与外部调用按单次上限预留。
func ensureResultBudget(ctx context.Context, q rowReader, r Run, size int) error {
	if !resourceBudgetRun(r) {
		return nil
	}
	var reserved int64
	if err := readView(ctx, q).ReservedResultBytes(ctx, r.ID, &reserved); err != nil {
		return err
	}
	if int64(r.Usage.ResultBytes)+reserved+int64(size) > int64(r.Limits.RunResultBytes) {
		return bad("result-budget", "本轮剩余结果容量不足以接受下一次工具回执")
	}
	return nil
}

func budgetStopFor(r Run, reason string) *BudgetStop {
	if !resourceBudgetRun(r) {
		return nil
	}
	switch reason {
	case "token-budget", "model-budget":
		return &BudgetStop{Resource: "tokens", Used: int64(r.Usage.Tokens), Limit: int64(r.Limits.TokenBudget)}
	case "run-timeout":
		return &BudgetStop{Resource: "active-time", Used: r.ActiveMilliseconds, Limit: int64(r.Limits.RunTimeoutSeconds) * 1000}
	case "result-budget":
		return &BudgetStop{Resource: "results", Used: int64(r.Usage.ResultBytes), Limit: int64(r.Limits.RunResultBytes)}
	}
	return nil
}
