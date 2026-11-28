package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"elysian/server/internal/agent/tools"
	"elysian/server/internal/database"
)

// 管理员对账把 database-provision 域的未知任务交给部署入口按证据核实，不重投原请求。
func TestAgentTaskReconcilerRoutesDatabaseProvision(t *testing.T) {
	provisioning := &database.AgentFacade{}
	// Facade 零值不可用：路由先按可用性拒绝，证明分支确实进入了部署入口。
	err := agentTaskReconciler(nil, nil, provisioning)(context.Background(), tools.TaskReconciliation{Task: tools.TaskReference{Domain: database.ProvisionTaskDomain, ID: "task-1", RequestID: "req-1"}})
	if err == nil {
		t.Fatalf("未装配的部署入口应报不可用：%v", err)
	}
}

func TestProvisionReconciliationBindsCanonicalRequest(t *testing.T) {
	input := database.ProvisionInput{Engine: "MySQL", Version: "8.0", Database: "shop", RequestID: strings.Repeat("b", 64)}
	raw, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	intent := tools.TaskReconciliation{ID: "barrier", Tool: "database_provision", ArgumentsJSON: string(raw),
		Task:     tools.TaskReference{Domain: database.ProvisionTaskDomain, ID: strings.Repeat("a", 64), RequestID: input.RequestID},
		Decision: "confirmed-completed", Evidence: "只读验证"}
	resolution, err := provisionResolutionFromIntent(intent)
	digest, digestErr := database.ProvisionInputDigest(input)
	if err != nil || digestErr != nil || resolution.Digest != digest || resolution.Target != "MySQL/8.0/shop" || resolution.Evidence != intent.Evidence {
		t.Fatalf("对账必须绑定规范身份：%+v %v", resolution, err)
	}
	intent.Task.Digest = strings.Repeat("c", 64)
	if _, err := provisionResolutionFromIntent(intent); err == nil {
		t.Fatal("已有摘要与原参数不符时必须拒绝")
	}
}

func TestProvisionStatusDoesNotExposeAdministrativeEvidence(t *testing.T) {
	status := provisionTaskStatus(database.ProvisionTask{State: database.ProvisionUnknown,
		Resolution: &database.ProvisionResolution{Decision: "confirmed-stopped", Evidence: "operator-only"}})
	raw, err := json.Marshal(status)
	if err != nil || strings.Contains(string(raw), "operator-only") || strings.Contains(string(raw), "resolution") {
		t.Fatalf("管理员证据不得进入模型回执：%s %v", raw, err)
	}
}
