package client

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
	"time"
)

// 聊天链路与输出流契约测试：提交体字段精确（AgentInput DisallowUnknownFields）、
// requestId 模式、消息升序分页、SSE 帧解析（多行 data／注释／ping／done）与
// 断连重连语义（连接结束回 nil 由上层重连）。

func TestNewRequestIDPattern(t *testing.T) {
	pattern := regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	seen := map[string]bool{}
	for i := 0; i < 32; i++ {
		id := NewRequestID()
		if !pattern.MatchString(id) {
			t.Fatalf("requestId 应符合服务端模式：%q", id)
		}
		if seen[id] {
			t.Fatalf("requestId 应唯一：%q", id)
		}
		seen[id] = true
	}
}

func TestValidateUserContent(t *testing.T) {
	if err := ValidateUserContent("你好"); err != nil {
		t.Fatalf("正常输入应通过：%v", err)
	}
	if err := ValidateUserContent(""); err == nil {
		t.Fatal("空输入应拒绝")
	}
	if err := ValidateUserContent(strings.Repeat("字", 32769/3+1)); err == nil {
		t.Fatal("超 32768 字节应拒绝")
	}
	if err := ValidateUserContent("   "); err != nil {
		// 纯空白交由提交层 TrimSpace 拦截；client 校验只管字节与空串。
		t.Fatalf("纯空白不在 client 预检范围：%v", err)
	}
}

// TestCreateTaskBodyExactAndAccept 创建任务请求体精确且 202 响应解析 Run。
func TestCreateTaskBodyExactAndAccept(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions/s1/tasks": func(w http.ResponseWriter, r *http.Request) {
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			// 服务端 DisallowUnknownFields：字段集必须精确。
			if body["requestId"] != "req-1" || body["content"] != "看看内存" ||
				body["reasoningLevel"] != "high" || body["extensionMode"] != "enabled" {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"error":"请求字段无效或含未声明的字段","code":"invalid-request"}`)
				return
			}
			if _, extra := body["permissionMode"]; extra {
				w.WriteHeader(400)
				_, _ = io.WriteString(w, `{"error":"请求字段无效或含未声明的字段","code":"invalid-request"}`)
				return
			}
			w.Header().Set("X-Agent-Run-Number", "3")
			w.WriteHeader(202)
			_, _ = io.WriteString(w, `{"id":"r-9","sessionId":"s1","taskId":"t-1","status":"queued","createdAt":"2026-10-25T09:00:00.000Z"}`)
		},
	})
	defer rec.Close()
	c := New(rec.URL())
	run, err := c.CreateTask(context.Background(), "s1", AgentInput{
		RequestID: "req-1", Content: "看看内存", ReasoningLevel: "high", ExtensionMode: "enabled",
	})
	if err != nil {
		t.Fatalf("提交应被接受：%v", err)
	}
	if run.ID != "r-9" || run.Status != "queued" || run.TaskID != "t-1" {
		t.Fatalf("Run 解析不符：%+v", run)
	}
}

// TestCreateTaskSessionBusySurfacesConflict 409 session-busy 原文上抛。
func TestCreateTaskSessionBusySurfacesConflict(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions/s1/tasks": respondJSON(409, `{"error":"会话已有运行中的任务","code":"session-busy"}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	_, err := c.CreateTask(context.Background(), "s1", AgentInput{RequestID: "req-1", Content: "x"})
	e, ok := err.(*Error)
	if !ok || e.Status != 409 || e.Code != "session-busy" {
		t.Fatalf("409 应带服务端原因：%v", err)
	}
}

// TestContinueTaskPostsToTaskRuns 续轮打到 tasks/{id}/runs。
func TestContinueTaskPostsToTaskRuns(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/tasks/t-1/runs": respondJSON(202, `{"id":"r-10","taskId":"t-1","status":"queued","createdAt":"2026-10-25T09:01:00.000Z"}`),
	})
	defer rec.Close()
	c := New(rec.URL())
	run, err := c.ContinueTask(context.Background(), "t-1", AgentInput{RequestID: "req-2", Content: "继续"})
	if err != nil || run.ID != "r-10" {
		t.Fatalf("续轮应成功：%v %+v", err, run)
	}
	if got := rec.last(); got.Method != "POST" || got.Path != "/api/agent/tasks/t-1/runs" {
		t.Fatalf("续轮请求路径不符：%+v", got)
	}
}

