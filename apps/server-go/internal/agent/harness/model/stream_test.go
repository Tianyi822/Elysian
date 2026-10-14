package model

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func eventFrames(events ...string) string {
	return "data: " + strings.Join(events, "\n\ndata: ") + "\n\n"
}

const anthropicStart = `{"type":"message_start","message":{"type":"message","role":"assistant","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}`

func TestStreamingReasoningArrivesBeforeConfirmedResponse(t *testing.T) {
	for _, test := range []struct{ format, first, last string }{
		{FormatChatCompletions,
			eventFrames(`{"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"检查\n"},"finish_reason":null}]}`),
			eventFrames(`{"choices":[{"index":0,"delta":{"reasoning_content":"容器","debug":"不可公开"}}]}`, `{"choices":[{"index":0,"delta":{"content":"完成"},"finish_reason":"stop"}]}`, `{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}`, `[DONE]`)},
		{FormatResponses,
			eventFrames(`{"type":"response.reasoning_summary_text.delta","delta":"检查\n"}`),
			eventFrames(`{"type":"response.reasoning_summary_text.delta","delta":"容器"}`, `{"type":"response.reasoning_text.delta","delta":"不可公开"}`, `{"type":"response.completed","response":{"object":"response","status":"completed","output":[{"type":"reasoning","encrypted_content":"不可公开","summary":[{"type":"summary_text","text":"检查\n容器"}]},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"完成"}]}],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}`)},
		{FormatAnthropicMessages,
			eventFrames(anthropicStart, `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`, `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"检查\n"}}`),
			eventFrames(`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"容器"}}`, `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"不可公开"}}`, `{"type":"content_block_stop","index":0}`, `{"type":"content_block_start","index":1,"content_block":{"type":"redacted_thinking","data":"不可公开","thinking":"不可公开"}}`, `{"type":"content_block_stop","index":1}`, `{"type":"content_block_start","index":2,"content_block":{"type":"text","text":"完成"}}`, `{"type":"content_block_stop","index":2}`, `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`, `{"type":"message_stop"}`)},
	} {
		t.Run(test.format, func(t *testing.T) {
			unblock := make(chan struct{})
			var release sync.Once
			defer release.Do(func() { close(unblock) })
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request map[string]json.RawMessage
				if json.NewDecoder(r.Body).Decode(&request) != nil || string(request["stream"]) != "true" || !strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
					t.Error("生成请求未开启流式")
				}
				w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
				io.WriteString(w, ": keep-alive\r\n\r\n"+test.first)
				w.(http.Flusher).Flush()
				select {
				case <-unblock:
					io.WriteString(w, test.last)
				case <-r.Context().Done():
				}
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			p := testProfile(server.URL)
			p.APIFormat = test.format
			input := testRequest()
			var reasoning strings.Builder
			first := make(chan struct{}, 1)
			input.OnReasoning = func(delta string) {
				reasoning.WriteString(delta)
				select {
				case first <- struct{}{}:
				default:
				}
			}
			type outcome struct {
				response Response
				err      error
			}
			result := make(chan outcome, 1)
			go func() {
				r, err := NewClient(nil).Complete(ctx, p, input)
				result <- outcome{r, err}
			}()
			select {
			case <-first:
			case <-ctx.Done():
				t.Fatal("未在结束前接收到思考增量")
			}
			select {
			case got := <-result:
				t.Fatalf("提前返回未确认响应：%+v", got)
			default:
			}
			release.Do(func() { close(unblock) })
			got := <-result
			if got.err != nil || got.response.Content != "完成" || got.response.Reasoning != "检查\n容器" || reasoning.String() != "检查\n容器" {
				t.Fatalf("流式文本不一致：%+v，增量=%q", got, reasoning.String())
			}
			if got.response.Usage.TotalTokens == nil || *got.response.Usage.TotalTokens != 12 {
				t.Fatal("流式用量丢失")
			}
			encoded, _ := json.Marshal(got.response)
			if strings.Contains(string(encoded), "不可公开") {
				t.Fatal("非展示内容进入响应")
			}
		})
	}
}

