package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
)

func TestNativeDatabasePreflightRejectionContinuesAndReleasesBarrier(t *testing.T) {
	bridge := databaseBusinessBridge(t)
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if strings.Contains(allRequestText(request), "database-task-rejected") {
			if !strings.Contains(allRequestText(request), "missing") {
				t.Error("未返回参数纠正指引")
			}
			return finalReply("任务尚未执行，需要将 expected 修正为 missing 并选择明确版本"), nil
		}
		if !contains(toolNames(request), "database_create") {
			return searchReply("database_create"), nil
		}
		reply := toolReply("database_create")
		reply.ToolCalls[0].Arguments = json.RawMessage(`{"charset":"utf8mb4","containerName":"mysql","engine":"MySQL","expected":"absent","id":"new:mysql","imageId":"7b16ec7caa94ca7e92f4c5ec287de69d2e8738db056ceb629022951af6d910b","name":"mysql","requestId":"` + strings.Repeat("a", 64) + `","versionTag":"latest"}`)
		return reply, nil
	}, func(d *Deps) {
		d.Tools, d.Catalog, d.Spawn = bridge, &Extensions{MountRoot: t.TempDir()}, frozenDatabaseSpawn
	})
	run, _, err := m.CreateTask(context.Background(), session.ID, AgentInput{RequestID: "investigation-screenshot", Content: "创建 MySQL", ExtensionMode: "enabled", AuthorizationMode: AuthorizationOnDemand})
	if err != nil {
		t.Fatal(err)
	}
	var approval Approval
	runtimeEventually(t, func() bool {
		current, _ := m.Get(context.Background(), run.ID)
		if terminal(current.Status) {
			t.Fatalf("finished before approval: status=%s reason=%s error=%+v", current.Status, current.EndReason, current.Error)
		}
		approvals, _ := m.Approvals(context.Background())
		for _, item := range approvals {
			if item.RunID == run.ID && item.Status == "pending" {
				approval = item
				return true
			}
		}
		return false
	})
	if _, err := m.DecideAccess(context.Background(), approval.ID, accessInput(approval, "once", "investigation-approve")); err != nil {
		t.Fatal(err)
	}
	finished := runtimeFinished(t, m, run.ID)
	if finished.Status != StateSucceeded {
		t.Fatalf("expected screenshot failure: status=%s reason=%s error=%+v", finished.Status, finished.EndReason, finished.Error)
	}
	calls, err := m.Calls(context.Background(), run.ID, "", 50)
	// 工具精简后注入目录落在 eager 阈值内，database_create 首请求即定义可见，
	// 不再经历 tool_search 往返；本测试关注预检拒绝是否继续运行并回传精确原因。
	if err != nil || len(calls.Items) != 1 || calls.Items[0].Error == nil {
		t.Fatalf("missing calls: %+v %v", calls, err)
	}
	if calls.Items[0].Error.Code != "database-task-rejected" {
		t.Fatalf("预检错误被覆盖：%+v", calls.Items[0])
	}
	operations, err := m.Operations(context.Background(), run.ID)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, operation := range operations {
		if operation.Capability.Name == "database_create" {
			found = true
			if operation.Status != "completed" || operation.Task != nil {
				t.Fatalf("拒绝任务仍有未知状态或任务指针：%+v", operation)
			}
		}
	}
	if !found {
		t.Fatal("缺少数据库操作记录")
	}
	leases, err := m.ResourceLeases(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, lease := range leases {
		if lease.State != "released" {
			t.Fatalf("未释放资源：%+v", lease)
		}
	}
	barriers, err := m.Barriers(context.Background())
	if err != nil || len(barriers) != 1 || barriers[0].Status != "confirmed" {
		t.Fatalf("屏障未确认：%+v %v", barriers, err)
	}
	_, raw := readRecordLines(t, m.store, recordOwner{"session", session.ID})
	if !strings.Contains(string(raw), "database-task-rejected") || strings.Contains(string(raw), "outcome-unknown") {
		t.Fatal("JSONL 未保留真实拒绝原因")
	}
}