// TestCancelRunAcceptedAndTerminal 取消：活动 202／终态 200 都解析 Run。
func TestCancelRunAcceptedAndTerminal(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
	}{
		{202, `{"id":"r-1","status":"running","cancelRequestedAt":"2026-10-25T09:00:00.000Z"}`},
		{200, `{"id":"r-1","status":"cancelled","endReason":"cancelled","endedAt":"2026-10-25T09:00:05.000Z"}`},
	} {
		rec := newRecordingServer(map[string]http.HandlerFunc{
			"/api/agent/runs/r-1/cancel": respondJSON(tc.status, tc.body),
		})
		c := New(rec.URL())
		run, err := c.CancelRun(context.Background(), "r-1")
		rec.Close()
		if err != nil {
			t.Fatalf("HTTP %d 取消应成功：%v", tc.status, err)
		}
		if run.ID != "r-1" {
			t.Fatalf("取消回执解析不符：%+v", run)
		}
	}
}

// TestListMessagesAscendingPagination 消息升序分页：after 游标透传、seq 递增、
// hasMore 续拉到头。
func TestListMessagesAscendingPagination(t *testing.T) {
	rec := newRecordingServer(map[string]http.HandlerFunc{
		"/api/agent/sessions/s1/messages": func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Query().Get("after") {
			case "":
				_, _ = io.WriteString(w, `{"items":[{"id":"m1","sessionId":"s1","taskId":"t1","runId":"r1","seq":"3","role":"user","content":"问","createdAt":"2026-10-25T08:00:00.000Z"},{"id":"m2","sessionId":"s1","taskId":"t1","runId":"r1","seq":"4","role":"assistant","content":"答","createdAt":"2026-10-25T08:00:05.000Z","runStatus":"succeeded","runConfig":{"modelName":"glm","modelProfileId":"p1","modelRevision":1,"reasoningLevel":"high"}}],"nextCursor":"4","hasMore":true}`)
			case "4":
				_, _ = io.WriteString(w, `{"items":[{"id":"m3","sessionId":"s1","taskId":"t1","runId":"r2","seq":"7","role":"user","content":"再问","createdAt":"2026-10-25T08:10:00.000Z"}],"nextCursor":"7","hasMore":false}`)
			default:
				w.WriteHeader(400)
			}
		},
	})
	defer rec.Close()
	c := New(rec.URL())
	page, err := c.ListMessages(context.Background(), "s1", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 2 || !page.HasMore || page.NextCursor != "4" {
		t.Fatalf("首页解析不符：%+v", page)
	}
	if cfg := page.Items[1].RunConfig; cfg == nil || cfg.ModelName != "glm" || cfg.ReasoningLevel != "high" {
		t.Fatalf("runConfig 应随消息回填：%+v", page.Items[1].RunConfig)
	}
	page, err = c.ListMessages(context.Background(), "s1", "4")
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Seq != "7" || page.HasMore {
		t.Fatalf("续页解析不符：%+v", page)
	}
}

// TestSSEFrameParser 帧解析矩阵：事件+单行 data、多行 data 换行合并、注释帧、
// CRLF 行尾、无事件名的帧不产出、分块到达。
func TestSSEFrameParser(t *testing.T) {
	p := &sseFrameParser{}
	frames := p.push([]byte("event: output\ndata: {\"a\":1}\n\n"))
	if len(frames) != 1 || frames[0].event != "output" || string(frames[0].data) != `{"a":1}` {
		t.Fatalf("基础帧解析不符：%+v", frames)
	}
	frames = p.push([]byte("event: output\r\ndata: line1\r\ndata: line2\r\n\r\n"))
	if len(frames) != 1 || string(frames[0].data) != "line1\nline2" {
		t.Fatalf("多行 data 与 CRLF 解析不符：%+v", frames)
	}
	frames = p.push([]byte(": keep-alive\n\n"))
	if len(frames) != 0 {
		t.Fatalf("注释帧不应产出：%+v", frames)
	}
	// 分块到达：event 行与 data 行分两次喂入。
	frames = p.push([]byte("event: output\n"))
	if len(frames) != 0 {
		t.Fatalf("未完整的帧不应产出：%+v", frames)
	}
	frames = p.push([]byte("data: {}\n\n"))
	if len(frames) != 1 || frames[0].event != "output" {
		t.Fatalf("跨块帧应合并产出：%+v", frames)
	}
}

