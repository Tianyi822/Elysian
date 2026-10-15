package model

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDeepSeekProtocolsTextToolsAndForcedWorkflowOutput(t *testing.T) {
	for _, format := range []string{FormatChatCompletions, FormatAnthropicMessages, FormatResponses} {
		for _, choice := range []string{"", "auto", "required", "checkpoint", "workflow_finish"} {
			t.Run(format+"/"+choice, func(t *testing.T) {
				name := "docker_containers_list"
				if choice == "checkpoint" || choice == "workflow_finish" {
					name = choice
				}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var body map[string]json.RawMessage
					if json.NewDecoder(r.Body).Decode(&body) != nil || string(body["stream"]) != "false" {
						t.Error("非流式请求格式错误")
					}
					switch format {
					case FormatChatCompletions:
						if r.URL.Path != "/chat/completions" || r.Header.Get("Authorization") != "Bearer fake-key" || string(body["thinking"]) != `{"type":"disabled"}` {
							t.Error("Chat 路径/鉴权/思考设置错误")
						}
						if choice == "" {
							io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"完成"},"finish_reason":"stop"}]}`)
						} else {
							fmt.Fprintf(w, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call-new","type":"function","function":{"name":%q,"arguments":"{\"n\":9007199254740993}"}}]},"finish_reason":"tool_calls"}]}`, name)
						}
					case FormatAnthropicMessages:
						if r.URL.Path != "/anthropic/v1/messages" || r.Header.Get("x-api-key") != "fake-key" || r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("Authorization") != "" || string(body["thinking"]) != `{"type":"disabled"}` {
							t.Error("Messages 路径/鉴权/思考设置错误")
						}
						if choice == "required" && string(body["tool_choice"]) != `{"type":"any"}` {
							t.Error("工具选择转换失败")
						}
						if choice == "workflow_finish" && string(body["tool_choice"]) != `{"name":"workflow_finish","type":"tool"}` {
							t.Error("强制工作流函数未发送")
						}
						if choice == "" {
							io.WriteString(w, `{"type":"message","role":"assistant","content":[{"type":"thinking","thinking":"私密"},{"type":"text","text":"完成"}],"stop_reason":"end_turn","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}`)
						} else {
							fmt.Fprintf(w, `{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"call-new","name":%q,"input":{"n":9007199254740993}}],"stop_reason":"tool_use"}`, name)
						}
					case FormatResponses:
						if r.URL.Path != "/responses" || r.Header.Get("Authorization") != "Bearer fake-key" || string(body["reasoning"]) != `{"effort":"none"}` || string(body["store"]) != "false" || body["thinking"] != nil || body["previous_response_id"] != nil {
							t.Error("Responses 路径/思考/无状态设置错误")
						}
						if choice == "workflow_finish" && string(body["tool_choice"]) != `{"name":"workflow_finish","type":"function"}` {
							t.Error("强制工作流函数未发送")
						}
						if choice == "" {
							io.WriteString(w, `{"object":"response","status":"completed","output":[{"type":"reasoning","summary":[{"text":"私密"}]},{"type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"完成"}]}],"usage":{"input_tokens":17,"output_tokens":2,"total_tokens":19,"input_tokens_details":{"cached_tokens":3}}}`)
						} else {
							fmt.Fprintf(w, `{"object":"response","status":"completed","output":[{"type":"function_call","status":"completed","call_id":"call-new","name":%q,"arguments":"{\"n\":9007199254740993}"}]}`, name)
						}
					}
				}))
				defer server.Close()
				p := testProfile(server.URL)
				p.APIFormat = format
				p.Provider = ProviderDeepSeek
				p.Credential = "fake-key"
				if format == FormatAnthropicMessages {
					p.BaseURL += "/anthropic"
				}
				request := testRequest()
				if choice != "" {
					request.Tools = testTools()
					request.Tools[0].Name = name
					request.ToolChoice = choice
				}
				response, err := NewClient(nil).Complete(context.Background(), p, request)
				if err != nil {
					t.Fatal(err)
				}
				if choice == "" {
					if response.Content != "完成" || strings.Contains(response.Content, "私密") {
						t.Fatal("答复或私有推理处理错误")
					}
					if format != FormatChatCompletions && (response.Usage.TotalTokens == nil || *response.Usage.TotalTokens != 19) {
						t.Fatal("用量映射错误")
					}
				} else if len(response.ToolCalls) != 1 || response.ToolCalls[0].Name != name || string(response.ToolCalls[0].Arguments) != `{"n":9007199254740993}` || response.Usage.CachedTokens != nil {
					t.Fatal("函数输出精度或未知用量错误")
				}
			})
		}
	}
}
func TestNewProtocolsHistoryAndEmptyToolOutput(t *testing.T) {
	for _, format := range []string{FormatAnthropicMessages, FormatResponses} {
		p := testProfile("https://example.test/v1")
		p.APIFormat = format
		input := testRequest()
		input.Tools = testTools()
		input.ToolChoice = "auto"
		input.Messages = []Message{{Role: "system", Content: "系统约束"}, {Role: "user", Content: "读取"}, {Role: "assistant", ToolCalls: []ToolCall{{ID: "call-old", Name: input.Tools[0].Name, Arguments: json.RawMessage(`{"n":9007199254740993}`)}}}, {Role: "tool", ToolCallID: "call-old", Content: ""}, {Role: "user", Content: "继续"}}
		adapter, _ := resolveProtocol(format)
		wire, err := adapter.prepare(p, input)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(wire.body), "previous_response_id") || !strings.Contains(string(wire.body), "9007199254740993") {
			t.Fatal("公开历史丢失")
		}
		if format == FormatAnthropicMessages && (wire.endpoint != "https://example.test/v1/messages" || !strings.Contains(string(wire.body), `"tool_use_id":"call-old","content":""`)) {
			t.Fatal(string(wire.body))
		}
		if format == FormatResponses && (!strings.Contains(string(wire.body), `"type":"function_call_output","call_id":"call-old","output":""`) || !strings.Contains(string(wire.body), `"strict":false`)) {
			t.Fatal(string(wire.body))
		}
	}
}
func TestNewProtocolsRejectAmbiguousToolResponses(t *testing.T) {
	cases := []struct{ format, body string }{
		{FormatAnthropicMessages, `{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"c","name":"check","input":{"n":1,"n":2}}],"stop_reason":"tool_use"}`},
		{FormatAnthropicMessages, `{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"c","name":"check","input":{}}],"stop_reason":"max_tokens"}`},
		{FormatResponses, `{"object":"response","status":"completed","output":[{"type":"function_call","call_id":"c","name":"check","arguments":"{\"n\":1,\"n\":2}"}]}`},
		{FormatResponses, `{"object":"response","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"function_call","call_id":"c","name":"check","arguments":"{}"}]}`},
		{FormatResponses, `{"object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"refusal","refusal":"拒绝"}]},{"type":"function_call","call_id":"c","name":"check","arguments":"{}"}]}`},
	}
	for _, item := range cases {
		var err error
		if item.format == FormatAnthropicMessages {
			_, err = parseAnthropicResponse([]byte(item.body), map[string]bool{"check": true}, "auto")
		} else {
			_, err = parseResponsesResponse([]byte(item.body), map[string]bool{"check": true}, "auto")
		}
		if err == nil {
			t.Fatal("歧义工具响应被接收", item.body)
		}
	}
	for _, format := range []string{FormatAnthropicMessages, FormatResponses} {
		p := testProfile("https://example.test")
		p.APIFormat = format
		adapter, _ := resolveProtocol(format)
		req := testRequest()
		req.Messages = append(req.Messages, Message{Role: "assistant", ToolCalls: []ToolCall{{ID: "unfinished", Name: "check", Arguments: json.RawMessage(`{}`)}}})
		if _, err := adapter.prepare(p, req); err == nil {
			t.Fatal("未完成历史被发送")
		}
	}
}

