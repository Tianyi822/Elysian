package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// 会话／模型／运行 API 契约测试：请求体字段与服务端 Input 精确一致
// （DisallowUnknownFields，多一个未知字段即 400），响应按公开形状解析；模型过滤
// 与思考档推导与 Web 侧口径逐条对齐。

// TestCreateSessionBodyExactAndResponseParsed 创建会话请求体精确（title/
// modelProfileId/modelRevision 三字段）且 201 响应解析为 Session。
func TestCreateSessionBodyExactAndResponseParsed(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			// 服务端 DisallowUnknownFields：多一个未知字段即 400，桩同口径。
			if len(body) != 3 || body["title"] != "巡检" || body["modelProfileId"] != "p1" || body["modelRevision"] != float64(3) {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"error":"请求字段无效或含未声明的字段","code":"invalid-request"}`)
				return
			}
			w.WriteHeader(201)
			_, _ = io.WriteString(w, `{"id":"s-1","title":"巡检","createdAt":"2026-10-25T08:00:00.000Z","lastActivityAt":"2026-10-25T08:00:00.000Z","modelProfileId":"p1","modelRevision":3,"lastSeq":"0"}`)
		},
	})
	defer rec.Close()
	c := New(rec.URL())
	session, err := c.CreateSession(context.Background(), CreateSessionInput{Title: "巡检", ModelProfileID: "p1", ModelRevision: 3})
	if err != nil {
		t.Fatalf("创建会话应成功：%v", err)
	}
	if session.ID != "s-1" || session.ModelRevision != 3 || session.Title != "巡检" {
		t.Fatalf("会话解析不符：%+v", session)
	}
}

// TestListSessionsPagination 分页：首页与游标页的查询串透传、Page 形状解析。
func TestListSessionsPagination(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions": respondJSON(200, `{"items":[{"id":"s-2","title":"第二","createdAt":"2026-10-25T07:00:00.000Z","lastActivityAt":"2026-10-25T07:30:00.000Z","modelProfileId":"p1","modelRevision":1,"activeRunId":"r-9","lastSeq":"12"}],"nextCursor":"opaque-cursor","hasMore":true}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	page, err := c.ListSessionsByActivity(context.Background(), "")
	if err != nil {
		t.Fatalf("首页应成功：%v", err)
	}
	if !page.HasMore || page.NextCursor != "opaque-cursor" || len(page.Items) != 1 {
		t.Fatalf("分页解析不符：%+v", page)
	}
	if page.Items[0].ActiveRunID != "r-9" {
		t.Fatalf("活动运行标记应解析：%+v", page.Items[0])
	}
	page, err = c.ListSessionsByActivity(context.Background(), "opaque-cursor")
	if err != nil {
		t.Fatalf("游标页应成功：%v", err)
	}
	if got := rec.last().Query; !strings.Contains(got, "cursor=opaque-cursor") {
		t.Fatalf("游标应透传：%q", got)
	}
}

// TestDeleteSessionSurfacesConflict 删除 409：服务端中文原因原样上抛（调用方据此
// 不做本地清理）。
func TestDeleteSessionSurfacesConflict(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions/s-1": respondJSON(409, `{"error":"会话存在结果未确认的执行，不能删除","code":"session-busy"}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	err := c.DeleteSession(context.Background(), "s-1")
	e, ok := err.(*Error)
	if !ok || e.Status != 409 || e.Message != "会话存在结果未确认的执行，不能删除" {
		t.Fatalf("409 应带服务端原因：%v", err)
	}
}