// TestStreamChatOutputFrames SSE 集成：output 帧回调、ping 忽略、done 收敛回 nil。
func TestStreamChatOutputFrames(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent/runs/r-1/output" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "event: output\ndata: {\"runId\":\"r-1\",\"reasoning\":\"想\",\"content\":\"答一半\",\"done\":false}\n\n")
		flusher.Flush()
		_, _ = io.WriteString(w, "event: ping\ndata: {}\n\n")
		flusher.Flush()
		_, _ = io.WriteString(w, "event: output\ndata: {\"runId\":\"r-1\",\"reasoning\":\"想\",\"content\":\"答完\",\"done\":true,\"timeline\":{\"runId\":\"r-1\",\"status\":\"succeeded\",\"done\":true,\"entries\":[]}}\n\n")
		flusher.Flush()
	}))
	defer server.Close()
	c := New(server.URL)
	var got []ChatOutput
	err := c.StreamChatOutput(context.Background(), "r-1", func(output ChatOutput) error {
		got = append(got, output)
		return nil
	})
	if err != nil {
		t.Fatalf("done 收敛应回 nil：%v", err)
	}
	if len(got) != 2 || got[0].Content != "答一半" || !got[1].Done {
		t.Fatalf("帧回调不符：%+v", got)
	}
	if got[1].Timeline == nil || got[1].Timeline.Status != "succeeded" {
		t.Fatalf("timeline 应随帧解析：%+v", got[1].Timeline)
	}
}

// TestStreamChatOutputServerDisconnect 服务端断开（30 秒短连接语义）：回 nil 交
// 上层重连，不视为错误。
func TestStreamChatOutputServerDisconnect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "event: output\ndata: {\"runId\":\"r-1\",\"content\":\"x\",\"done\":false}\n\n")
		flusher.Flush()
		// 直接返回：连接结束。
	}))
	defer server.Close()
	c := New(server.URL)
	called := false
	err := c.StreamChatOutput(context.Background(), "r-1", func(ChatOutput) error { called = true; return nil })
	if err != nil || !called {
		t.Fatalf("服务端断开应回 nil 且已收帧：%v %v", err, called)
	}
}

// TestStreamChatOutputUnauthorized 流端点 401：KindUnauthorized 上抛（上层收敛登录）。
func TestStreamChatOutputUnauthorized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		respondJSON(401, `{"error":"未登录"}`)(w, r)
	}))
	defer server.Close()
	c := New(server.URL)
	err := c.StreamChatOutput(context.Background(), "r-1", func(ChatOutput) error { return nil })
	e, ok := err.(*Error)
	if !ok || e.Kind != KindUnauthorized {
		t.Fatalf("401 应上抛无权限态：%v", err)
	}
}

// TestStreamChatOutputStopsOnCallbackError 回调退订：返回错误即中断读取。
func TestStreamChatOutputStopsOnCallbackError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "event: output\ndata: {\"runId\":\"r-1\",\"content\":\"a\",\"done\":false}\n\n")
		flusher.Flush()
		_, _ = io.WriteString(w, "event: output\ndata: {\"runId\":\"r-1\",\"content\":\"b\",\"done\":false}\n\n")
		flusher.Flush()
		time.Sleep(2 * time.Second)
	}))
	defer server.Close()
	c := New(server.URL)
	count := 0
	err := c.StreamChatOutput(context.Background(), "r-1", func(output ChatOutput) error {
		count++
		if count == 1 {
			return io.EOF // 退订哨兵。
		}
		return nil
	})
	if err != io.EOF || count != 1 {
		t.Fatalf("回调退订应立即中断：%v %d", err, count)
	}
}

// —— 权限模式与上下文用量契约（能力补齐：随轮提交与状态栏文本）——

func TestPermissionModeHelpers(t *testing.T) {
	if NextPermissionMode(PermissionAsk) != PermissionAssist ||
		NextPermissionMode(PermissionAssist) != PermissionFull ||
		NextPermissionMode(PermissionFull) != PermissionAsk {
		t.Fatalf("权限模式应按 ask→assist→full→ask 循环")
	}
	if NextPermissionMode("bogus") != PermissionAsk {
		t.Fatalf("未知值应回到 ask：%q", NextPermissionMode("bogus"))
	}
	if PermissionModeLabel(PermissionAsk) != "请求批准" ||
		PermissionModeLabel(PermissionAssist) != "帮我批准" ||
		PermissionModeLabel(PermissionFull) != "完全开放" {
		t.Fatalf("中文标签应与 Web PERMISSION_MODES 同表")
	}
	if PermissionModeLabel("bogus") != "bogus" {
		t.Fatalf("未知值应回原文：%q", PermissionModeLabel("bogus"))
	}
}

