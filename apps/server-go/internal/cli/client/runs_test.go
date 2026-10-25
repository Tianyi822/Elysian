package client

import (
	"context"
	"io"
	"net/http"
	"testing"
)

// 运行状态呈现与任务列表契约（§3.1「运行失败」态）：终态归因映射、失败原文
// 保留、未知状态不掩盖；latestRun 任务页解析。

// TestRunOutcomeMatrix 运行状态标签矩阵与失败细节。
func TestRunOutcomeMatrix(t *testing.T) {
	cases := []struct {
		name   string
		run    Run
		label  string
		detail string
		failed bool
	}{
		{"排队", Run{Status: "queued"}, "排队中", "", false},
		{"运行", Run{Status: "running"}, "运行中", "", false},
		{"等待输入", Run{Status: "waiting-input"}, "等待用户输入", "", false},
		{"等待审批", Run{Status: "waiting-approval"}, "等待审批", "", false},
		{"成功", Run{Status: "succeeded"}, "已完成", "", false},
		{"取消", Run{Status: "cancelled"}, "已取消", "", false},
		{
			"失败带服务端消息",
			Run{Status: "failed", Error: &Failure{Code: "model-error", Message: "模型请求失败"}},
			"运行失败", "模型请求失败", true,
		},
		{
			"失败只有错误码",
			Run{Status: "failed", Error: &Failure{Code: "quota"}},
			"运行失败", "错误码：quota", true,
		},
		{
			"面板重启中断",
			Run{Status: "interrupted", EndReason: "panel-restarted"},
			"运行已中断", "面板重启导致运行中断", true,
		},
		{
			"审批拒绝终因",
			Run{Status: "failed", EndReason: "approval-denied"},
			"运行失败", "审批被拒绝", true,
		},
		{
			"未知结束原因回原文",
			Run{Status: "interrupted", EndReason: "mystery"},
			"运行已中断", "结束原因：mystery", true,
		},
		{
			"未知状态回原文",
			Run{Status: "warp-speed"},
			"warp-speed", "", false,
		},
	}
	for _, tc := range cases {
		got := RunOutcome(tc.run)
		if got.Label != tc.label || got.Detail != tc.detail || got.Failed != tc.failed {
			t.Fatalf("%s：得到 %+v，期望 label=%q detail=%q failed=%v", tc.name, got, tc.label, tc.detail, tc.failed)
		}
	}
}

// TestListSessionTasksAndLatestRun 任务页解析：kind=agent 任务携带 latestRun，供
// 会话详情展示运行状态（含等待与终态）。
func TestListSessionTasksAndLatestRun(t *testing.T) {
	server := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions/s1/tasks": respondJSON(200, `{"items":[{"id":"t1","kind":"agent","goal":"巡检","createdAt":"2026-10-25T08:00:00.000Z","latestRun":{"id":"r1","sessionId":"s1","runNumber":3,"status":"waiting-approval","createdAt":"2026-10-25T08:01:00.000Z"}},{"id":"t2","kind":"batch","createdAt":"2026-10-25T07:00:00.000Z"}],"nextCursor":"","hasMore":false}`),
	})
	defer server.Close()
	c := New(server.URL())
	page, err := c.ListSessionTasks(context.Background(), "s1", 50)
	if err != nil {
		t.Fatalf("任务页应成功：%v", err)
	}
	if len(page.Items) != 2 || page.Items[0].Kind != "agent" {
		t.Fatalf("任务解析不符：%+v", page.Items)
	}
	run := page.Items[0].LatestRun
	if run == nil || run.Status != "waiting-approval" || run.RunNumber != 3 {
		t.Fatalf("latestRun 解析不符：%+v", run)
	}
}

// TestGetRunNotFound 运行不存在：404 归 KindServer 且消息可读。
func TestGetRunNotFound(t *testing.T) {
	server := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/runs/r-missing": respondJSON(404, `{"error":"运行不存在","code":"not-found"}`),
	})
	defer server.Close()
	c := New(server.URL())
	if _, err := c.GetRun(context.Background(), "r-missing"); err == nil {
		t.Fatal("404 应报错")
	}
}

// TestAgentRuntimeUnavailable Agent 不可用态：runtime 端点恒 200 且 available:false
// 携带 reason（不依赖服务可用）。
func TestAgentRuntimeUnavailable(t *testing.T) {
	server := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/runtime": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_, _ = io.WriteString(w, `{"available":false,"worker":"unavailable","storage":"unavailable","reason":"任务运行服务不可用","tools":[],"limits":{},"queueDepth":0}`)
		},
	})
	defer server.Close()
	c := New(server.URL())
	info, err := c.AgentRuntime(context.Background())
	if err != nil {
		t.Fatalf("runtime 应成功：%v", err)
	}
	if info.Available || info.Reason != "任务运行服务不可用" {
		t.Fatalf("不可用原因应保留：%+v", info)
	}
}