func TestStreamToolArgumentsWaitForCompleteFramesAndKeepPrecision(t *testing.T) {
	for _, test := range []struct{ name, format, body string }{
		{"Chat 分片", FormatChatCompletions, eventFrames(
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"docker_containers_","arguments":"{\"n\":"}}]}}]}`,
			`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"list","arguments":"9007199254740993}"}}]},"finish_reason":"tool_calls"}]}`, `[DONE]`)},
		{"Responses 终帧", FormatResponses, eventFrames(`{"type":"response.function_call_arguments.delta","delta":"{\"n\":"}`, `{"type":"response.completed","response":{"object":"response","status":"completed","output":[{"type":"function_call","call_id":"c1","name":"docker_containers_list","arguments":"{\"n\":9007199254740993}"}]}}`)},
		{"Messages 初始参数", FormatAnthropicMessages, eventFrames(anthropicStart, `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"docker_containers_list","input":{"n":9007199254740993}}}`, `{"type":"content_block_stop","index":0}`, `{"type":"message_delta","delta":{"stop_reason":"tool_use"}}`, `{"type":"message_stop"}`)},
		{"Messages 分片", FormatAnthropicMessages, eventFrames(anthropicStart, `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"docker_containers_list","input":{}}}`, `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"n\":"}}`, `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"9007199254740993}"}}`, `{"type":"content_block_stop","index":0}`, `{"type":"message_delta","delta":{"stop_reason":"tool_use"}}`, `{"type":"message_stop"}`)},
	} {
		t.Run(test.name, func(t *testing.T) {
			response, err := completeStream(t, test.format, test.body)
			if err != nil || len(response.ToolCalls) != 1 || string(response.ToolCalls[0].Arguments) != `{"n":9007199254740993}` {
				t.Fatalf("参数精度或终帧校验失败：%+v %v", response, err)
			}
		})
	}
}

func completeStream(t *testing.T, format, body string) (Response, error) {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, body)
	}))
	defer server.Close()
	p, input := testProfile(server.URL), testRequest()
	p.APIFormat = format
	input.Tools, input.ToolChoice, input.OnReasoning = testTools(), "auto", func(string) {}
	return NewClient(nil).Complete(context.Background(), p, input)
}

func TestStreamRejectsIncompleteAndAmbiguousResponses(t *testing.T) {
	for _, test := range []struct{ name, format, body string }{
		{"Chat 无结束原因", FormatChatCompletions, eventFrames(`{"choices":[{"delta":{"content":"完成"}}]}`, `[DONE]`)},
		{"Chat 无终帧", FormatChatCompletions, eventFrames(`{"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}`)},
		{"Chat 重复键", FormatChatCompletions, eventFrames(`{"choices":[{"delta":{"content":"一","content":"二"},"finish_reason":"stop"}]}`, `[DONE]`)},
		{"Chat 截断工具", FormatChatCompletions, eventFrames(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"docker_containers_list","arguments":"{}"}}]},"finish_reason":"length"}]}`, `[DONE]`)},
		{"Chat 重复参数键", FormatChatCompletions, eventFrames(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"docker_containers_list","arguments":"{\"n\":1,"}}]}}]}`, `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"n\":2}"}}]},"finish_reason":"tool_calls"}]}`, `[DONE]`)},
		{"Messages 未结束工具块", FormatAnthropicMessages, eventFrames(anthropicStart, `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c1","name":"docker_containers_list","input":{}}}`, `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"n\":"}}`, `{"type":"message_delta","delta":{"stop_reason":"tool_use"}}`, `{"type":"message_stop"}`)},
		{"Messages 结束后继续块", FormatAnthropicMessages, eventFrames(anthropicStart, `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"完成"}}`, `{"type":"content_block_stop","index":0}`, `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"失效"}}`)},
		{"Responses 失败", FormatResponses, eventFrames(`{"type":"response.failed","response":{"error":"不可回显"}}`)},
		{"Responses 缺终帧", FormatResponses, eventFrames(`{"type":"response.reasoning_summary_text.delta","delta":"检查"}`)},
		{"Responses 截断工具", FormatResponses, eventFrames(`{"type":"response.incomplete","response":{"object":"response","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"function_call","call_id":"c1","name":"docker_containers_list","arguments":"{}"}]}}`)},
	} {
		t.Run(test.name, func(t *testing.T) {
			response, err := completeStream(t, test.format, test.body)
			requireCode(t, err, "invalid-model-response")
			if len(response.ToolCalls) > 0 || strings.Contains(err.Error(), "不可回显") {
				t.Fatal("未确认调用或上游诊断被返回")
			}
		})
	}
}

func TestStreamLimitIncludesFramingAndComments(t *testing.T) {
	_, err := completeStream(t, FormatChatCompletions, strings.Repeat(": keep-alive\n\n", responseLimit(testRequest().MaxTokens)/14+1))
	requireCode(t, err, "model-response-too-large")
}