func TestProtocolsEncodeImageUserMessages(t *testing.T) {
	png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00}
	input := testRequest()
	input.Messages = []Message{
		{Role: "system", Content: "系统"},
		{Role: "user", Content: "看图", Images: []ImagePart{{MimeType: "image/png", Data: png}}},
		{Role: "user", Content: "纯文本"},
	}
	imageJSON := `"data:image/png;base64,` + base64.StdEncoding.EncodeToString(png) + `"`
	raw := base64.StdEncoding.EncodeToString(png)

	chat, err := resolveProtocol(FormatChatCompletions)
	if err != nil {
		t.Fatal(err)
	}
	chatProfile := testProfile("https://example.test/v1")
	chatProfile.Capabilities.Image = true
	wire, err := chat.prepare(chatProfile, input)
	if err != nil {
		t.Fatal(err)
	}
	body := string(wire.body)
	if !strings.Contains(body, `{"role":"user","content":[{"type":"text","text":"看图"},{"type":"image_url","image_url":{"url":`+imageJSON+`}}]`) {
		t.Fatal("chat-completions 图片 content parts 错误：" + body)
	}
	if !strings.Contains(body, `{"role":"user","content":"纯文本"}`) {
		t.Fatal("无图消息未保持纯字符串：" + body)
	}

	anthropic, _ := resolveProtocol(FormatAnthropicMessages)
	p := testProfile("https://example.test/v1")
	p.APIFormat = FormatAnthropicMessages
	p.Capabilities.Image = true
	wire, err = anthropic.prepare(p, input)
	if err != nil {
		t.Fatal(err)
	}
	body = string(wire.body)
	if !strings.Contains(body, `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"`+raw+`"}}`) {
		t.Fatal("anthropic 图片块错误：" + body)
	}

	responses, _ := resolveProtocol(FormatResponses)
	respProfile := testProfile("https://example.test/v1")
	respProfile.APIFormat = FormatResponses
	respProfile.Capabilities.Image = true
	wire, err = responses.prepare(respProfile, input)
	if err != nil {
		t.Fatal(err)
	}
	body = string(wire.body)
	if !strings.Contains(body, `{"type":"message","role":"user","content":[{"type":"input_text","text":"看图"},{"type":"input_image","image_url":`+imageJSON+`}]}`) {
		t.Fatal("responses 图片输入错误：" + body)
	}
	if !strings.Contains(body, `{"type":"message","role":"user","content":"纯文本"}`) {
		t.Fatal("responses 无图消息未保持字符串：" + body)
	}
}

