package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestPanelHTTPContract(t *testing.T) {
	sha := strings.Repeat("a", 40)
	seen := map[string]int{}
	input := PanelUpdateInput{RequestID: "request-1234", Source: "gitee", Channel: "release", TargetCommit: sha, ReleaseTag: "v1"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "http://"+r.Host || r.Header.Get("Cookie") != "elysian_session=cli-cookie" {
			t.Errorf("缺少同源或会话头：%v", r.Header)
		}
		key := r.Method + " " + r.URL.Path
		seen[key]++
		switch key {
		case "GET /api/panel/":
			json.NewEncoder(w).Encode(PanelInfo{Available: true, Commit: sha})
		case "GET /api/panel/update", "GET /api/panel/commits":
			if r.URL.Query().Get("source") != "gitee" || r.URL.Query().Get("channel") != "release" {
				t.Errorf("查询参数=%v", r.URL.Query())
			}
			if strings.HasSuffix(r.URL.Path, "commits") {
				json.NewEncoder(w).Encode([]PanelCommit{{SHA: sha, Message: "说明"}})
			} else {
				json.NewEncoder(w).Encode(PanelUpdate{Source: "gitee", Channel: "release", TargetCommit: sha, ReleaseTag: "v1", Available: true})
			}
		case "POST /api/panel/update":
			var got PanelUpdateInput
			if err := json.NewDecoder(r.Body).Decode(&got); err != nil || got != input {
				t.Errorf("请求=%+v err=%v", got, err)
			}
			w.WriteHeader(202)
			json.NewEncoder(w).Encode(PanelTask{ID: "task-1234", State: "queued"})
		case "GET /api/panel/tasks/by-request/request-1234":
			json.NewEncoder(w).Encode(PanelTask{ID: "task-1234"})
		case "GET /api/panel/tasks/by-request/not-found":
			http.Error(w, `{"error":"没有任务"}`, 404)
		case "GET /api/panel/tasks/task-1234":
			if r.URL.Query().Get("offset") != "6" {
				t.Error("未透传日志游标")
			}
			json.NewEncoder(w).Encode(PanelTaskReport{Task: PanelTask{ID: "task-1234"}, Logs: "中文", NextOffset: 12, HasMore: true})
		case "POST /api/panel/tasks/task-1234/cli-registration/retry":
			json.NewEncoder(w).Encode(PanelTask{ID: "task-1234", State: "succeeded"})
		case "GET /api/health":
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "commit": sha})
		default:
			t.Error("意外请求：", key)
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	c := New(server.URL)
	c.SetSessionCookie("cli-cookie")
	ctx := context.Background()
	if out, err := c.PanelInfo(ctx); err != nil || !out.Available {
		t.Fatalf("info=%+v err=%v", out, err)
	}
	if out, err := c.CheckPanelUpdate(ctx, "gitee", "release"); err != nil || out.TargetCommit != sha {
		t.Fatalf("check=%+v err=%v", out, err)
	}
	if out, err := c.PanelCommits(ctx, "gitee", "release"); err != nil || len(out) != 1 {
		t.Fatalf("commits=%+v err=%v", out, err)
	}
	if out, err := c.SubmitPanelUpdate(ctx, input); err != nil || out.ID != "task-1234" {
		t.Fatalf("submit=%+v err=%v", out, err)
	}
	if out, err := c.PanelTaskByRequest(ctx, "request-1234"); err != nil || out == nil || out.ID != "task-1234" {
		t.Fatalf("lookup=%+v err=%v", out, err)
	}
	if out, err := c.PanelTaskByRequest(ctx, "not-found"); err != nil || out != nil {
		t.Fatalf("404=%+v err=%v", out, err)
	}
	if out, err := c.PanelTaskReport(ctx, "task-1234", 6); err != nil || out.NextOffset != 12 || !out.HasMore {
		t.Fatalf("report=%+v err=%v", out, err)
	}
	if out, err := c.RetryPanelCLI(ctx, "task-1234"); err != nil || out.State != "succeeded" {
		t.Fatalf("retry=%+v err=%v", out, err)
	}
	if out, err := c.PanelHealth(ctx); err != nil || out != sha {
		t.Fatalf("health=%s err=%v", out, err)
	}
	if seen["POST /api/panel/update"] != 1 {
		t.Fatal("更新请求重复")
	}
}

func TestPanelHTTPAuthenticationFailure(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"error":"会话已失效"}`))
	}))
	defer s.Close()
	_, err := New(s.URL).PanelInfo(context.Background())
	e, ok := err.(*Error)
	if !ok || e.Kind != KindUnauthorized || e.Message != "会话已失效" {
		t.Fatalf("err=%v", err)
	}
}