// 思考模式长回答：逐小段分帧让原始流远超 512 KiB 基础上限，仍必须在输出上限对应的字节预算内被接受。
func TestStreamAcceptsFramedResponseWithinOutputAllowance(t *testing.T) {
	chunk := `{"choices":[{"delta":{"content":"` + strings.Repeat("完成", 60) + `"}}]}`
	frames := make([]string, 0, 4200)
	for i := 0; i < 4200; i++ {
		frames = append(frames, chunk)
	}
	frames = append(frames, `{"choices":[{"delta":{},"finish_reason":"stop"}]}`, "[DONE]")
	body := eventFrames(frames...)
	if len(body) <= MaxResponseBytes {
		t.Fatalf("测试流未超过基础上限：%d", len(body))
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, body)
	}))
	defer server.Close()
	p, input := testProfile(server.URL), testRequest()
	p.OutputTokens = 8192
	input.MaxTokens, input.OnReasoning, input.OnContent = 8192, func(string) {}, func(string) {}
	response, err := NewClient(nil).Complete(context.Background(), p, input)
	if err != nil {
		t.Fatalf("输出上限内的分帧响应被拒绝：%v", err)
	}
	if response.FinishReason != "stop" || len(response.Content) == 0 {
		t.Fatalf("分帧响应未完整解码：%+v", response)
	}
}

func TestStreamJSONFallbackAndErrorsDoNotRetry(t *testing.T) {
	for _, test := range []struct {
		name       string
		status     int
		body, code string
	}{
		{"非流式兼容", 200, `{"choices":[{"message":{"role":"assistant","content":"完成","reasoning_content":"检查"},"finish_reason":"stop"}]}`, ""},
		{"鉴权", 401, `不可回显`, "model-auth-failed"},
		{"限流", 429, `不可回显`, "model-rate-limited"},
		{"跳转", 307, `不可回显`, "model-redirect-refused"},
		{"过大 JSON", 200, strings.Repeat("x", responseLimit(testRequest().MaxTokens)+1), "model-response-too-large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(test.status)
				io.WriteString(w, test.body)
			}))
			defer server.Close()
			var seen string
			input := testRequest()
			input.OnReasoning = func(delta string) { seen += delta }
			response, err := NewClient(nil).Complete(context.Background(), testProfile(server.URL), input)
			if test.code == "" {
				if err != nil || seen != "检查" || response.Reasoning != seen {
					t.Fatalf("JSON 兼容失败：%+v %v", response, err)
				}
			} else {
				requireCode(t, err, test.code)
				if seen != "" || strings.Contains(err.Error(), "不可回显") {
					t.Fatal("失败响应被公开")
				}
			}
			if calls.Load() != 1 {
				t.Fatal("请求被自动重试")
			}
		})
	}
}

func TestStreamCancellationDoesNotReturnPartialAnswer(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, eventFrames(`{"choices":[{"delta":{"reasoning_content":"检查"}}]}`))
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	input := testRequest()
	input.OnReasoning = func(string) { cancel() }
	response, err := NewClient(nil).Complete(ctx, testProfile(server.URL), input)
	requireCode(t, err, "model-cancelled")
	if response.Reasoning != "" || len(response.ToolCalls) != 0 {
		t.Fatal("取消请求返回了未确认响应")
	}
}

func TestReasoningRequestPreservesDeepSeekToolContinuationOnly(t *testing.T) {
	for _, provider := range []string{ProviderDeepSeek, ProviderOpenAICompatible} {
		p, input := testProfile("https://example.test"), testRequest()
		p.Provider = provider
		input.OnReasoning = func(string) {}
		input.Tools, input.ToolChoice = testTools(), "auto"
		input.Messages = append(input.Messages, Message{Role: "assistant", Reasoning: "当前工具轮次的思考", ToolCalls: []ToolCall{{ID: "c1", Name: "docker_containers_list", Arguments: json.RawMessage(`{}`)}}}, Message{Role: "tool", ToolCallID: "c1", Content: "完成"})
		wire, err := (chatCompletionsProtocol{}).prepare(p, input)
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			Thinking *wireThinking `json:"thinking"`
			Messages []wireMessage `json:"messages"`
		}
		if json.Unmarshal(wire.body, &body) != nil {
			t.Fatal("请求无法解码")
		}
		if provider == ProviderDeepSeek {
			if body.Thinking == nil || body.Thinking.Type != "enabled" || body.Messages[1].Reasoning == "" {
				t.Fatal("DeepSeek 工具续轮未带思考")
			}
		} else if body.Thinking != nil || body.Messages[1].Reasoning != "" {
			t.Fatal("通用服务混入供应商专用字段")
		}
	}
}
