package harness

import (
	"context"
	"encoding/json"
	"slices"
	"sync/atomic"
	"testing"
)

func TestWorkflowMissingBindingKeepsFailedAttemptForExternalReceipt(t *testing.T) {
	ctx := context.Background()
	var calls atomic.Int32
	m, session := workflowTestManager(t, &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
		calls.Add(1)
		return CapabilityResult{Value: json.RawMessage(`{"ok":true}`)}, nil
	}})
	steps := workflowOneOperation("test_write")
	steps[0].Input = workflowTestInput("/missing")
	w := workflowStepsTest(t, m, session, steps)
	w = workflowWait(t, m, w.ID, StateRecoveryRequired)
	if w.Error == nil || w.Error.Code != "workflow-binding" || w.ActiveRunID == "" || !slices.Contains(w.AllowedActions, "accept-result") {
		t.Fatalf("绑定失败没有保留可核实的尝试：%+v", w)
	}
	run, err := m.Get(ctx, w.ActiveRunID)
	if err != nil || run.Status != StateFailed || run.EndReason != "workflow-binding" {
		t.Fatalf("绑定失败没有固定原运行终态：%+v %v", run, err)
	}
	approvals, err := m.Approvals(ctx)
	if err != nil || len(approvals) != 0 || calls.Load() != 0 || w.Usage.Calls != 0 {
		t.Fatalf("输入不完整仍请求授权或执行：%+v calls=%d err=%v", approvals, calls.Load(), err)
	}
	input := WorkflowRecoveryInput{RequestID: "binding-external-result", ExpectedRevision: w.Revision, Action: "accept-result", Evidence: "已在专用测试系统核对操作结果，证据编号 123", OutputJSON: `{"ok":true}`}
	w, duplicate, err := m.RecoverWorkflow(ctx, w.ID, input)
	if err != nil || duplicate || w.Status != StateSucceeded || w.OutputJSON != input.OutputJSON {
		t.Fatalf("绑定失败的外部结果无法补录：%+v duplicate=%v err=%v", w, duplicate, err)
	}
	original, err := m.Get(ctx, run.ID)
	if err != nil || original.Status != StateFailed || original.EndReason != "workflow-binding" || calls.Load() != 0 {
		t.Fatalf("补录改写原始事实或派发：%+v calls=%d err=%v", original, calls.Load(), err)
	}
	m = reopenOperationManager(t, m)
	restored, err := m.GetWorkflow(ctx, w.ID)
	if err != nil || restored.Status != StateSucceeded || calls.Load() != 0 {
		t.Fatalf("补录完成后重启重放：%+v calls=%d err=%v", restored, calls.Load(), err)
	}
}
