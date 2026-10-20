package model

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestAnthropicCacheBreakpointsAfterMessageMerge(t *testing.T) {
	tools := testTools()
	tools = append(tools, Tool{Name: "second_tool", Parameters: tools[0].Parameters})
	for _, test := range []struct {
		name     string
		messages []Message
		tools    []Tool
		want     []string
	}{
		{
			name: "all breakpoints follow merged blocks",
			messages: []Message{
				{Role: "system", Content: "first system"},
				{Role: "system", Content: "last system"},
				{Role: "user", Content: "first user"},
				{Role: "user", Content: "second user"},
				{Role: "assistant", Content: "first answer"},
				{Role: "assistant", Content: "second answer"},
				{Role: "user", Content: "latest user"},
				{Role: "user", Content: "latest addition"},
			},
			tools: tools,
			want:  []string{"messages[1].content[1]", "system[1]", "tools[1]"},
		},
		{
			name: "no system",
			messages: []Message{
				{Role: "user", Content: "question"},
				{Role: "assistant", Content: "answer"},
				{Role: "user", Content: "next question"},
			},
			tools: tools,
			want:  []string{"messages[1].content[0]", "tools[1]"},
		},
		{
			name: "no tools",
			messages: []Message{
				{Role: "system", Content: "system"},
				{Role: "user", Content: "question"},
				{Role: "assistant", Content: "answer"},
				{Role: "user", Content: "next question"},
			},
			want: []string{"messages[1].content[0]", "system[0]"},
		},
		{
			name: "one message skips message breakpoint",
			messages: []Message{
				{Role: "system", Content: "system"},
				{Role: "user", Content: "question"},
			},
			tools: tools,
			want:  []string{"system[0]", "tools[1]"},
		},
		{
			name: "merged single message skips message breakpoint",
			messages: []Message{
				{Role: "system", Content: "system"},
				{Role: "user", Content: "question"},
				{Role: "user", Content: "addition"},
			},
			tools: tools,
			want:  []string{"system[0]", "tools[1]"},
		},
		{
			name:     "no eligible prefix omits cache control",
			messages: []Message{{Role: "user", Content: "question"}},
		},
		{
			name: "tool use ends cached message",
			messages: []Message{
				{Role: "user", Content: "question"},
				{Role: "assistant", Content: "checking", ToolCalls: []ToolCall{{ID: "call-1", Name: tools[0].Name, Arguments: json.RawMessage(`{}`)}}},
				{Role: "tool", ToolCallID: "call-1", Content: ""},
			},
			tools: tools,
			want:  []string{"messages[1].content[1]", "tools[1]"},
		},
		{
			name: "tool result ends cached message",
			messages: []Message{
				{Role: "user", Content: "question"},
				{Role: "assistant", ToolCalls: []ToolCall{{ID: "call-1", Name: tools[0].Name, Arguments: json.RawMessage(`{}`)}}},
				{Role: "tool", ToolCallID: "call-1", Content: ""},
				{Role: "assistant", Content: "answer"},
			},
			tools: tools,
			want:  []string{"messages[2].content[0]", "tools[1]"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			profile := testProfile("https://example.test")
			profile.APIFormat = FormatAnthropicMessages
			request := testRequest()
			request.Messages, request.Tools = test.messages, test.tools
			prepared, err := (anthropicMessagesProtocol{}).prepare(profile, request)
			if err != nil {
				t.Fatal(err)
			}
			requireAnthropicCacheLocations(t, prepared.body, test.want)
		})
	}
}

