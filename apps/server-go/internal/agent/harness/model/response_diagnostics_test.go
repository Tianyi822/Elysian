package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestUnloadedToolRequiresCompletelyValidResponseAcrossProtocols(t *testing.T) {
	for _, format := range []string{FormatChatCompletions, FormatResponses, FormatAnthropicMessages} {
		for _, issue := range []string{"unloaded", "arguments", "duplicate-id", "usage", "truncated"} {
			t.Run(format+"/"+issue, func(t *testing.T) {
				args := `{}`
				id := "second"
				finish := "tool_calls"
				output := 1
				want := ToolNotLoadedCode
				switch issue {
				case "arguments":
					args = `[]`
					want = "model-tool-arguments-invalid"
				case "duplicate-id":
					id = "first"
					want = "model-tool-call-invalid"
				case "usage":
					output = -1
					want = "model-usage-invalid"
				case "truncated":
					finish = "length"
					want = "model-tool-output-truncated"
				}
				var body any
				names := []string{"SECRET_UNLOADED_TOOL", "visible"}
				ids := []string{"first", id}
				arguments := []string{`{"secret":"SECRET_ARGUMENT"}`, args}
				parse := parseResponse
				switch format {
				case FormatChatCompletions:
					calls := []wireCall{}
					for i := range names {
						calls = append(calls, wireCall{ID: ids[i], Type: "function", Function: wireFunction{Name: names[i], Arguments: arguments[i]}})
					}
					body = map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": nil, "tool_calls": calls}, "finish_reason": finish}}, "usage": map[string]any{"completion_tokens": output}}
				case FormatResponses:
					parse = parseResponsesResponse
					calls := []any{}
					for i := range names {
						calls = append(calls, map[string]any{"type": "function_call", "call_id": ids[i], "name": names[i], "arguments": arguments[i]})
					}
					wire := map[string]any{"object": "response", "status": "completed", "output": calls, "usage": map[string]any{"output_tokens": output}}
					if finish == "length" {
						wire["status"] = "incomplete"
						wire["incomplete_details"] = map[string]string{"reason": "max_output_tokens"}
					}
					body = wire
				case FormatAnthropicMessages:
					parse = parseAnthropicResponse
					calls := []any{}
					for i := range names {
						calls = append(calls, map[string]any{"type": "tool_use", "id": ids[i], "name": names[i], "input": json.RawMessage(arguments[i])})
					}
					stop := "tool_use"
					if finish == "length" {
						stop = "max_tokens"
					}
					body = map[string]any{"type": "message", "role": "assistant", "content": calls, "stop_reason": stop, "usage": map[string]any{"output_tokens": output}}
				}
				raw, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
				response, err := parse(raw, map[string]bool{"visible": true}, "auto")
				requireCode(t, err, want)
				if len(response.ToolCalls) != 0 || strings.Contains(err.Error(), "SECRET") {
					t.Fatal("被拒绝的调用或原始字段泄露")
				}
			})
		}
	}
}

func TestDeepSeekResourceFailureIsExplicit(t *testing.T) {
	_, err := parseResponse([]byte(`{"choices":[{"message":{"role":"assistant","content":null},"finish_reason":"insufficient_system_resource"}]}`), nil, "auto")
	requireCode(t, err, "model-resource-unavailable")
}
