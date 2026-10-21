package harness

import (
	"strings"
	"testing"
)

func TestRuntimeInfoReportsWorkflowRetiredButWikiAvailable(t *testing.T) {
	m, _ := sessionAPIManager(t)
	info := m.Info()
	if info.Workflow.Available || info.WorkflowV2.Available {
		t.Fatalf("工作流能力位仍可用：%+v %+v", info.Workflow, info.WorkflowV2)
	}
	if !strings.Contains(info.Workflow.Reason, "退役") {
		t.Fatalf("工作流退役原因缺失：%+v", info.Workflow)
	}
	if !info.Wiki.Available {
		t.Fatalf("Wiki 能力被工作流退役连带关闭：%+v", info.Wiki)
	}
}
