package harness

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/tools"
)

func TestDomainProgressSurvivesRefreshWithoutModelCallsOrActiveTime(t *testing.T) {
	ctx := context.Background()
	var nanos atomic.Int64
	nanos.Store(time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC).UnixNano())
	var submitted, inferences atomic.Int32
	var complete atomic.Bool
	var progress atomic.Pointer[tools.TaskProgress]
	progress.Store(&tools.TaskProgress{State: "running", Message: "正在下载镜像层", LayerID: "layer", CurrentBytes: floatPointer(0), TotalBytes: floatPointer(100)})
	ref := tools.TaskReference{Domain: "test-domain", ID: "progress-task", RequestID: "progress-request"}
	client := operationClient()
	m, session, _ := agentManager(t, func(ctx context.Context, p model.Profile, r model.Request) (model.Response, error) {
		inferences.Add(1)
		nanos.Add(int64(time.Second))
		return client(ctx, p, r)
	}, func(d *Deps) {
		d.Now = func() time.Time { return time.Unix(0, nanos.Load()) }
		d.Catalog = &operationCatalog{execute: func(context.Context, Operation) (CapabilityResult, error) {
			submitted.Add(1)
			return CapabilityResult{Value: json.RawMessage(`{"accepted":true}`), Task: &ref}, nil
		}}
		d.InspectTask = func(_ context.Context, actual tools.TaskReference) (tools.TaskStatus, error) {
			if actual != ref {
				t.Errorf("观察了不同的任务身份：%+v", actual)
			}
			return tools.TaskStatus{State: "running", Terminal: complete.Load(), Value: map[string]bool{"finished": true}, Progress: progress.Load()}, nil
		}
	})
	run := submitAgentTest(t, m, session, "progress-wait", "执行异步任务")
	approval := waitingApproval(t, m, run.ID)
	if _, err := m.Decide(ctx, approval.ID, "approved"); err != nil {
		t.Fatal(err)
	}
	waitProgress := func(message string) {
		t.Helper()
		runtimeEventually(t, func() bool {
			out, err := m.ChatSnapshot(ctx, run.ID)
			if err != nil || out.Timeline == nil {
				return false
			}
			for _, entry := range out.Timeline.Entries {
				if entry.Progress != nil && entry.Progress.Message == message {
					return true
				}
			}
			return false
		})
	}
	waitProgress("正在下载镜像层")
	runtimeEventually(t, func() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.executionLocked(run.ID) == nil })
	before, _ := m.Get(ctx, run.ID)
	requests := inferences.Load()
	nanos.Add(int64(30 * time.Minute))
	progress.Store(&tools.TaskProgress{State: "running", Message: "正在解压镜像层", LayerID: "next-layer"})
	waitProgress("正在解压镜像层")
	after, _ := m.Get(ctx, run.ID)
	if after.Status != StateWaitingTask || after.ActiveMilliseconds != before.ActiveMilliseconds || digestJSON(after.Usage) != digestJSON(before.Usage) || requests != inferences.Load() {
		t.Fatalf("进度观察消耗了执行预算或触发模型：before=%+v after=%+v", before.Usage, after.Usage)
	}
	// 输出流断开与重连只读取快照，不能停止或重投后台任务。
	server := httptest.NewServer(m.Router())
	for i := 0; i < 2; i++ {
		response, err := server.Client().Get(server.URL + "/runs/" + run.ID + "/output")
		if err != nil {
			server.Close()
			t.Fatal(err)
		}
		scanner := bufio.NewScanner(response.Body)
		found := false
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "data: ") {
				found = strings.Contains(scanner.Text(), "正在解压镜像层")
				break
			}
		}
		_ = response.Body.Close()
		if !found {
			server.Close()
			t.Fatal("重连未发送当前进度")
		}
	}
	server.Close()
	m = reopenOperationManager(t, m)
	waitProgress("正在解压镜像层")
	progress.Store(&tools.TaskProgress{State: "unknown", Message: "达到安全上限，结果未确认"})
	waitProgress("达到安全上限，结果未确认")
	current, _ := m.Get(ctx, run.ID)
	if current.Status != StateWaitingTask || current.ActiveMilliseconds != before.ActiveMilliseconds || submitted.Load() != 1 || inferences.Load() != requests {
		t.Fatal("刷新或未知进度改变了执行状态")
	}
	leases, _ := m.ResourceLeases(ctx)
	held := false
	for _, lease := range leases {
		if lease.RunID == run.ID && lease.State == "held" {
			held = true
		}
	}
	if !held {
		t.Fatal("结果未知的进度观察解除了任务租约")
	}
	complete.Store(true)
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded || submitted.Load() != 1 {
		t.Fatalf("最终回执未正常推进：%+v", finished)
	}
	out, err := m.ChatSnapshot(ctx, run.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range out.Timeline.Entries {
		if entry.Progress != nil {
			t.Fatal("完成后仍返回运行进度")
		}
	}
}

func floatPointer(value float64) *float64 { return &value }
