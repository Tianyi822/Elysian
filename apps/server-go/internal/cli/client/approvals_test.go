package client

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

// 审批／授权／等待输入／calls 契约测试：请求体与服务端 Input 精确一致
// （DisallowUnknownFields），路径与查询参数逐字对照 capability_routes.go 与
// agent_routes.go。

func TestListApprovalsByRun(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/approvals": respondJSON(200, `[{"id":"ap-1","runId":"r-1","operationId":"op-1","status":"pending","createdAt":"2026-10-25T09:00:00.000Z","expiresAt":"2026-10-26T09:00:00.000Z","kind":"operation","access":{"revision":3,"digest":"d","kind":"script","sessionAllowed":false,"directories":[{"path":"/srv","access":"rw"}]},"operation":{"id":"op-1","status":"waiting-approval","argumentsJson":"{\"a\":1}","capability":{"name":"file_write","source":"builtin","readOnly":false},"workspaceRevision":2}}]`),
	})
	defer rec.Close()
	c := New(rec.URL())
	items, err := c.ListApprovalsByRun(context.Background(), "r-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].ID != "ap-1" || items[0].Access == nil || items[0].Access.Revision != 3 {
		t.Fatalf("审批解析不符：%+v", items)
	}
	if items[0].Operation.Capability.Name != "file_write" || items[0].Operation.WorkspaceRevision != 2 {
		t.Fatalf("操作事实解析不符：%+v", items[0].Operation)
	}
	if got := rec.last().Query; got != "runId=r-1" {
		t.Fatalf("应按 runId 过滤：%q", got)
	}
}

func TestDecideApprovalBodyExact(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/approvals/ap-1/decision": func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			if string(raw) != `{"decision":"approved"}` {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"error":"请求字段无效或含未声明的字段","code":"invalid-request"}`)
				return
			}
			_, _ = io.WriteString(w, `{"id":"ap-1","runId":"r-1","operationId":"op-1","status":"approved","decision":"approved","operation":{"id":"op-1","status":"dispatched","argumentsJson":"{}","capability":{"name":"x","source":"builtin"},"workspaceRevision":1}}`)
		},
	})
	defer rec.Close()
	c := New(rec.URL())
	approval, err := c.DecideApproval(context.Background(), "ap-1", "approved")
	if err != nil || approval.Status != "approved" {
		t.Fatalf("批准回执不符：%+v %v", approval, err)
	}
}

