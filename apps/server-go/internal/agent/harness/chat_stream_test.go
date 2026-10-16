package harness

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"elysian/server/internal/agent/harness/model"
)

func TestChatOutputStreamBeforePublicMessageAndReconnect(t *testing.T) {
	emitted, resume := make(chan struct{}), make(chan struct{})
	var once sync.Once
	release := func() { once.Do(func() { close(resume) }) }
	defer release()
	m, session, _ := agentManager(t, func(ctx context.Context, _ model.Profile, r model.Request) (model.Response, error) {
		prompt, completion, total, cached := 15, 5, 20, 5
		usage := model.Usage{PromptTokens: &prompt, CompletionTokens: &completion, TotalTokens: &total, CachedTokens: &cached}
		if r.ToolChoice == "store_working_memory" {
			response := memoryReply(r)
			response.Usage = usage
			return response, nil
		}
		r.OnReasoning("思考第一行")
		r.OnContent("回答第一段")
		close(emitted)
		select {
		case <-resume:
			response := finalReply("完整回答")
			response.Usage = usage
			return response, nil
		case <-ctx.Done():
			return model.Response{}, ctx.Err()
		}
	}, nil)
	run := submitAgentTest(t, m, session, "stream-output", "测试")
	select {
	case <-emitted:
	case <-time.After(5 * time.Second):
		t.Fatal("没有增量")
	}
	server := httptest.NewServer(m.Router())
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	read := func() ChatOutput {
		t.Helper()
		response, err := client.Get(server.URL + "/runs/" + run.ID + "/output")
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
			t.Fatal(response.Status)
		}
		scanner := bufio.NewScanner(response.Body)
		for scanner.Scan() {
			if strings.HasPrefix(scanner.Text(), "data: ") {
				var output ChatOutput
				if err := json.Unmarshal([]byte(strings.TrimPrefix(scanner.Text(), "data: ")), &output); err != nil {
					t.Fatal(err)
				}
				return output
			}
		}
		t.Fatal("未收到流式快照", scanner.Err())
		return ChatOutput{}
	}
	output := read()
	if output.Done || output.Content != "回答第一段" || output.Reasoning != "思考第一行" {
		t.Fatalf("错误快照：%+v", output)
	}
	if output.Timeline == nil || output.Timeline.Usage.ModelRequests != 1 || output.Timeline.Usage.EstimatedTokens == 0 || output.Timeline.Usage.ActualTokens != nil || output.Timeline.Usage.CachedTokens != nil {
		t.Fatalf("运行中用量快照错误：%+v", output.Timeline)
	}
	if output.Timeline.ContextUsage != nil {
		t.Fatalf("未确认推理不应产生上下文用量：%+v", output.Timeline.ContextUsage)
	}
	if output.Timeline.CacheHitUsage != nil {
		t.Fatalf("未完成请求不应产生缓存均值：%+v", output.Timeline.CacheHitUsage)
	}
	if next := read(); !reflect.DeepEqual(next, output) {
		t.Fatal("重连后快照不一致")
	}
	messages, err := m.Messages(context.Background(), session.ID, "", 50)
	if err != nil || len(messages.Items) != 1 || messages.Items[0].Role != "user" {
		t.Fatal("增量被误写为公开消息", err)
	}
	release()
	runtimeFinished(t, m, run.ID)
	final := read()
	if !final.Done || final.Content != "完整回答" {
		t.Fatalf("错误终态：%+v", final)
	}
	if final.Timeline == nil || final.Timeline.Usage.ModelRequests != 2 || final.Timeline.Usage.ActualTokens == nil || *final.Timeline.Usage.ActualTokens != 40 || final.Timeline.Usage.CachedTokens == nil || *final.Timeline.Usage.CachedTokens != 10 {
		t.Fatalf("流式终态用量错误：%+v", final.Timeline)
	}
	contextUsage := final.Timeline.ContextUsage
	if contextUsage == nil || contextUsage.ModelRequestID != final.Timeline.FinalResponseID || contextUsage.Model != "test" || contextUsage.ContextTokens != 65536 || contextUsage.TotalTokens == nil || *contextUsage.TotalTokens != 20 {
		t.Fatalf("流式上下文用量未取最后推理：%+v", contextUsage)
	}
	if final.Timeline.CacheHitUsage == nil || final.Timeline.CacheHitUsage.InputTokens != 30 || final.Timeline.CacheHitUsage.CachedTokens != 10 {
		t.Fatalf("流式缓存均值未覆盖全部完成请求：%+v", final.Timeline.CacheHitUsage)
	}
}

func TestChatOutputExcludesToolsAndConsolidation(t *testing.T) {
	records := []ModelRequestRecord{
		{ID: "tool", Purpose: "inference", Status: StateSucceeded, Response: &model.Response{Content: "工具附带文本", Reasoning: "公开思考", ToolCalls: []model.ToolCall{{ID: "t"}}}},
		{ID: "memory", Purpose: "final-memory", Status: StateRunning, Reasoning: "整理", Content: "不公开"},
	}
	output := chatOutput(Run{ID: "r", Status: StateRunning}, records)
	if output.Content != "" || output.Reasoning != "公开思考" || output.ResponseID != "tool" {
		t.Fatal(output)
	}
	records = append(records, ModelRequestRecord{ID: "failed", Purpose: "inference", Status: StateRunning, Content: "未完成回答"})
	if output := chatOutput(Run{ID: "r", Status: StateFailed}, records); output.Content != "" || !output.Done {
		t.Fatal(output)
	}
}

func TestChatOutputCanceledBeforeOpeningDoesNotReadOrWrite(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	rec := httptest.NewRecorder()
	// 取消先于路由进入时，不能读取业务数据或发首帧；nil 服务确保不触达读取。
	streamChatOutput(nil, nil, rec, httptest.NewRequest(http.MethodGet, "/runs/r/output", nil).WithContext(ctx))
	if rec.Body.Len() != 0 || rec.Header().Get("Content-Type") != "" {
		t.Fatal("已撤销的输出流仍写入响应")
	}
}