func TestAnthropicStreamingSendsCacheBreakpointsWithoutBetaHeader(t *testing.T) {
	type capturedRequest struct {
		body   []byte
		beta   string
		accept string
	}
	captured := make(chan capturedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		captured <- capturedRequest{body: body, beta: r.Header.Get("anthropic-beta"), accept: r.Header.Get("Accept")}
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, eventFrames(
			`{"type":"message_start","message":{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}}`,
			`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"answer"}}`,
			`{"type":"content_block_stop","index":0}`,
			`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
			`{"type":"message_stop"}`,
		))
	}))
	defer server.Close()
	profile := testProfile(server.URL)
	profile.APIFormat = FormatAnthropicMessages
	request := testRequest()
	request.Tools = testTools()
	request.Messages = []Message{
		{Role: "system", Content: "system"},
		{Role: "user", Content: "question"},
		{Role: "assistant", Content: "previous answer"},
		{Role: "user", Content: "next question"},
	}
	var content strings.Builder
	request.OnContent = func(delta string) { content.WriteString(delta) }
	response, err := NewClient(nil).Complete(context.Background(), profile, request)
	if err != nil {
		t.Fatal(err)
	}
	got := <-captured
	requireAnthropicCacheLocations(t, got.body, []string{"messages[1].content[0]", "system[0]", "tools[0]"})
	var wire anthropicRequest
	if json.Unmarshal(got.body, &wire) != nil || !wire.Stream || got.beta != "" || !strings.Contains(got.accept, "text/event-stream") {
		t.Fatalf("unexpected streaming request: %s, beta=%q, accept=%q", got.body, got.beta, got.accept)
	}
	if response.Content != "answer" || content.String() != "answer" || response.Usage.CachedTokens == nil || *response.Usage.CachedTokens != 3 || response.Usage.TotalTokens == nil || *response.Usage.TotalTokens != 19 {
		t.Fatalf("streamed content or usage changed: %+v", response)
	}
}

func requireAnthropicCacheLocations(t *testing.T, body []byte, want []string) {
	t.Helper()
	var value any
	if err := json.Unmarshal(body, &value); err != nil {
		t.Fatal(err)
	}
	var locations []string
	var visit func(any, string)
	visit = func(value any, path string) {
		switch typed := value.(type) {
		case map[string]any:
			for key, child := range typed {
				if key == "cache_control" {
					if !reflect.DeepEqual(child, map[string]any{"type": "ephemeral"}) {
						t.Errorf("unexpected cache control at %s: %+v", path, child)
					}
					locations = append(locations, path)
					continue
				}
				childPath := key
				if path != "" {
					childPath = path + "." + key
				}
				visit(child, childPath)
			}
		case []any:
			for index, child := range typed {
				visit(child, fmt.Sprintf("%s[%d]", path, index))
			}
		}
	}
	visit(value, "")
	sort.Strings(locations)
	if !reflect.DeepEqual(locations, want) || len(locations) > 3 {
		t.Fatalf("cache breakpoints = %v, want %v: %s", locations, want, body)
	}
}

// 尾部当前状态（本轮输入缓存在内的动态消息）每次请求都可能变化：最后一条消息不设断点，
// 三处断点固定落在最后 system、最后工具定义与倒数第二条消息末块，低于供应商四处上限。
func TestAnthropicCacheBreakpointsSkipVolatileTailMessage(t *testing.T) {
	profile := testProfile("https://example.test")
	profile.APIFormat = FormatAnthropicMessages
	request := testRequest()
	request.Tools = testTools()
	request.Messages = []Message{
		{Role: "system", Content: "system"},
		{Role: "user", Content: "header"},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "call-1", Name: testTools()[0].Name, Arguments: json.RawMessage(`{}`)}}},
		{Role: "tool", ToolCallID: "call-1", Content: "result"},
		{Role: "user", Content: "本轮当前状态（服务端同步的数据）：本轮用户输入与最新任务计划"},
	}
	prepared, err := (anthropicMessagesProtocol{}).prepare(profile, request)
	if err != nil {
		t.Fatal(err)
	}
	// 合并后最后一条消息是 tool_result 与尾部当前状态的合并块。
	requireAnthropicCacheLocations(t, prepared.body, []string{"messages[1].content[0]", "system[0]", "tools[0]"})
	var body anthropicRequest
	if err := json.Unmarshal(prepared.body, &body); err != nil {
		t.Fatal(err)
	}
	last := body.Messages[len(body.Messages)-1]
	if len(last.Content) != 2 || last.Content[0].Type != "tool_result" || last.Content[1].Type != "text" {
		t.Fatalf("易变尾消息未按预期合并：%+v", last.Content)
	}
	for _, block := range last.Content {
		if block.CacheControl != nil {
			t.Fatal("最后一条易变消息设置了缓存断点")
		}
	}
}