func TestRealClientContinuationCorrectsUnloadedToolWithoutPartialExecution(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		name, args := "test_read", "{}"
		index := requests.Add(1)
		if index == 5 {
			var body struct {
				Messages []struct {
					Content string `json:"content"`
				} `json:"messages"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if len(body.Messages) == 0 || !strings.Contains(body.Messages[len(body.Messages)-1].Content, "整批提议均未执行") {
				t.Error("纠正提示不在尾部状态")
			}
		}
		switch index {
		case 1, 5:
			name, args = toolSearchName, `{"query":"test_read"}`
		case 4:
			// 可见工具在前、隐藏工具在后；必须整批拒绝，不能先执行搜索。
			io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"search","type":"function","function":{"name":"tool_search","arguments":"{\"query\":\"test_read\"}"}},{"id":"hidden","type":"function","function":{"name":"test_read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`)
			return
		case 3, 7:
			io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"检查完成"},"finish_reason":"stop"}]}`)
			return
		}
		fmt.Fprintf(w, `{"choices":[{"message":{"role":"assistant","reasoning_content":"I should verify the state.","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":%q,"arguments":%q}}]},"finish_reason":"tool_calls"}]}`, name, args)
	}))
	defer server.Close()
	client := model.NewClient(server.Client())
	m, session, _ := agentManager(t, func(ctx context.Context, p model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		p.BaseURL, p.Provider = server.URL, model.ProviderDeepSeek
		return client.Complete(ctx, p, request)
	}, func(d *Deps) { d.Catalog = &discoveryTestCatalog{} })
	approveEnvironment(t, m, session)
	first := submitAgentTest(t, m, session, "investigation-first", "读取状态")
	if got := runtimeFinished(t, m, first.ID); got.Status != StateSucceeded {
		t.Fatalf("first run failed: %+v", got.Error)
	}
	next, _, err := m.ContinueTask(context.Background(), first.TaskID, AgentInput{RequestID: "investigation-next", Content: "继续"})
	if err != nil {
		t.Fatal(err)
	}
	got := runtimeFinished(t, m, next.ID)
	if got.Status != StateSucceeded || requests.Load() != 7 {
		t.Fatalf("expected real parser failure: %+v", got.Error)
	}
	records, err := m.ModelRequests(context.Background(), next.ID, "", 50)
	if err != nil || len(records.Items) < 4 || contains(records.Items[0].ToolNames, "test_read") {
		t.Fatalf("continuation visibility mismatch: %+v %v", records, err)
	}
	if records.Items[0].Status != StateFailed || records.Items[0].Error == nil || records.Items[0].Error.Code != model.ToolNotLoadedCode || records.Items[0].Response != nil {
		t.Fatalf("失败记录不符：%+v", records.Items[0])
	}
	calls, err := m.Calls(context.Background(), next.ID, "", 50)
	if err != nil || len(calls.Items) != 2 || calls.Items[0].Tool != toolSearchName || calls.Items[1].Tool != "test_read" {
		t.Fatalf("失败批次被部分执行：%+v %v", calls, err)
	}
	for _, call := range calls.Items {
		if call.ModelRequestID == records.Items[0].ID {
			t.Fatal("执行了被拒绝批次")
		}
	}
	if got.Usage.Tokens < records.Items[0].EstimatedTokens+4096 {
		t.Fatal("拒绝响应未计入预算")
	}
	_, raw := readRecordLines(t, m.store, recordOwner{"session", session.ID})
	if !strings.Contains(string(raw), model.ToolNotLoadedCode) {
		t.Fatal("纠正前失败未保存到 JSONL")
	}
}

func TestToolCorrectionIsBoundedByPersistentFailuresAndRequestBudget(t *testing.T) {
	for _, limited := range []bool{false, true} {
		t.Run(fmt.Sprint(limited), func(t *testing.T) {
			var requests atomic.Int32
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				requests.Add(1)
				return model.Response{}, &model.Error{Status: 502, Code: model.ToolNotLoadedCode, Message: "本批未执行"}
			}, func(d *Deps) {
				d.Catalog = &discoveryTestCatalog{}
				if limited {
					d.AgentLimits.MaxModelRequests = 2
					d.Spawn = legacyBudgetWorker(d.AgentLimits)
				}
			})
			approveEnvironment(t, m, session)
			run := submitAgentTest(t, m, session, "bounded-correction", "读取状态")
			finished := runtimeFinished(t, m, run.ID)
			wantRequests, wantCode := int32(2), model.ToolNotLoadedCode
			if limited {
				wantRequests, wantCode = 1, "model-budget"
			}
			if requests.Load() != wantRequests || finished.EndReason != wantCode {
				t.Fatalf("纠正次数越界：%d %+v", requests.Load(), finished.Error)
			}
			calls, err := m.Calls(context.Background(), run.ID, "", 50)
			if err != nil || len(calls.Items) != 0 {
				t.Fatal("被拒绝的响应产生了调用", err)
			}
			// 新执行对象仅从持久化记录恢复纠正状态，不依赖内存计数。
			restored := &agentExecution{manager: m, run: finished}
			correct, err := restored.pendingToolCorrection(context.Background())
			if err != nil || correct != limited {
				t.Fatalf("持久化纠正配额不符：%v %v", correct, err)
			}
		})
	}
}

func TestMalformedModelResponseDoesNotTriggerCorrection(t *testing.T) {
	var requests atomic.Int32
	m, session, _ := agentManager(t, func(context.Context, model.Profile, model.Request) (model.Response, error) {
		requests.Add(1)
		return model.Response{}, &model.Error{Status: 502, Code: "model-tool-arguments-invalid", Message: "参数不完整"}
	}, func(d *Deps) { d.Catalog = &discoveryTestCatalog{} })
	approveEnvironment(t, m, session)
	run := submitAgentTest(t, m, session, "malformed-no-correction", "读取状态")
	finished := runtimeFinished(t, m, run.ID)
	if requests.Load() != 1 || finished.EndReason != "model-tool-arguments-invalid" {
		t.Fatalf("不完整响应被重试：%d %+v", requests.Load(), finished.Error)
	}
}
