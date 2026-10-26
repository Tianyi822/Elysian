package harness

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"elysian/server/internal/agent/harness/model"
	"elysian/server/internal/agent/harness/toolbridge"
	"elysian/server/internal/agent/kardia"
	"elysian/server/internal/agent/tools"
	webtool "elysian/server/internal/agent/tools/webfetch"
	"elysian/server/internal/agent/webfetch"
	cliclient "elysian/server/internal/cli/client"
)

func webFetchTestBridge(t *testing.T) (*toolbridge.Bridge, *atomic.Int32) {
	t.Helper()
	hits := &atomic.Int32{}
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		if r.URL.Path == "/failed" {
			w.WriteHeader(403)
			fmt.Fprint(w, "secret-error-body")
			return
		}
		if r.URL.Path == "/long" {
			fmt.Fprint(w, "<main>"+strings.Repeat("文", webfetch.TextBytes)+"</main>")
			return
		}
		fmt.Fprint(w, "<title>网站文档</title><main>实际网页事实</main>")
	}))
	t.Cleanup(origin.Close)
	reader := webfetch.New(webfetch.Options{LookupIP: func(context.Context, string) ([]net.IPAddr, error) {
		return []net.IPAddr{{IP: net.ParseIP("8.8.8.8")}}, nil
	}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, origin.Listener.Addr().String())
	}})
	// 生产也是大目录，回归必须经过 tool_search 才能调用新工具。
	extra := &kardia.Plugin{Name: "web-test-extra", Inject: kardia.InjectMap{tools.ServiceName: nil}, Apply: func(c *kardia.Context, _ any) (kardia.Disposable, error) {
		var descriptors []tools.Descriptor
		for i := 0; i < 18; i++ {
			descriptors = append(descriptors, tools.Descriptor{Name: fmt.Sprintf("unrelated_%02d", i), Description: "无关测试能力", Parameters: tools.Schema{Type: tools.SchemaObject}, Metadata: tools.Metadata{Exposure: "agent", ReadOnly: true}, Handler: func(*kardia.Context, tools.Arguments) (any, error) { return nil, nil }})
		}
		return nil, tools.RegisterAll(c, descriptors...)
	}}
	bridge, err := toolbridge.NewWithPlugins(nil, extra, webtool.Plugin(webtool.Deps{Fetcher: reader, Authorize: func(ctx context.Context) error { return tools.ConsumeBackend(ctx, tools.DispatchID(ctx)) }}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := bridge.Close(context.Background()); err != nil {
			t.Error(err)
		}
	})
	return bridge, hits
}

func TestWebFetchChatDiscoveryResultsAndSharedHistory(t *testing.T) {
	for _, test := range []struct {
		name, target, code string
		hits               int32
	}{
		{"success", "http://docs.example.com/guide", "", 1},
		{"truncated", "http://docs.example.com/long", "", 1},
		{"http-error", "http://docs.example.com/failed", "web-http-error", 1},
		{"private", "http://127.0.0.1/secret", "web-address-denied", 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			bridge, hits := webFetchTestBridge(t)
			var calls atomic.Int32
			var seen string
			m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
				if request.ToolChoice == "store_working_memory" {
					return memoryReply(request), nil
				}
				if missingOperationTools(request, "web_fetch") {
					return searchReply("读取网页 URL"), nil
				}
				if calls.Add(1) == 1 {
					reply := toolReply("web_fetch")
					reply.ToolCalls[0].Arguments, _ = json.Marshal(map[string]string{"url": test.target})
					return reply, nil
				}
				raw, _ := json.Marshal(request.Messages)
				seen = string(raw)
				return finalReply("依据网页访问结果回答，来源：[文档](" + test.target + ")"), nil
			}, func(d *Deps) { d.Tools, d.Catalog = bridge, &Extensions{} })
			router := httptest.NewServer(http.StripPrefix("/api/agent", m.Router()))
			defer router.Close()
			cli := cliclient.New(router.URL)
			run, err := cli.CreateTask(context.Background(), session.ID, cliclient.AgentInput{RequestID: "web-" + test.name, Content: "读取这个 URL 并总结", ExtensionMode: "enabled", AuthorizationMode: "on-demand"})
			if err != nil {
				t.Fatal(err)
			}
			finished := runtimeFinished(t, m, run.ID)
			if finished.Status != StateSucceeded || hits.Load() != test.hits {
				t.Fatalf("运行失败或请求数不符: %+v hits=%d", finished, hits.Load())
			}
			page, err := cli.ListCalls(context.Background(), run.ID, "")
			if err != nil || len(page.Items) != 2 || page.Items[0].Tool != toolSearchName || page.Items[1].Tool != "web_fetch" {
				t.Fatalf("调用历史不符: %+v %v", page, err)
			}
			stored, err := m.Calls(context.Background(), run.ID, "", 50)
			if err != nil {
				t.Fatal(err)
			}
			fetchCall := stored.Items[1]
			if test.code != "" {
				if fetchCall.Status != StateFailed || fetchCall.Error == nil || fetchCall.Error.Code != test.code || !strings.Contains(seen, test.code) {
					t.Fatalf("业务失败未继续: %+v seen=%s", fetchCall, seen)
				}
			} else {
				var result webfetch.Result
				if err := json.Unmarshal(fetchCall.Result, &result); err != nil {
					t.Fatal(err)
				}
				if fetchCall.Status != StateSucceeded || result.FinalURL != test.target || result.Truncated != (test.name == "truncated") || !strings.Contains(seen, "finalUrl") {
					t.Fatalf("网页事实未传递: %+v", fetchCall)
				}
			}
			if strings.Contains(seen, "secret-error-body") {
				t.Fatal("上游错误正文进入模型")
			}
			approvals, err := m.ApprovalsByRun(context.Background(), "", run.ID)
			if err != nil || len(approvals) != 0 {
				t.Fatalf("只读请求产生审批: %+v %v", approvals, err)
			}
			_, records := readRecordLines(t, m.store, recordOwner{"session", session.ID})
			if !strings.Contains(string(records), "web_fetch") || strings.Contains(string(records), "secret-error-body") {
				t.Fatal("JSONL 缺少调用事实或包含错误正文")
			}
			messages, err := cli.ListMessages(context.Background(), session.ID, "")
			if err != nil || len(messages.Items) < 2 {
				t.Fatalf("公开历史不可回读: %+v %v", messages, err)
			}
		})
	}
}

