package model

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"elysian/server/internal/agent/jsonvalue"
)

// 思考与回答作为展示增量；工具参数必须等待完整终帧并通过原有解码器校验。
// limit 是本次请求的原始响应上限（按输出上限放大，含分帧开销），超限即失败。
func (c *httpClient) stream(ctx context.Context, req *http.Request, format string, decode func([]byte) (Response, error), emit, emitContent func(string), limit int) (Response, error) {
	response, err := c.client.Do(req)
	if err != nil {
		return Response{}, requestError(ctx, err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		return Response{}, problem(502, "model-redirect-refused", "模型服务要求跳转，已阻止请求以保护凭据")
	}
	if response.StatusCode != http.StatusOK {
		switch response.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			return Response{}, problem(502, "model-auth-failed", "模型服务鉴权失败，请检查配置凭据")
		case http.StatusTooManyRequests:
			return Response{}, problem(502, "model-rate-limited", "模型服务请求受到限流，请稍后重试")
		default:
			return Response{}, problem(502, "model-http-failed", "模型服务返回异常状态，请检查模型服务")
		}
	}
	reader := &io.LimitedReader{R: response.Body, N: int64(limit) + 1}
	if !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		raw, err := io.ReadAll(reader)
		if err != nil {
			return Response{}, requestError(ctx, err)
		}
		if reader.N == 0 {
			return Response{}, problem(502, "model-response-too-large", "模型响应超过允许的大小")
		}
		result, err := decode(raw)
		if err == nil {
			if emit != nil {
				emit(result.Reasoning)
			}
			if emitContent != nil {
				emitContent(result.Content)
			}
		}
		return result, err
	}
	state := streamResponse{format: format, emit: emit, emitContent: emitContent, message: map[string]any{"role": "assistant", "content": ""}, openBlock: -1}
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), limit+1)
	var data []string
	consume := func() error {
		if len(data) == 0 {
			return nil
		}
		frame := strings.Join(data, "\n")
		data = nil
		return state.consume(frame)
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if err := consume(); err != nil {
				return Response{}, err
			}
			if state.done {
				break
			}
		} else if strings.HasPrefix(line, "data:") {
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if reader.N == 0 {
		return Response{}, problem(502, "model-response-too-large", "模型响应超过允许的大小")
	}
	if err := scanner.Err(); err != nil {
		return Response{}, requestError(ctx, err)
	}
	if err := consume(); err != nil {
		return Response{}, err
	}
	if !state.done {
		return Response{}, invalidResponse()
	}
	raw, err := state.body()
	if err != nil {
		return Response{}, err
	}
	return decode(raw)
}

type streamResponse struct {
	format         string
	emit           func(string)
	emitContent    func(string)
	done           bool
	message        map[string]any
	calls          []wireCall
	finish         string
	usage          json.RawMessage
	final          json.RawMessage
	blocks         []map[string]any
	blockInput     string
	openBlock      int
	anthropic      map[string]any
	anthropicUsage map[string]any
}

func (s *streamResponse) text(delta string) {
	if delta != "" && s.emit != nil {
		s.emit(delta)
	}
}

func (s *streamResponse) content(delta string) {
	if delta != "" && s.emitContent != nil {
		s.emitContent(delta)
	}
}