func TestDecideAccessBodyExact(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/approvals/ap-1/access-decision": func(w http.ResponseWriter, r *http.Request) {
			raw, _ := io.ReadAll(r.Body)
			want := `{"requestId":"req-1","expectedRevision":3,"expectedDigest":"d-abc","decision":"session"}`
			if string(raw) != want {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"error":"请求字段无效或含未声明的字段","code":"invalid-request"}`)
				return
			}
			_, _ = io.WriteString(w, `{"id":"ap-1","runId":"r-1","status":"approved","accessDecision":{"requestId":"req-1","expectedRevision":3,"expectedDigest":"d-abc","decision":"session"},"operation":{"id":"op-1","status":"preparing","argumentsJson":"{}","capability":{"name":"bash","source":"builtin"},"workspaceRevision":1}}`)
		},
	})
	defer rec.Close()
	c := New(rec.URL())
	approval, err := c.DecideAccess(context.Background(), "ap-1", AccessDecisionInput{
		RequestID: "req-1", ExpectedRevision: 3, ExpectedDigest: "d-abc", Decision: "session",
	})
	if err != nil || approval.Status != "approved" {
		t.Fatalf("授权决定回执不符：%+v %v", approval, err)
	}
}

func TestSessionAuthorizationsListAndRevoke(t *testing.T) {
	authsHandler := func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, `{"items":[{"id":"auth-1","sessionId":"s1","revision":5,"status":"allowed","tool":"bash","createdAt":"2026-10-25T09:00:00.000Z","access":{"revision":2,"digest":"d","kind":"script","sessionAllowed":true,"directories":[]}}]}`)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		if r.Method != http.MethodDelete || string(raw) != `{"requestId":"req-9","expectedRevision":5}` {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(200)
		_, _ = io.WriteString(w, `{"id":"auth-1","sessionId":"s1","revision":6,"status":"revoked","tool":"bash","createdAt":"2026-10-25T09:00:00.000Z","revokedAt":"2026-10-25T10:00:00.000Z","access":{"revision":2,"digest":"d","kind":"script","sessionAllowed":true,"directories":[]}}`)
	}
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions/s1/authorizations":        authsHandler,
		"/api/agent/sessions/s1/authorizations/auth-1": authsHandler,
	})
	defer rec.Close()
	c := New(rec.URL())
	items, err := c.ListSessionAuthorizations(context.Background(), "s1")
	if err != nil || len(items) != 1 || items[0].Revision != 5 {
		t.Fatalf("授权列表解析不符：%+v %v", items, err)
	}
	if err := c.RevokeSessionAuthorization(context.Background(), "s1", "auth-1", RevokeAuthorizationInput{RequestID: "req-9", ExpectedRevision: 5}); err != nil {
		t.Fatalf("撤回应成功：%v", err)
	}
}

func TestAnswerUserInputPathAndBody(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/runs/r-1/user-inputs/ui-1/answer": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			raw, _ := io.ReadAll(r.Body)
			if !strings.Contains(string(raw), `"requestId":"req-1"`) ||
				!strings.Contains(string(raw), `"q1":{"optionId":"opt-a"}`) ||
				!strings.Contains(string(raw), `"q2":{"text":"自定义"}`) {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"error":"请求字段无效或含未声明的字段","code":"invalid-request"}`)
				return
			}
			_, _ = io.WriteString(w, `{"userInput":{"id":"ui-1","runId":"r-1","status":"answered","questions":[]},"run":{"id":"r-1","status":"queued"}}`)
		},
	})
	defer rec.Close()
	c := New(rec.URL())
	receipt, err := c.AnswerUserInput(context.Background(), "r-1", "ui-1", AnswerUserInputInput{
		RequestID: "req-1",
		Answers:   map[string]UserInputAnswer{"q1": {OptionID: "opt-a"}, "q2": {Text: "自定义"}},
	})
	if err != nil || receipt.Run.Status != "queued" {
		t.Fatalf("回答回执不符：%+v %v", receipt, err)
	}
}

func TestListCallsPagination(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/runs/r-1/calls": respondJSON(200, `{"items":[{"id":"c-1","runId":"r-1","tool":"docker_ps","status":"succeeded","startedAt":"2026-10-25T09:00:00.000Z","result":{"containers":3},"truncated":false}],"nextCursor":"9","hasMore":false}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	page, err := c.ListCalls(context.Background(), "r-1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Tool != "docker_ps" || string(page.Items[0].Result) != `{"containers":3}` {
		t.Fatalf("calls 解析不符：%+v", page.Items)
	}
}

func TestTimelineParsesPlanAndUserInput(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/runs/r-1/timeline": respondJSON(200, `{"runId":"r-1","status":"waiting-input","done":false,"plan":{"revision":2,"updatedAt":"2026-10-25T09:00:00.000Z","steps":[{"id":"s1","title":"检查","status":"completed"},{"id":"s2","title":"清理","status":"in_progress"}]},"entries":[{"id":"q","kind":"user-input","status":"waiting","userInput":{"id":"ui-1","runId":"r-1","status":"waiting","questions":[{"id":"q1","header":"处置","question":"怎么处理？","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"recommendedOptionId":"a"}]}}]}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	timeline, err := c.TimelineSnapshot(context.Background(), "r-1")
	if err != nil {
		t.Fatal(err)
	}
	if timeline.Plan == nil || len(timeline.Plan.Steps) != 2 || timeline.Plan.Steps[1].Status != "in_progress" {
		t.Fatalf("计划解析不符：%+v", timeline.Plan)
	}
	if len(timeline.Entries) != 1 || timeline.Entries[0].UserInput == nil || len(timeline.Entries[0].UserInput.Questions) != 1 {
		t.Fatalf("等待输入条目解析不符：%+v", timeline.Entries)
	}
	if timeline.Entries[0].UserInput.Questions[0].RecommendedOptionID != "a" {
		t.Fatalf("推荐项应解析：%+v", timeline.Entries[0].UserInput.Questions[0])
	}
}