// TestSwitchModelBody 切换模型请求体两字段精确。
func TestSwitchModelBody(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions/s-1/model": func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPut {
				http.Error(w, "method", http.StatusMethodNotAllowed)
				return
			}
			raw, _ := io.ReadAll(r.Body)
			if string(raw) != `{"modelProfileId":"p2","modelRevision":5}` {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"error":"请求字段无效或含未声明的字段","code":"invalid-request"}`)
				return
			}
			_, _ = io.WriteString(w, `{"id":"s-1","title":"t","createdAt":"2026-10-25T08:00:00.000Z","lastActivityAt":"2026-10-25T08:00:00.000Z","modelProfileId":"p2","modelRevision":5,"lastSeq":"0","modelChange":{"after":{"id":"p2","revision":5},"differences":["上下文 token 容量"],"notices":["模型能力可能变化，请核对文本、工具调用和上下文容量"]}}`)
		},
	})
	defer rec.Close()
	c := New(rec.URL())
	session, err := c.SwitchSessionModel(context.Background(), "s-1", SwitchModelInput{ModelProfileID: "p2", ModelRevision: 5})
	if err != nil {
		t.Fatalf("切换模型应成功：%v", err)
	}
	if session.ModelProfileID != "p2" {
		t.Fatalf("响应解析不符：%+v", session)
	}
}

// TestValidateTitleSameAsServer 标题预检与服务端同口径：TrimSpace 非空、≤200 字节。
func TestValidateTitleSameAsServer(t *testing.T) {
	if err := ValidateTitle("正常标题"); err != nil {
		t.Fatalf("正常标题应通过：%v", err)
	}
	if err := ValidateTitle("   "); err == nil {
		t.Fatal("空白标题应拒绝")
	}
	if err := ValidateTitle(strings.Repeat("字", 101)); err == nil {
		t.Fatal("超 200 字节标题应拒绝（中文每字 3 字节）")
	}
	if err := ValidateTitle(strings.Repeat("a", 200)); err != nil {
		t.Fatalf("恰 200 字节应通过：%v", err)
	}
}

// TestChatModelsFilter 模型过滤：active＋text＋tools 三条件（与 sessions.go:118-120
// 同口径）。
func TestChatModelsFilter(t *testing.T) {
	profiles := []ModelProfile{
		{ID: "ok", Active: true, Capabilities: ModelCapabilities{Text: true, Tools: true}},
		{ID: "no-text", Active: true, Capabilities: ModelCapabilities{Text: false, Tools: true}},
		{ID: "no-tools", Active: true, Capabilities: ModelCapabilities{Text: true, Tools: false}},
		{ID: "inactive", Active: false, Capabilities: ModelCapabilities{Text: true, Tools: true}},
	}
	usable := ChatModels(profiles)
	if len(usable) != 1 || usable[0].ID != "ok" {
		t.Fatalf("应只剩可用模型：%+v", usable)
	}
}

// TestDefaultReasoningLevelMatrix 默认思考档矩阵：声明档（须在表内）→ high →
// medium → 首项；空表不补档。
func TestDefaultReasoningLevelMatrix(t *testing.T) {
	cases := []struct {
		levels   []string
		declared string
		want     string
	}{
		{[]string{"low", "high", "max"}, "max", "max"},
		{[]string{"low", "high", "max"}, "other", "high"},
		{[]string{"low", "medium"}, "", "medium"},
		{[]string{"minimal"}, "", "minimal"},
		{nil, "high", ""},
		{[]string{"high"}, "medium", "high"},
	}
	for _, tc := range cases {
		if got := DefaultReasoningLevel(tc.levels, tc.declared); got != tc.want {
			t.Fatalf("levels=%v declared=%q 应得 %q，得到 %q", tc.levels, tc.declared, tc.want, got)
		}
	}
}

// TestReasoningLabel 思考档中文标签与未知回落。
func TestReasoningLabel(t *testing.T) {
	if ReasoningLabel("high") != "高" || ReasoningLabel("max") != "最高" {
		t.Fatal("已知档位应有中文标签")
	}
	if ReasoningLabel("custom") != "custom" {
		t.Fatal("未知档位应回原文")
	}
}

// TestSessionJSONShapeGolden Session 公开形状 golden 钉死（防与后端契约漂移）：
// 字段名与 omitempty 行为逐字节对照。
func TestSessionJSONShapeGolden(t *testing.T) {
	session := Session{ID: "s1", Title: "t", CreatedAt: "a", LastActivityAt: "b", ModelProfileID: "p", ModelRevision: 2, LastSeq: "0"}
	raw, err := json.Marshal(session)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"s1","title":"t","createdAt":"a","lastActivityAt":"b","modelProfileId":"p","modelRevision":2,"lastSeq":"0"}`
	if string(raw) != want {
		t.Fatalf("Session JSON 形状漂移：\n得到 %s\n期望 %s", raw, want)
	}
	session.ActiveRunID = "r1"
	raw, _ = json.Marshal(session)
	if !strings.Contains(string(raw), `"activeRunId":"r1"`) {
		t.Fatalf("activeRunId 应在存在时输出：%s", raw)
	}
}

// TestModelProfileJSONShapeGolden 模型配置公开形状 golden：capabilities 档位表与
// 服务引用子形状。
func TestModelProfileJSONShapeGolden(t *testing.T) {
	profile := ModelProfile{ID: "p1", Revision: 1, Model: "glm-4.7", Capabilities: ModelCapabilities{Text: true, Tools: true, ReasoningLevels: []string{"high", "max"}, DefaultReasoningLevel: "max"}, ContextTokens: 128000, OutputTokens: 8192}
	raw, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"p1","revision":1,"provider":"","apiFormat":"","baseUrl":"","model":"glm-4.7","contextTokens":128000,"outputTokens":8192,"capabilities":{"text":true,"tools":true,"reasoningLevels":["high","max"],"defaultReasoningLevel":"max"},"active":false,"hasCredential":false}`
	if string(raw) != want {
		t.Fatalf("ModelProfile JSON 形状漂移：\n得到 %s\n期望 %s", raw, want)
	}
}
