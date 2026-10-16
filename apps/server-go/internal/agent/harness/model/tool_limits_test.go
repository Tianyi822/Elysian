package model

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func toolCatalog(count int) []Tool {
	tools := make([]Tool, count)
	for i := range tools {
		tools[i] = Tool{Name: fmt.Sprintf("platform_tool_%03d", i), Description: "读取已授权平台状态", Parameters: json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)}
	}
	return tools
}

func TestProtocolsTransmitFullPlatformToolCatalog(t *testing.T) {
	for _, protocol := range []struct{ provider, format string }{
		{ProviderOpenAICompatible, FormatChatCompletions},
		{ProviderDeepSeek, FormatChatCompletions},
		{ProviderZhipu, FormatChatCompletions},
		{ProviderDeepSeek, FormatAnthropicMessages},
		{ProviderOpenAICompatible, FormatResponses},
	} {
		for _, count := range []int{81, MaxToolDefinitions} {
			t.Run(fmt.Sprintf("%s/%s/%d", protocol.provider, protocol.format, count), func(t *testing.T) {
				catalog := toolCatalog(count)
				last := catalog[count-1].Name
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					var body struct {
						Tools []struct {
							Name     string `json:"name"`
							Function struct {
								Name string `json:"name"`
							} `json:"function"`
						} `json:"tools"`
					}
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					if len(body.Tools) != count {
						t.Errorf("tool catalog changed in transit: got %d, want %d", len(body.Tools), count)
					}
					for i, item := range body.Tools {
						name := item.Name
						if protocol.format == FormatChatCompletions {
							name = item.Function.Name
						}
						if i >= len(catalog) || name != catalog[i].Name {
							t.Errorf("tool %d changed in transit: %q", i, name)
						}
					}
					switch protocol.format {
					case FormatChatCompletions:
						fmt.Fprintf(w, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"last-tool","type":"function","function":{"name":%q,"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`, last)
					case FormatAnthropicMessages:
						fmt.Fprintf(w, `{"type":"message","role":"assistant","content":[{"type":"tool_use","id":"last-tool","name":%q,"input":{}}],"stop_reason":"tool_use"}`, last)
					case FormatResponses:
						fmt.Fprintf(w, `{"object":"response","status":"completed","output":[{"type":"function_call","call_id":"last-tool","name":%q,"arguments":"{}"}]}`, last)
					}
				}))
				defer server.Close()
				profile := testProfile(server.URL)
				profile.Provider, profile.APIFormat = protocol.provider, protocol.format
				request := testRequest()
				request.Tools, request.ToolChoice = catalog, "auto"
				response, err := NewClient(nil).Complete(context.Background(), profile, request)
				if err != nil {
					t.Fatal(err)
				}
				if len(response.ToolCalls) != 1 || response.ToolCalls[0].Name != last {
					t.Fatalf("last platform tool was not callable: %+v", response)
				}
			})
		}
	}
}

func TestProtocolsRejectOversizedToolCatalog(t *testing.T) {
	for _, format := range []string{FormatChatCompletions, FormatAnthropicMessages, FormatResponses} {
		t.Run(format, func(t *testing.T) {
			profile := testProfile("https://example.test")
			profile.APIFormat = format
			adapter, err := resolveProtocol(format)
			if err != nil {
				t.Fatal(err)
			}
			request := testRequest()
			request.Tools = toolCatalog(MaxToolDefinitions + 1)
			_, err = adapter.prepare(profile, request)
			requireCode(t, err, "model-tool-limit")
			request.Tools = request.Tools[:81]
			request.Tools[80].Parameters = json.RawMessage(`{"type":"array"}`)
			_, err = adapter.prepare(profile, request)
			requireCode(t, err, "invalid-model-request")
		})
	}
}

func TestLargerCatalogPreservesToolCallLimit(t *testing.T) {
	request := testRequest()
	request.Tools = toolCatalog(MaxToolDefinitions)
	for _, count := range []int{maxToolCalls, maxToolCalls + 1} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			calls := make([]ToolCall, count)
			messages := append([]Message{}, request.Messages...)
			for i := range calls {
				calls[i] = ToolCall{ID: fmt.Sprintf("call-%d", i), Name: request.Tools[i].Name, Arguments: json.RawMessage(`{}`)}
			}
			messages = append(messages, Message{Role: "assistant", ToolCalls: calls})
			for _, call := range calls {
				messages = append(messages, Message{Role: "tool", ToolCallID: call.ID, Content: `{}`})
			}
			input := request
			input.Messages = messages
			_, err := validateRequest(testProfile("https://example.test"), input)
			if count == maxToolCalls {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				requireCode(t, err, "invalid-model-request")
			}
			names, err := validateRequest(testProfile("https://example.test"), request)
			if err != nil {
				t.Fatal(err)
			}
			_, err = validateResponse(Response{ToolCalls: calls, FinishReason: "tool_calls"}, names, "auto")
			if count == maxToolCalls {
				if err != nil {
					t.Fatal(err)
				}
			} else {
				requireCode(t, err, "invalid-model-response")
			}
		})
	}
}
