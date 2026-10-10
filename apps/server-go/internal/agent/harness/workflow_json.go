package harness

import "encoding/json"

// 工作流人工确认有独立内容快照，不伪装成一个空操作。
// 普通工具审批继续保持原有 JSON 形状。
func (a Approval) MarshalJSON() ([]byte, error) {
	type approvalJSON Approval
	if a.Kind != "workflow-gate" {
		return json.Marshal(approvalJSON(a))
	}
	return json.Marshal(struct {
		approvalJSON
		Operation   *Operation `json:"operation,omitempty"`
		OperationID *string    `json:"operationId,omitempty"`
	}{approvalJSON: approvalJSON(a)})
}