// TestAgentInputMarshalsPermissionMode 权限模式随轮提交：选择值按服务端字段名
// 序列化，未选择时缺省不携带（服务端按 ask 处理）。
func TestAgentInputMarshalsPermissionMode(t *testing.T) {
	data, err := json.Marshal(AgentInput{RequestID: "req-1", Content: "问", PermissionMode: PermissionFull})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"permissionMode":"full"`) {
		t.Fatalf("选择 assist/full 时应携带 permissionMode：%s", data)
	}
	data, err = json.Marshal(AgentInput{RequestID: "req-1", Content: "问"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "permissionMode") {
		t.Fatalf("未选择时不应携带 permissionMode（服务端缺省 ask）：%s", data)
	}
}

// TestAgentInputMarshalsAuthorizationMode 运行时授权开关随轮提交（与 Web 同口径
// on-demand）：按服务端字段名序列化，未设置时缺省不携带（服务端按不申请处理，
// 参与 requestId 幂等校验的字段集必须精确）。
func TestAgentInputMarshalsAuthorizationMode(t *testing.T) {
	data, err := json.Marshal(AgentInput{RequestID: "req-1", Content: "问", AuthorizationMode: AuthorizationOnDemand})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"authorizationMode":"on-demand"`) {
		t.Fatalf("on-demand 应按服务端字段名携带 authorizationMode：%s", data)
	}
	if AuthorizationOnDemand != "on-demand" {
		t.Fatalf("取值应与服务端 harness.AuthorizationOnDemand 同值：%q", AuthorizationOnDemand)
	}
	data, err = json.Marshal(AgentInput{RequestID: "req-1", Content: "问"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "authorizationMode") {
		t.Fatalf("未设置时不应携带 authorizationMode（服务端缺省不申请）：%s", data)
	}
}

// TestTimelineSnapshotParsesContextUsage timeline.contextUsage 契约：已报告与
// 未报告（totalTokens 缺失不补零）两种形状；容量与模型请求 ID 一并钉死。
func TestTimelineSnapshotParsesContextUsage(t *testing.T) {
	for _, tc := range []struct {
		name        string
		body        string
		wantTotal   *int
		wantRequest string
	}{
		{
			name:        "已报告",
			body:        `{"runId":"r-1","status":"running","done":false,"contextUsage":{"modelRequestId":"mr-3","model":"glm","totalTokens":12500,"contextTokens":65536},"entries":[]}`,
			wantTotal:   intPtr(12500),
			wantRequest: "mr-3",
		},
		{
			name:        "未报告不补零",
			body:        `{"runId":"r-1","status":"running","done":false,"contextUsage":{"modelRequestId":"mr-1","model":"glm","contextTokens":65536},"entries":[]}`,
			wantTotal:   nil,
			wantRequest: "mr-1",
		},
	} {
		rec := newRecordingServer(map[string]http.HandlerFunc{
			"/api/agent/runs/r-1/timeline": respondJSON(200, tc.body),
		})
		c := New(rec.URL())
		timeline, err := c.TimelineSnapshot(context.Background(), "r-1")
		rec.Close()
		if err != nil {
			t.Fatalf("%s：timeline 读取失败：%v", tc.name, err)
		}
		usage := timeline.ContextUsage
		if usage == nil || usage.Model != "glm" || usage.ContextTokens != 65536 || usage.ModelRequestID != tc.wantRequest {
			t.Fatalf("%s：contextUsage 解析不符：%+v", tc.name, usage)
		}
		if tc.wantTotal == nil {
			if usage.TotalTokens != nil {
				t.Fatalf("%s：未报告 totalTokens 应保持 nil 不补零：%+v", tc.name, usage.TotalTokens)
			}
		} else if usage.TotalTokens == nil || *usage.TotalTokens != *tc.wantTotal {
			t.Fatalf("%s：totalTokens 解析不符：%+v", tc.name, usage.TotalTokens)
		}
	}
}

// TestStreamFrameCarriesContextUsage SSE 帧内嵌 timeline 的 contextUsage 同形解析。
func TestStreamFrameCarriesContextUsage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "event: output\ndata: {\"runId\":\"r-1\",\"content\":\"答\",\"done\":true,\"timeline\":{\"runId\":\"r-1\",\"status\":\"succeeded\",\"done\":true,\"contextUsage\":{\"modelRequestId\":\"mr-9\",\"model\":\"glm\",\"totalTokens\":2000,\"contextTokens\":65536},\"entries\":[]}}\n\n")
		flusher.Flush()
	}))
	defer server.Close()
	c := New(server.URL)
	var usage *ChatContextUsage
	err := c.StreamChatOutput(context.Background(), "r-1", func(output ChatOutput) error {
		if output.Timeline != nil {
			usage = output.Timeline.ContextUsage
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if usage == nil || usage.TotalTokens == nil || *usage.TotalTokens != 2000 || usage.ContextTokens != 65536 {
		t.Fatalf("流帧应携带 contextUsage：%+v", usage)
	}
}

func intPtr(n int) *int { return &n }
