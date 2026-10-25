package client

// 运行状态展示（CLI 方案 §3.1「运行失败」态与 §6.3）：Run 终态 failed/interrupted
// 属运行失败态，错误与 endReason 原文呈现；interrupted(panel-restarted) 附面板重启
// 说明。等待态（waiting-input 等）与进行态只做标签映射，不虚构细节。

// Outcome 是一次运行的终端呈现结论：Label 状态标签，Detail 失败／中断细节（可空），
// Failed 为真表示运行失败态（界面按危险色标注）。
type Outcome struct {
	Label  string
	Detail string
	Failed bool
}

// RunOutcome 把 Run 状态翻译为终端呈现；未知状态回原文标签，不掩盖。
func RunOutcome(run Run) Outcome {
	switch run.Status {
	case "queued":
		return Outcome{Label: "排队中"}
	case "running":
		return Outcome{Label: "运行中"}
	case "waiting-input":
		return Outcome{Label: "等待用户输入"}
	case "waiting-approval":
		return Outcome{Label: "等待审批"}
	case "waiting-resource":
		return Outcome{Label: "等待资源"}
	case "waiting-task":
		return Outcome{Label: "等待任务"}
	case "recovery-required":
		return Outcome{Label: "需要恢复", Detail: endReasonDetail(run), Failed: true}
	case "succeeded":
		return Outcome{Label: "已完成"}
	case "cancelled":
		return Outcome{Label: "已取消"}
	case "failed":
		return Outcome{Label: "运行失败", Detail: failureDetail(run), Failed: true}
	case "interrupted":
		return Outcome{Label: "运行已中断", Detail: endReasonDetail(run), Failed: true}
	default:
		return Outcome{Label: run.Status}
	}
}

// failureDetail 失败细节：优先服务端中文错误消息，缺失时回错误码。
func failureDetail(run Run) string {
	if run.Error != nil {
		if run.Error.Message != "" {
			return run.Error.Message
		}
		if run.Error.Code != "" {
			return "错误码：" + run.Error.Code
		}
	}
	if run.EndReason != "" {
		return endReasonDetail(run)
	}
	return ""
}

// endReasonDetail 终态归因的中文说明：已知 endReason 映射，未知取原文，空则无细节。
func endReasonDetail(run Run) string {
	known := map[string]string{
		"panel-restarted":          "面板重启导致运行中断",
		"approval-denied":          "审批被拒绝",
		"approval-expired":         "审批已过期",
		"cancelled":                "已请求取消",
		"completed":                "已完成",
		"wiki-context-invalidated": "知识上下文已失效",
		"domain-task-failed":       "域任务失败",
		"invalid-workflow-output":  "工作流输出无效",
		"workflow-binding":         "工作流绑定失效",
	}
	if run.EndReason == "" {
		return ""
	}
	if label, ok := known[run.EndReason]; ok {
		return label
	}
	return "结束原因：" + run.EndReason
}