func TestImageValidationRules(t *testing.T) {
	p := testProfile("https://example.test/v1")
	p.Capabilities.Image = true
	base := testRequest()
	base.Messages = []Message{{Role: "user", Content: "看图", Images: []ImagePart{{MimeType: "image/png", Data: []byte{1}}}}}
	adapter, _ := resolveProtocol(FormatChatCompletions)
	if _, err := adapter.prepare(p, base); err != nil {
		t.Fatal("合法带图请求被拒绝", err)
	}
	noImage := testProfile("https://example.test/v1")
	if _, err := adapter.prepare(noImage, base); err == nil {
		t.Fatal("模型未声明图片能力仍接收图片")
	} else {
		requireCode(t, err, "model-capability-unavailable")
	}
	systemImages := testRequest()
	systemImages.Messages = []Message{{Role: "system", Content: "系统", Images: []ImagePart{{MimeType: "image/png", Data: []byte{1}}}}}
	if _, err := adapter.prepare(p, systemImages); err == nil {
		t.Fatal("system 消息带图被接收")
	}
	assistantImages := testRequest()
	assistantImages.Messages = []Message{{Role: "assistant", Content: "答", Images: []ImagePart{{MimeType: "image/png", Data: []byte{1}}}}}
	if _, err := adapter.prepare(p, assistantImages); err == nil {
		t.Fatal("assistant 消息带图被接收")
	}
	badMIME := testRequest()
	badMIME.Messages = []Message{{Role: "user", Content: "看图", Images: []ImagePart{{MimeType: "image/webp", Data: []byte{1}}}}}
	if _, err := adapter.prepare(p, badMIME); err == nil {
		t.Fatal("非法 MIME 被接收")
	}
	emptyData := testRequest()
	emptyData.Messages = []Message{{Role: "user", Content: "看图", Images: []ImagePart{{MimeType: "image/png"}}}}
	if _, err := adapter.prepare(p, emptyData); err == nil {
		t.Fatal("空字节图片被接收")
	}
}

func TestProtocolsAcceptManyImagesAndEightMiBImageBytes(t *testing.T) {
	for _, format := range []string{FormatChatCompletions, FormatAnthropicMessages, FormatResponses} {
		t.Run(format, func(t *testing.T) {
			p := testProfile("https://example.test/v1")
			p.APIFormat = format
			p.Capabilities.Image = true
			adapter, err := resolveProtocol(format)
			if err != nil {
				t.Fatal(err)
			}
			input := testRequest()
			input.Messages[0].Images = make([]ImagePart, 51)
			for i := range input.Messages[0].Images {
				input.Messages[0].Images[i] = ImagePart{MimeType: "image/png", Data: []byte{1}}
			}
			wire, err := adapter.prepare(p, input)
			if err != nil {
				t.Fatalf("51 张小图被协议层拒绝：%v", err)
			}
			marker := `"type":"image_url"`
			if format == FormatResponses {
				marker = `"type":"input_image"`
			} else if format == FormatAnthropicMessages {
				marker = `"type":"image"`
			}
			if got := strings.Count(string(wire.body), marker); got != 51 {
				t.Fatalf("协议请求丢失图片：%d", got)
			}
			input.Messages[0].Images = make([]ImagePart, 8)
			data := make([]byte, 1024*1024)
			for i := range input.Messages[0].Images {
				input.Messages[0].Images[i] = ImagePart{MimeType: "image/png", Data: data}
			}
			wire, err = adapter.prepare(p, input)
			if err != nil || len(wire.body) <= 8*1024*1024 || len(wire.body) > 16*1024*1024 {
				t.Fatalf("8 MiB 图片的 base64 请求未落在新 wire 预算内：%d %v", len(wire.body), err)
			}
		})
	}
}

func TestModelWireRequestByteLimit(t *testing.T) {
	p := testProfile("https://example.test/v1")
	text := strings.Repeat("x", 16*1024*1024-2)
	wire, err := prepareWire(p, "/chat/completions", text, false, nil)
	if err != nil || len(wire.body) != 16*1024*1024 {
		t.Fatalf("等于 16 MiB 的模型请求应放行：%d %v", len(wire.body), err)
	}
	if _, err = prepareWire(p, "/chat/completions", text+"x", false, nil); err == nil {
		t.Fatal("超过 16 MiB 一个字节的模型请求未拒绝")
	} else {
		requireCode(t, err, "model-request-too-large")
	}
}
