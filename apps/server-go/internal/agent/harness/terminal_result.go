package harness

import (
	"context"

	hstate "elysian/server/internal/agent/harness/state"
)

func buildRunReport(ctx context.Context, q reportReader, r Run) (*RunReport, error) {
	if r.Report != nil {
		return r.Report, nil
	}
	calls, err := readView(ctx, q).RecoveryCalls(ctx, r.ID)
	if err != nil {
		return nil, err
	}
	ops, err := readView(ctx, q).ReportOperations(ctx, r.ID)
	if err != nil {
		return nil, err
	}
	byCall := map[string]*Operation{}
	for i := range ops {
		byCall[ops[i].CallID] = &ops[i]
	}
	report := &RunReport{Outcome: "本轮任务未全部完成，进度已保存。", Reason: "未取得可确认的结束原因", Steps: []ReportStep{}, Remaining: []string{}, Analysis: r.FailureAnalysis}
	if hstate.ContinuousRun(r) {
		report.Objective = r.Input
		if task, err := readTask(ctx, q, r.TaskID); err != nil {
			return nil, err
		} else if task.Goal != "" {
			report.Objective = task.Goal
			if r.Input != "" && r.Input != task.Goal {
				report.Objective += "；本轮补充：" + r.Input
			}
		}
		report.Stage = hstate.ReportStage(r.Phase)
	}
	if r.Error != nil {
		report.Reason = r.Error.Message
	}
	if r.Status == StateSucceeded {
		report.Outcome, report.Reason = "任务已完成。", "已确认结束，执行事实已保存"
	}
	if r.Status == StateCancelled {
		report.Outcome = "本轮任务已停止，已取得的执行事实已保存。"
		if r.Error == nil {
			report.Reason = "用户已停止本轮任务"
		}
	}
	for _, call := range calls {
		if call.Tool == toolSearchName || call.Tool == planTool || call.Tool == userInputTool || call.Tool == taskHistoryTool {
			continue
		}
		fact := hstate.ProjectToolExecution(r, byCall[call.ID], &call, nil)
		switch fact.Status {
		case StateSucceeded:
			report.Completed++
		case "unknown", StateWaitingTask:
			report.Unconfirmed++
		case StateFailed:
			report.Failed++
		}
		report.Steps = append(report.Steps, ReportStep{CallID: call.ID, Tool: call.Tool, Status: fact.Status, Attempts: max(1, len(call.Attempts)), Error: call.Error})
	}
	if len(report.Steps) > 20 {
		report.Steps = report.Steps[len(report.Steps)-20:]
	}
	if r.Plan != nil {
		for _, s := range r.Plan.Steps {
			if s.Status != "completed" {
				report.Remaining = append(report.Remaining, s.Title)
			}
		}
	}
	report.Next = "可在原会话调整方案后继续；已确认成功的操作不会重放。"
	if report.Unconfirmed > 0 {
		report.Next = "先核实结果未确认的操作；取得可信结束证据并解除保护后才能继续，不能直接重复提交。"
	}
	return report, nil
}
