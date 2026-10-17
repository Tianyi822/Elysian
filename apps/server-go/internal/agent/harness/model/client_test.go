package model

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestModelResponseRejectsDuplicateKeysAndKeepsLargeArguments(t *testing.T) {
	for _, body := range []string{
		`{"choices":[{"message":{"role":"assistant","role":"assistant","content":"完成"},"finish_reason":"stop"}]}`,
		`{"choices":[{"message":{"role":"assistant","content":"完成"},"finish_reason":"stop"}],"usage":{"total_tokens":1,"total_tokens":2}}`,
		`{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call-1","type":"function","function":{"name":"check","arguments":"{\"n\":1,\"n\":2}"}}]},"finish_reason":"tool_calls"}]}`,
	} {
		if _, err := parseResponse([]byte(body), map[string]bool{"check": true}, ""); err == nil {
			t.Fatal("模型重复 JSON 字段被接收")
		}
	}
	body := `{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call-1","type":"function","function":{"name":"check","arguments":"{\"n\":9007199254740993,\"decimal\":1.2300e+100}"}}]},"finish_reason":"tool_calls"}]}`
	result, err := parseResponse([]byte(body), map[string]bool{"check": true}, "")
	if err != nil || len(result.ToolCalls) != 1 || string(result.ToolCalls[0].Arguments) != `{"decimal":1.2300e+100,"n":9007199254740993}` {
		t.Fatalf("模型参数精度丢失：%+v %v", result, err)
	}
}

func testProfile(base string) Profile {
	return Profile{
		Provider: ProviderOpenAICompatible, APIFormat: FormatChatCompletions,
		BaseURL: base, Model: "test-model", ContextTokens: 8192, OutputTokens: 1024,
		Capabilities: Capabilities{Text: true, Tools: true, Source: "用户配置"}, Active: true,
		Credential: "test-key", HasCredential: true,
	}
}

func TestDeepSeekProviderDisablesThinkingWithoutDisplayCallback(t *testing.T) {
	for _, choice := range []string{"", "auto", "required", "checkpoint", "workflow_finish"} {
		t.Run("choice="+choice, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]json.RawMessage
				if json.NewDecoder(r.Body).Decode(&body) != nil || string(body["thinking"]) != `{"type":"disabled"}` || string(body["stream"]) != "false" || r.URL.Path != "/chat/completions" {
					t.Error("DeepSeek 请求未关闭思考或使用了错误协议")
				}
				if choice == "" {
					io.WriteString(w, `{"choices":[{"index":0,"message":{"role":"assistant","content":"完成"},"finish_reason":"stop"}]}`)
				} else {
					name := choice
					if choice == "auto" || choice == "required" {
						name = "docker_containers_list"
					}
					fmt.Fprintf(w, `{"choices":[{"index":0,"message":{"role":"assistant","content":null,"tool_calls":[{"id":"call-1","type":"function","function":{"name":%q,"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`, name)
				}
			}))
			defer server.Close()
			profile := testProfile(server.URL)
			profile.Provider, profile.Model, profile.Credential = ProviderDeepSeek, "deepseek-flash", "fake-key"
			request := testRequest()
			if choice != "" {
				request.Tools, request.ToolChoice = testTools(), choice
				if choice == "checkpoint" || choice == "workflow_finish" {
					request.Tools[0].Name = choice
				}
			}
			if _, err := NewClient(nil).Complete(context.Background(), profile, request); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCompatibleProviderDoesNotSendVendorParameters(t *testing.T) {
	provider, err := resolveProtocol(FormatChatCompletions)
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := provider.prepare(testProfile("https://example.test/v1"), testRequest())
	if err != nil || strings.Contains(string(prepared.body), "thinking") || prepared.endpoint != "https://example.test/v1/chat/completions" {
		t.Fatalf("通用接口被供应商参数污染：%v", err)
	}
	if _, err = resolveProtocol("unknown"); err == nil {
		t.Fatal("未知供应商未拒绝")
	}
}

func testRequest() Request {
	return Request{Messages: []Message{{Role: "user", Content: "检查容器"}}, MaxTokens: 256}
}

func testTools() []Tool {
	return []Tool{{Name: "docker_containers_list", Description: "读取容器", Parameters: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}}
}

func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *Error
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("需要错误 %s，实际 %v", code, err)
	}
}

