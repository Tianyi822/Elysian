package app

import (
	"encoding/json"
	"testing"

	"elysian/server/internal/agent/tools"
	"elysian/server/internal/containerapps"
	"elysian/server/internal/docker"
	"elysian/server/internal/websites"
)

func TestWebsiteTaskStatusPreservesActiveStagesAndEndEvidence(t *testing.T) {
	for _, tc := range []struct {
		state            string
		terminal, failed bool
		want             tools.TaskOutcome
	}{
		{"queued", false, false, tools.TaskRunning}, {"building", false, false, tools.TaskRunning},
		{"publishing", false, false, tools.TaskRunning}, {"awaiting-config", false, false, tools.TaskRunning},
		{"succeeded", true, false, tools.TaskSucceeded}, {"failed", true, true, tools.TaskFailed},
		{"unknown", false, false, tools.TaskUnknown}, {"failed", false, false, tools.TaskUnknown},
		{"interrupted", false, false, tools.TaskUnknown}, {"cancelled", false, false, tools.TaskUnknown},
		{"interrupted", true, true, tools.TaskFailed}, {"cancelled", true, true, tools.TaskFailed},
	} {
		t.Run(tc.state+"/"+string(tc.want), func(t *testing.T) {
			got := websiteTaskStatus(websites.AgentTaskStatus{State: tc.state, Terminal: tc.terminal, Failed: tc.failed, Value: "website-receipt", Stage: "网站受控阶段"})
			if got.EffectiveOutcome() != tc.want || got.Terminal != tc.terminal || got.Failed != tc.failed || got.Value != "website-receipt" || got.ErrorCode != "website-task-"+string(tc.want) {
				t.Fatalf("%+v: %+v", tc, got)
			}
			assertTaskStatusProgress(t, got)
		})
	}
}

func TestContainerBuildTaskStatusKeepsBuildingActiveAndUnsettledExitUnknown(t *testing.T) {
	for _, tc := range []struct {
		state            string
		terminal, failed bool
		want             tools.TaskOutcome
	}{
		{containerapps.BuildStateQueued, false, false, tools.TaskRunning},
		{containerapps.BuildStateBuilding, false, false, tools.TaskRunning},
		{containerapps.BuildStateSucceeded, true, false, tools.TaskSucceeded},
		{containerapps.BuildStateFailed, true, true, tools.TaskFailed},
		{containerapps.BuildStateCancelled, true, true, tools.TaskFailed},
		{containerapps.BuildStateInterrupted, true, true, tools.TaskFailed},
		{containerapps.BuildStateFailed, false, false, tools.TaskUnknown},
		{containerapps.BuildStateCancelled, false, false, tools.TaskUnknown},
		{containerapps.BuildStateInterrupted, false, false, tools.TaskUnknown},
	} {
		t.Run(tc.state+"/"+string(tc.want), func(t *testing.T) {
			got := containerBuildTaskStatus(containerapps.AgentTaskStatus{State: tc.state, Terminal: tc.terminal, Failed: tc.failed, Value: "build-receipt", Stage: "打包构建上下文"})
			if got.EffectiveOutcome() != tc.want || got.Terminal != tc.terminal || got.Failed != tc.failed || got.Value != "build-receipt" || got.ErrorCode != "container-app-build-"+string(tc.want) {
				t.Fatalf("%+v: %+v", tc, got)
			}
			assertTaskStatusProgress(t, got)
		})
	}
}

func assertTaskStatusProgress(t *testing.T, status tools.TaskStatus) {
	t.Helper()
	if status.Terminal {
		if status.Progress != nil {
			t.Fatal("已确认终态仍返回运行进度")
		}
		return
	}
	want := "running"
	if status.Outcome == tools.TaskUnknown {
		want = "unknown"
		if status.Error == "" {
			t.Fatal("未确认结果缺少核实提示")
		}
	}
	if status.Progress == nil || status.Progress.State != want {
		t.Fatalf("progress=%+v want=%s", status.Progress, want)
	}
}

func TestAgentPullProgressProjectsOnlyCurrentLayer(t *testing.T) {
	for _, fixture := range []struct {
		body           string
		state, message string
		bytes          bool
	}{
		{`{"state":"running"}`, "running", "正在准备镜像拉取", false},
		{`{"state":"running","progress":{"phase":"downloading","layerId":"layer","currentBytes":0,"totalBytes":100}}`, "running", "正在下载镜像层", true},
		{`{"state":"running","progress":{"phase":"extracting","layerId":"layer","currentBytes":50,"totalBytes":100}}`, "running", "正在解压镜像层", true},
		{`{"state":"running","progress":{"phase":"finalizing","layerId":"layer","currentBytes":50,"totalBytes":100}}`, "running", "正在确认镜像拉取结果", false},
		{`{"state":"running","progress":{"phase":"downloading","currentBytes":50,"totalBytes":100}}`, "running", "正在下载镜像层", false},
		{`{"state":"unknown","errorMessage":"达到安全上限，结果未确认","progress":{"phase":"downloading","layerId":"layer","currentBytes":50,"totalBytes":100}}`, "unknown", "达到安全上限，结果未确认", false},
	} {
		var task docker.AgentPullTask
		if err := json.Unmarshal([]byte(fixture.body), &task); err != nil {
			t.Fatal(err)
		}
		progress := agentPullProgress(task)
		if progress == nil || progress.State != fixture.state || progress.Message != fixture.message || (progress.TotalBytes != nil && progress.CurrentBytes != nil) != fixture.bytes {
			t.Fatalf("%s: %+v", fixture.body, progress)
		}
	}
	for _, state := range []string{"succeeded", "failed"} {
		if agentPullProgress(docker.AgentPullTask{State: state}) != nil {
			t.Fatal("已确认终态仍返回运行进度")
		}
	}
}

func TestAgentDomainProgressUsesSafeStagesAndStopsOnUncertainty(t *testing.T) {
	for _, stage := range []string{"安装依赖、测试与构建", "打包构建上下文", "后台任务已接受"} {
		progress := agentTaskProgress("running", false, stage, "2026-11-04T00:00:00Z", "正在执行任务")
		if progress.Message != stage || progress.State != "running" || progress.CurrentBytes != nil || progress.TotalBytes != nil {
			t.Fatal(progress)
		}
		if agentTaskProgress("succeeded", true, stage, "", "") != nil {
			t.Fatal("完成后仍返回进度")
		}
	}
	for _, state := range []string{"unknown", "interrupted", "failed", "cancelled"} {
		if progress := agentTaskProgress(state, false, "", "", "执行中"); progress.State != "unknown" || progress.Message == "执行中" {
			t.Fatal(progress)
		}
	}
}