func TestWebFetchExistingSessionNextRunAndSnapshotIsolation(t *testing.T) {
	bridge, _ := webFetchTestBridge(t)
	var calls atomic.Int32
	m, session, _ := agentManager(t, func(_ context.Context, _ model.Profile, request model.Request) (model.Response, error) {
		if request.ToolChoice == "store_working_memory" {
			return memoryReply(request), nil
		}
		if missingOperationTools(request, "web_fetch") {
			return searchReply("web_fetch"), nil
		}
		if calls.Add(1)%2 == 1 {
			response := toolReply("web_fetch")
			response.ToolCalls[0].Arguments = json.RawMessage(`{"url":"http://docs.example.com/guide"}`)
			return response, nil
		}
		return finalReply("已读取网页"), nil
	}, func(d *Deps) { d.Tools, d.Catalog = bridge, &Extensions{} })
	ctx := context.Background()
	// 模拟已经持久保存、尚未选择新工具的旧会话环境。
	env, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	kept := []string{}
	for _, name := range env.Tools {
		if name != "web_fetch" {
			kept = append(kept, name)
		}
	}
	env.Tools = kept
	env, err = m.PutEnvironment(ctx, session.ID, 0, env)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := m.snapshot(ctx, env)
	if err != nil {
		t.Fatal(err)
	}
	digest := digestJSON(legacy)
	first := submitAgentTest(t, m, session, "old-session-new-tool", "读取网页")
	if runtimeFinished(t, m, first.ID).Status != StateSucceeded {
		t.Fatal("旧会话新建 Run 未获得工具")
	}
	second, _, err := m.ContinueTask(ctx, first.TaskID, AgentInput{RequestID: "web-continue", Content: "再读取一次"})
	if err != nil {
		t.Fatal(err)
	}
	if runtimeFinished(t, m, second.ID).Status != StateSucceeded {
		t.Fatal("续聊未获得工具")
	}
	page, err := m.Messages(ctx, session.ID, "0", 100)
	if err != nil || len(page.Items) != 4 {
		t.Fatalf("消息缺失: %+v %v", page, err)
	}
	edit, _, err := m.ContinueTask(ctx, second.TaskID, AgentInput{RequestID: "web-edit", Content: "编辑后读取", ReplaceMessageID: page.Items[2].ID})
	if err != nil {
		t.Fatal(err)
	}
	if runtimeFinished(t, m, edit.ID).Status != StateSucceeded {
		t.Fatal("编辑重发未获得工具")
	}
	saved, err := m.GetEnvironment(ctx, session.ID)
	if err != nil {
		t.Fatal(err)
	}
	if contains(saved.Tools, "web_fetch") || saved.Revision != env.Revision || digestJSON(legacy) != digest {
		t.Fatal("旧环境或固定快照被修改")
	}
	for _, run := range []Run{first, second, edit} {
		found := false
		for _, capability := range run.Snapshot.Tools {
			found = found || capability.Name == "web_fetch"
		}
		if !found {
			t.Fatal("新快照未记录工具")
		}
	}
}
