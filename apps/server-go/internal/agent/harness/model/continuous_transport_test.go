package model

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"
)

func TestContinuousTransportKeepsPoolAndLegacyTimeout(t *testing.T) {
	client := NewClient(nil).(*httpClient)
	if client.client.Timeout != 2*time.Minute {
		t.Fatal("旧传输时限改变")
	}
	continuous := client.continuousClient()
	if continuous != client.continuousClient() || continuous.client.Timeout != 30*time.Minute {
		t.Fatal("持续请求未复用传输池")
	}
}

func TestContinuousRetryAfterPreservesLongServerDelay(t *testing.T) {
	now := time.Date(2026, 11, 17, 0, 0, 0, 500000000, time.UTC)
	for _, tc := range []struct {
		value string
		want  int
	}{{"900", 900}, {now.Add(1200 * time.Second).UTC().Format(http.TimeFormat), 1200}, {"-1", 0}, {"invalid", 0}} {
		if got := retryAfterSeconds(tc.value, now); got != tc.want {
			t.Errorf("Retry-After %q: %d != %d", tc.value, got, tc.want)
		}
	}
}

func TestModelTransportIdleTimerUsesRawDataAndCloses(t *testing.T) {
	for _, active := range []bool{false, true} {
		t.Run(map[bool]string{false: "idle", true: "active"}[active], func(t *testing.T) {
			exited := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				defer close(exited)
				w.Header().Set("Content-Type", "text/plain")
				w.WriteHeader(200)
				w.(http.Flusher).Flush()
				if !active {
					<-r.Context().Done()
					return
				}
				for range 10 {
					io.WriteString(w, "x")
					w.(http.Flusher).Flush()
					select {
					case <-r.Context().Done():
						return
					case <-time.After(10 * time.Millisecond):
					}
				}
			}))
			defer server.Close()
			client := http.Client{Transport: idleTransport{base: http.DefaultTransport, timeout: 50 * time.Millisecond}, Timeout: time.Second}
			request, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
			response, err := client.Do(request)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			response.Body.Close()
			if active && (err != nil || len(body) != 10) {
				t.Fatalf("活动数据被总空闲计时截断：%d %v", len(body), err)
			}
			if !active && err == nil {
				t.Fatal("空闲连接没有被回收")
			}
			select {
			case <-exited:
			case <-time.After(time.Second):
				t.Fatal("请求取消后服务端仍未退出")
			}
		})
	}
}

// Compare the actual serialized content blocks. Cache-control breakpoints are
// transport metadata; they move as history grows and do not rewrite token input.
// A new operation identity may only appear in appended messages, never by
// rewriting an already transmitted tool proposal or receipt.
func TestContinuousProtocolSerializedPrefixSurvivesNewOperationID(t *testing.T) {
	for _, format := range []string{FormatChatCompletions, FormatAnthropicMessages, FormatResponses} {
		t.Run(format, func(t *testing.T) {
			profile := testProfile("https://example.invalid/v1")
			profile.APIFormat = format
			request := Request{Continuous: true, MaxTokens: 1024, Messages: []Message{
				{Role: "system", Content: "稳定规则"}, {Role: "user", Content: "稳定目标"},
				{Role: "assistant", ToolCalls: []ToolCall{{ID: "call-original", Name: "inspect", Arguments: json.RawMessage(`{"requestId":"original","id":"resource"}`)}}},
				{Role: "tool", ToolCallID: "call-original", Content: `{"result":"unknown","requestId":"original"}`},
				{Role: "user", Content: "当前状态：等待核实"},
			}, Tools: []Tool{{Name: "inspect", Description: "读取", Parameters: json.RawMessage(`{"type":"object"}`)}}}
			protocol, err := resolveProtocol(format)
			if err != nil {
				t.Fatal(err)
			}
			before, err := protocol.prepare(profile, request)
			if err != nil {
				t.Fatal(err)
			}
			request.Messages = append(request.Messages[:4], Message{Role: "user", Content: "追加核实证据：原操作已结束"}, Message{Role: "assistant", ToolCalls: []ToolCall{{ID: "call-next", Name: "inspect", Arguments: json.RawMessage(`{"requestId":"next","id":"resource"}`)}}}, Message{Role: "tool", ToolCallID: "call-next", Content: `{"result":"confirmed"}`}, Message{Role: "user", Content: "当前状态：继续"})
			after, err := protocol.prepare(profile, request)
			if err != nil {
				t.Fatal(err)
			}
			var oldWire, newWire map[string]json.RawMessage
			json.Unmarshal(before.body, &oldWire)
			json.Unmarshal(after.body, &newWire)
			key := "messages"
			if format == FormatResponses {
				key = "input"
			}
			var oldMessages, newMessages []json.RawMessage
			json.Unmarshal(oldWire[key], &oldMessages)
			json.Unmarshal(newWire[key], &newMessages)
			if format == FormatAnthropicMessages {
				oldMessages = anthropicContentPrefix(oldWire[key])
				newMessages = anthropicContentPrefix(newWire[key])
			}
			if len(oldMessages) < 2 || len(newMessages) <= len(oldMessages) {
				t.Fatal("协议消息未增量追加")
			}
			for i := 0; i < len(oldMessages)-1; i++ {
				if string(oldMessages[i]) != string(newMessages[i]) {
					t.Fatalf("历史消息 %d 被新身份改写：\n%s\n%s", i, oldMessages[i], newMessages[i])
				}
			}
			if !reflect.DeepEqual(oldWire["tools"], newWire["tools"]) {
				t.Fatal("新请求身份改变工具定义")
			}
		})
	}
}

func anthropicContentPrefix(raw json.RawMessage) []json.RawMessage {
	var messages []struct {
		Role    string                       `json:"role"`
		Content []map[string]json.RawMessage `json:"content"`
	}
	_ = json.Unmarshal(raw, &messages)
	var content []json.RawMessage
	for _, message := range messages {
		for _, block := range message.Content {
			delete(block, "cache_control")
			raw, _ := json.Marshal(struct {
				Role    string                     `json:"role"`
				Content map[string]json.RawMessage `json:"content"`
			}{message.Role, block})
			content = append(content, raw)
		}
	}
	return content
}