func TestCompleteUsesFunctionProtocolAndKeepsOnlyExplicitReasoning(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Errorf("模型请求路径、方法或鉴权错误")
		}
		var request struct {
			Model     string        `json:"model"`
			Stream    bool          `json:"stream"`
			MaxTokens int           `json:"max_tokens"`
			Messages  []wireMessage `json:"messages"`
			Tools     []wireTool    `json:"tools"`
			Choice    struct {
				Type     string `json:"type"`
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tool_choice"`
		}
		if json.NewDecoder(r.Body).Decode(&request) != nil || request.Model != "test-model" || request.Stream || request.MaxTokens != 256 || len(request.Tools) != 1 || request.Choice.Function.Name != "docker_containers_list" || request.Choice.Type != "function" {
			t.Errorf("模型请求未使用标准函数协议")
		}
		if len(request.Messages) != 4 || request.Messages[1].ToolCalls[0].Function.Arguments != `{}` || request.Messages[2].ToolCallID != "call-old" {
			t.Errorf("历史函数调用与结果未完整转换")
		}
		io.WriteString(w, `{"choices":[{"index":0,"message":{"role":"assistant","content":null,"reasoning_content":"检查容器状态", "debug":"不可保存的调试内容", "encrypted_content":"不可保存的加密内容","tool_calls":[{"id":"call-new","type":"function","function":{"name":"docker_containers_list","arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":123,"completion_tokens":12,"total_tokens":135,"prompt_tokens_details":{"cached_tokens":100}}}`)
	}))
	defer server.Close()
	p := testProfile(server.URL + "/v1")
	p.Credential = "test-secret"
	request := testRequest()
	request.Messages = append(request.Messages,
		Message{Role: "assistant", ToolCalls: []ToolCall{{ID: "call-old", Name: "docker_containers_list", Arguments: json.RawMessage(`{}`)}}},
		Message{Role: "tool", ToolCallID: "call-old", Content: `{"items":[]}`},
		Message{Role: "user", Content: "再次读取"},
	)
	request.Tools, request.ToolChoice = testTools(), "docker_containers_list"
	response, err := NewClient(nil).Complete(context.Background(), p, request)
	if err != nil {
		t.Fatal(err)
	}
	if len(response.ToolCalls) != 1 || response.ToolCalls[0].ID != "call-new" || string(response.ToolCalls[0].Arguments) != `{}` || response.Usage.CachedTokens == nil || *response.Usage.CachedTokens != 100 {
		t.Fatalf("公开响应或实际用量错误：%+v", response)
	}
	encoded, _ := json.Marshal(response)
	if response.Reasoning != "检查容器状态" || strings.Contains(string(encoded), "不可保存") || strings.Contains(string(encoded), "test-secret") {
		t.Fatal("响应包含私有字段或凭据")
	}
}

func TestCompleteRefusesRedirectWithoutForwardingCredential(t *testing.T) {
	var forwarded atomic.Int32
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded.Add(1) }))
	defer destination.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	p := testProfile(server.URL)
	p.Credential = "redirect-secret"
	provided := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { t.Error("不应使用外部跳转策略"); return nil }}
	_, err := NewClient(provided).Complete(context.Background(), p, testRequest())
	requireCode(t, err, "model-redirect-refused")
	if forwarded.Load() != 0 {
		t.Fatal("凭据请求被发送到跳转目标")
	}
	if provided.CheckRedirect == nil {
		t.Fatal("不应修改传入的客户端")
	}
}

func TestCompleteLimitsResponseAndSanitizesErrorsWithoutRetry(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		body   string
		code   string
	}{
		{"鉴权", 401, `{"error":"Bearer response-secret"}`, "model-auth-failed"},
		{"限流", 429, `response-secret`, "model-rate-limited"},
		{"服务错误", 500, `response-secret`, "model-http-failed"},
		{"非法响应", 200, `response-secret`, "invalid-model-response"},
		{"过大响应", 200, strings.Repeat("x", responseLimit(testRequest().MaxTokens)+1), "model-response-too-large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.WriteHeader(test.status)
				io.WriteString(w, test.body)
			}))
			defer server.Close()
			_, err := NewClient(nil).Complete(context.Background(), testProfile(server.URL), testRequest())
			requireCode(t, err, test.code)
			if calls.Load() != 1 || strings.Contains(err.Error(), "response-secret") {
				t.Fatal("模型请求发生重试或泄露服务端正文")
			}
		})
	}
}