func (s *streamResponse) consume(data string) error {
	if s.done {
		return invalidResponse()
	}
	if data == "[DONE]" {
		if s.format != FormatChatCompletions || s.finish == "" {
			return invalidResponse()
		}
		s.done = true
		return nil
	}
	raw, err := jsonvalue.Canonical([]byte(data))
	if err != nil {
		return invalidResponse()
	}
	switch s.format {
	case FormatChatCompletions:
		var chunk struct {
			Error   json.RawMessage `json:"error"`
			Choices []struct {
				Index int `json:"index"`
				Delta struct {
					Role      string `json:"role"`
					Content   string `json:"content"`
					Reasoning string `json:"reasoning_content"`
					Calls     []struct {
						Index    int          `json:"index"`
						ID       string       `json:"id"`
						Type     string       `json:"type"`
						Function wireFunction `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				Finish *string `json:"finish_reason"`
			} `json:"choices"`
			Usage json.RawMessage `json:"usage"`
		}
		if json.Unmarshal(raw, &chunk) != nil || len(chunk.Choices) > 1 || (len(chunk.Error) != 0 && string(chunk.Error) != "null") {
			return invalidResponse()
		}
		if len(chunk.Usage) != 0 && string(chunk.Usage) != "null" {
			s.usage = chunk.Usage
		}
		if len(chunk.Choices) == 0 {
			return nil
		}
		choice := chunk.Choices[0]
		if choice.Index != 0 || s.finish != "" || (choice.Delta.Role != "" && choice.Delta.Role != "assistant") {
			return invalidResponse()
		}
		s.message["content"] = s.message["content"].(string) + choice.Delta.Content
		previous, _ := s.message["reasoning_content"].(string)
		s.message["reasoning_content"] = previous + choice.Delta.Reasoning
		s.text(choice.Delta.Reasoning)
		s.content(choice.Delta.Content)
		for _, delta := range choice.Delta.Calls {
			if delta.Index < 0 || delta.Index > len(s.calls) || delta.Index >= maxToolCalls {
				return invalidResponse()
			}
			if delta.Index == len(s.calls) {
				s.calls = append(s.calls, wireCall{})
			}
			call := &s.calls[delta.Index]
			if delta.ID != "" {
				if call.ID != "" && call.ID != delta.ID {
					return invalidResponse()
				}
				call.ID = delta.ID
			}
			if delta.Type != "" {
				if delta.Type != "function" {
					return invalidResponse()
				}
				call.Type = delta.Type
			}
			call.Function.Name += delta.Function.Name
			call.Function.Arguments += delta.Function.Arguments
		}
		if choice.Finish != nil {
			s.finish = *choice.Finish
		}
	case FormatResponses:
		var event struct {
			Type     string          `json:"type"`
			Delta    string          `json:"delta"`
			Response json.RawMessage `json:"response"`
		}
		if json.Unmarshal(raw, &event) != nil {
			return invalidResponse()
		}
		switch event.Type {
		case "response.output_text.delta":
			s.content(event.Delta)
		case "response.reasoning_summary_text.delta":
			s.text(event.Delta)
		case "response.reasoning_summary_part.done":
			s.text("\n")
		case "response.completed", "response.incomplete":
			if len(event.Response) == 0 {
				return invalidResponse()
			}
			s.final, s.done = event.Response, true
		case "error", "response.failed":
			return invalidResponse()
		}
	case FormatAnthropicMessages:
		var event struct {
			Type    string         `json:"type"`
			Index   int            `json:"index"`
			Message map[string]any `json:"message"`
			Block   map[string]any `json:"content_block"`
			Delta   struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				Thinking string `json:"thinking"`
				JSON     string `json:"partial_json"`
				Stop     string `json:"stop_reason"`
			} `json:"delta"`
			Usage map[string]any `json:"usage"`
		}
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber() // 初始 tool_use.input 中的大整数也不能经过 float64。
		if decoder.Decode(&event) != nil {
			return invalidResponse()
		}
		switch event.Type {
		case "message_start":
			if s.anthropic != nil || event.Message == nil || event.Message["type"] != "message" || event.Message["role"] != "assistant" {
				return invalidResponse()
			}
			s.anthropic = event.Message
			s.anthropicUsage, _ = event.Message["usage"].(map[string]any)
			if s.anthropicUsage == nil {
				s.anthropicUsage = map[string]any{}
			}
		case "content_block_start":
			if s.anthropic == nil || s.finish != "" || s.openBlock != -1 || event.Index != len(s.blocks) || event.Block == nil {
				return invalidResponse()
			}
			s.blocks = append(s.blocks, event.Block)
			s.openBlock, s.blockInput = event.Index, ""
			if event.Block["type"] == "text" {
				if value, ok := event.Block["text"].(string); ok {
					s.content(value)
				}
			}
			if event.Block["type"] == "thinking" {
				if value, ok := event.Block["thinking"].(string); ok {
					s.text(value)
				}
			}
		case "content_block_delta":
			if s.openBlock == -1 || event.Index != s.openBlock {
				return invalidResponse()
			}
			block := s.blocks[event.Index]
			switch event.Delta.Type {
			case "text_delta":
				if block["type"] != "text" {
					return invalidResponse()
				}
				previous, _ := block["text"].(string)
				block["text"] = previous + event.Delta.Text
				s.content(event.Delta.Text)
			case "thinking_delta":
				if block["type"] != "thinking" {
					return invalidResponse()
				}
				previous, _ := block["thinking"].(string)
				block["thinking"] = previous + event.Delta.Thinking
				s.text(event.Delta.Thinking)
			case "input_json_delta":
				if block["type"] != "tool_use" {
					return invalidResponse()
				}
				s.blockInput += event.Delta.JSON
			case "signature_delta": // 签名不显示，也不保存。
				if block["type"] != "thinking" {
					return invalidResponse()
				}
			default:
				return invalidResponse()
			}
		case "content_block_stop":
			if s.openBlock == -1 || event.Index != s.openBlock {
				return invalidResponse()
			}
			if s.blockInput != "" {
				canonical, err := jsonvalue.Canonical([]byte(s.blockInput))
				if err != nil {
					return invalidResponse()
				}
				s.blocks[event.Index]["input"] = json.RawMessage(canonical)
			}
			s.openBlock, s.blockInput = -1, ""
		case "message_delta":
			if s.anthropic == nil || s.openBlock != -1 || s.finish != "" {
				return invalidResponse()
			}
			s.finish = event.Delta.Stop
			for key, value := range event.Usage {
				s.anthropicUsage[key] = value
			}
		case "message_stop":
			if s.anthropic == nil || s.openBlock != -1 || s.finish == "" {
				return invalidResponse()
			}
			s.done = true
		case "ping":
		default:
			return invalidResponse()
		}
	default:
		return invalidResponse()
	}
	return nil
}

func (s *streamResponse) body() ([]byte, error) {
	switch s.format {
	case FormatChatCompletions:
		if len(s.calls) > 0 {
			s.message["tool_calls"] = s.calls
		}
		return json.Marshal(map[string]any{"choices": []any{map[string]any{"index": 0, "message": s.message, "finish_reason": s.finish}}, "usage": s.usage})
	case FormatResponses:
		return s.final, nil
	case FormatAnthropicMessages:
		s.anthropic["content"], s.anthropic["stop_reason"], s.anthropic["usage"] = s.blocks, s.finish, s.anthropicUsage
		return json.Marshal(s.anthropic)
	}
	return nil, invalidResponse()
}
