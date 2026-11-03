package harness

import "encoding/json"

// toolExecutionFact 同时供时间线和模型上下文投影使用；缺少回执不等于已派发。
type toolExecutionFact struct {
	Status    string
	StartedAt string
	EndedAt   string
	Error     *Failure
}

func projectToolExecution(run Run, operation *Operation, call *Call, approval *Approval) toolExecutionFact {
	fact := toolExecutionFact{Status: "planned"}
	if operation != nil {
		fact.Status, fact.Error = operation.Status, operation.Error
		fact.StartedAt, fact.EndedAt = operation.CreatedAt, operation.EndedAt
		switch operation.Status {
		case "dispatched":
			fact.Status = StateRunning
		case "completed":
			fact.Status = "unknown" // 接受或完成标记不能替代实际回执。
		}
	}
	if call != nil {
		fact.StartedAt, fact.EndedAt, fact.Error = call.StartedAt, call.EndedAt, call.Error
		if operation == nil || (operation.Status != StateWaitingTask && operation.Status != StateWaitingResource && operation.Status != "unknown") {
			fact.Status = call.Status
		}
		if fact.Status == StateInterrupted || fact.Status == StateRecoveryRequired || terminal(run.Status) && !terminal(fact.Status) {
			fact.Status = "unknown"
		}
		return fact
	}
	// 派发身份优先于过期的审批或计划状态，不能把未知外部结果降为未执行。
	dispatched := operation != nil && (operation.DispatchID != "" || operation.DispatchedAt != "" || operation.Status == "dispatched" || operation.Status == "unknown" || operation.Status == "completed" || operation.Status == StateWaitingTask)
	if dispatched {
		if terminal(run.Status) {
			fact.Status = "unknown"
		}
		return fact
	}
	if approval != nil {
		switch approval.Status {
		case "denied", "expired", "revoked":
			fact.Status, fact.EndedAt = approval.Status, approval.DecidedAt
			return fact
		}
	}
	if terminal(run.Status) && (operation == nil || operation.Status == "planned" || operation.Status == StateWaitingApproval || operation.Status == StateWaitingResource) {
		fact.Status = "not-executed"
	}
	return fact
}

func toolFactContent(fact toolExecutionFact, call *Call) string {
	var value any
	switch fact.Status {
	case "not-executed":
		value = map[string]any{"error": Failure{Code: "tool-not-executed", Message: "运行已结束，该工具提议未派发、未执行"}}
	case "denied", "expired", "revoked":
		value = map[string]any{"error": Failure{Code: "tool-" + fact.Status, Message: "该工具提议未获有效批准，未执行"}}
	default:
		if call != nil && terminal(call.Status) && fact.Status != "unknown" {
			if call.Error != nil {
				value = map[string]any{"error": call.Error, "result": call.Result}
			} else {
				value = map[string]any{"result": call.Result, "truncated": call.Truncated}
			}
		} else {
			unknown := map[string]any{"error": Failure{Code: "outcome-unknown", Message: "调用结果未确认，须核实实际状态，不得直接重放"}}
			if call != nil && call.Result != nil {
				unknown["result"] = call.Result // 保留已确认的接受凭据，不能将其当成最终成功。
			}
			value = unknown
		}
	}
	raw, _ := json.Marshal(value)
	return string(raw)
}