func TestCompleteCancellationStopsWaitingForBody(t *testing.T) {
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer server.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := NewClient(nil).Complete(ctx, testProfile(server.URL), testRequest()); done <- err }()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("模型请求未开始")
	}
	cancel()
	select {
	case err := <-done:
		requireCode(t, err, "model-cancelled")
		if !errors.Is(err, context.Canceled) {
			t.Fatal("取消错误应可识别")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("取消未停止读取响应")
	}
}

func TestResponseValidatesToolProtocolAndPreservesUnknownUsage(t *testing.T) {
	response, err := parseResponse([]byte(`{"choices":[{"message":{"role":"assistant","content":"已完成"},"finish_reason":"stop"}]}`), nil, "")
	if err != nil || response.Usage.PromptTokens != nil || response.Usage.CachedTokens != nil {
		t.Fatalf("未报告用量必须保持未知：%+v %v", response, err)
	}
	call := `{"id":"c1","type":"function","function":{"name":"docker_containers_list","arguments":"{}"}}`
	for _, test := range []struct{ name, calls, finish, choice string }{
		{"截断调用", call, "length", ""},
		{"停止但带调用", call, "stop", ""},
		{"重复编号", call + "," + call, "tool_calls", ""},
		{"未知函数", strings.ReplaceAll(call, "docker_containers_list", "unsafe_tool"), "tool_calls", ""},
		{"错误参数类型", strings.ReplaceAll(call, `"{}"`, `"[]"`), "tool_calls", ""},
		{"缺调用", "", "tool_calls", ""},
		{"禁止调用", call, "tool_calls", "none"},
		{"未知结束原因", "", "function_call", ""},
		{"强制调用未执行", "", "stop", "required"},
	} {
		t.Run(test.name, func(t *testing.T) {
			body := fmt.Sprintf(`{"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[%s]},"finish_reason":%q}]}`, test.calls, test.finish)
			_, err := parseResponse([]byte(body), map[string]bool{"docker_containers_list": true}, test.choice)
			requireCode(t, err, "invalid-model-response")
		})
	}
}

// DeepSeek 等供应商把缓存命中放在 usage 的扁平字段，与 prompt_tokens_details.cached_tokens 同值；
// 嵌套字段优先，缺失回落扁平，两者都缺失时保持未知。
func TestResponseReadsFlatPromptCacheTokens(t *testing.T) {
	base := `{"choices":[{"message":{"role":"assistant","content":"已完成"},"finish_reason":"stop"}],"usage":%s}`
	for _, test := range []struct {
		name    string
		usage   string
		cached  int
		known   bool
		invalid bool
	}{
		{"嵌套字段", `{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":40}}`, 40, true, false},
		{"扁平字段回落", `{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_cache_hit_tokens":40,"prompt_cache_miss_tokens":60}`, 40, true, false},
		{"嵌套优先", `{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":40},"prompt_cache_hit_tokens":55}`, 40, true, false},
		{"都缺保持未知", `{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}`, 0, false, false},
		{"扁平超出输入仍判无效", `{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_cache_hit_tokens":150}`, 0, false, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			response, err := parseResponse([]byte(fmt.Sprintf(base, test.usage)), nil, "")
			if test.invalid {
				requireCode(t, err, "invalid-model-response")
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if test.known {
				if response.Usage.CachedTokens == nil || *response.Usage.CachedTokens != test.cached {
					t.Fatalf("缓存命中未按预期解析：%+v", response.Usage)
				}
			} else if response.Usage.CachedTokens != nil {
				t.Fatalf("缺报缓存必须保持未知：%+v", response.Usage)
			}
		})
	}
}

func TestRequestRejectsIncompleteHistoryBeforeNetwork(t *testing.T) {
	request := testRequest()
	request.Messages = append(request.Messages, Message{Role: "assistant", ToolCalls: []ToolCall{{ID: "unfinished", Name: "docker_containers_list", Arguments: json.RawMessage(`{}`)}}})
	_, err := NewClient(nil).Complete(context.Background(), testProfile("http://127.0.0.1:1/v1"), request)
	requireCode(t, err, "incomplete-tool-history")
}
