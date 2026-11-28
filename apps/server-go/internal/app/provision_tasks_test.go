package app

import (
	"testing"

	"elysian/server/internal/agent/tools"
	"elysian/server/internal/database"
)

// 部署任务的失败按对业务的影响映射成运行时证据：未派发与已回滚可以纠正后继续，
// 部分完成必须如实说明已有变更，未知不提供任何可解除保护的证据。
func TestProvisionTaskStatusCarriesEffectAsEvidence(t *testing.T) {
	receipt := `{"action":"reuse","username":"shop_user"}`
	for name, tc := range map[string]struct {
		task      database.ProvisionTask
		outcome   tools.TaskOutcome
		execution string
		changes   string
		stage     string
	}{
		"未派发":  {task: database.ProvisionTask{State: database.ProvisionFailed, Effect: database.ProvisionEffectNotDispatched, Stage: "preflight-rejected", ErrorCode: "database-provision-failed", Message: "本地没有该版本的官方镜像"}, outcome: tools.TaskFailed, execution: "not-started", changes: "none", stage: "preflight"},
		"已回滚":  {task: database.ProvisionTask{State: database.ProvisionFailed, Effect: database.ProvisionEffectNoChange, ErrorCode: "database-provision-failed", Message: "已回滚"}, outcome: tools.TaskFailed, execution: "finished", changes: "none"},
		"部分完成": {task: database.ProvisionTask{State: database.ProvisionFailed, Effect: database.ProvisionEffectPartial, Stage: "waiting-ready", ErrorCode: "database-provision-failed", Message: "未就绪"}, outcome: tools.TaskFailed, execution: "finished", changes: "confirmed"},
		"未知":   {task: database.ProvisionTask{State: database.ProvisionUnknown, ErrorCode: "database-provision-unknown", Message: "结果未确认"}, outcome: tools.TaskUnknown},
		"成功":   {task: database.ProvisionTask{State: database.ProvisionSucceeded, Stage: "completed", Result: []byte(receipt)}, outcome: tools.TaskSucceeded},
		"执行中":  {task: database.ProvisionTask{State: database.ProvisionRunning, Stage: "waiting-ready"}, outcome: tools.TaskRunning},
	} {
		t.Run(name, func(t *testing.T) {
			status := provisionTaskStatus(tc.task)
			if status.EffectiveOutcome() != tc.outcome || status.Terminal != (tc.outcome == tools.TaskSucceeded || tc.outcome == tools.TaskFailed) {
				t.Fatalf("结果分类不符：%+v", status)
			}
			if tc.execution == "" {
				if status.Evidence != nil {
					t.Fatalf("不应提供证据：%+v", status.Evidence)
				}
			} else if status.Evidence == nil || status.Evidence.Execution != tc.execution || status.Evidence.Changes != tc.changes || status.Evidence.Recovery != "correct" {
				t.Fatalf("证据不符：%+v", status.Evidence)
			}
			if tc.stage != "" && (status.Evidence == nil || status.Evidence.Stage != tc.stage) {
				t.Fatalf("证据阶段应为 %s：%+v", tc.stage, status.Evidence)
			}
			if tc.outcome == tools.TaskFailed && status.Error != tc.task.Message {
				t.Fatalf("应保留域给出的精确原因：%q", status.Error)
			}
			if tc.outcome == tools.TaskRunning && (status.Progress == nil || status.Progress.Message == "") {
				t.Fatalf("执行中的任务应带受控进度文案：%+v", status.Progress)
			}
			if tc.outcome == tools.TaskSucceeded && tc.task.Result == nil {
				t.Fatal("夹具应有回执")
			}
		})
	}
}
