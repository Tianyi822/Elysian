package model

import (
	"encoding/json"
	"strings"
)

// 协议与供应商分别配置；Agent/Worker 只依赖公开 Request/Response。
type protocolAdapter interface {
	prepare(Profile, Request) (preparedRequest, error)
}

type preparedRequest struct {
	endpoint string
	body     []byte
	headers  map[string]string
	decode   func([]byte) (Response, error)
}

type chatCompletionsProtocol struct{}
type anthropicMessagesProtocol struct{}
type responsesProtocol struct{}

func resolveProtocol(format string) (protocolAdapter, error) {
	switch format {
	case FormatChatCompletions:
		return chatCompletionsProtocol{}, nil
	case FormatAnthropicMessages:
		return anthropicMessagesProtocol{}, nil
	case FormatResponses:
		return responsesProtocol{}, nil
	default:
		return nil, problem(400, "invalid-profile", "模型 API 格式无效")
	}
}

func (chatCompletionsProtocol) prepare(p Profile, input Request) (preparedRequest, error) {
	wire, names, err := prepareRequest(p, input)
	if err != nil {
		return preparedRequest{}, err
	}
	if p.Provider == ProviderDeepSeek {
		wire.Thinking = &wireThinking{Type: "disabled"}
		if input.OnReasoning != nil && (input.ToolChoice == "" || input.ToolChoice == "auto" || input.ToolChoice == "none") {
			wire.Thinking.Type = "enabled"
		}
		if input.ReasoningLevel != "" {
			wire.Thinking.Type = "enabled"
			if ReasoningEffort(input.ReasoningLevel) == "none" {
				wire.Thinking.Type = "disabled"
				wire.ReasoningEffort = ""
			}
		}
	}
	return prepareWire(p, "/chat/completions", wire, false, func(body []byte) (Response, error) { return parseResponse(body, names, input.ToolChoice) })
}

func prepareWire(p Profile, path string, wire any, anthropic bool, decode func([]byte) (Response, error)) (preparedRequest, error) {
	body, err := json.Marshal(wire)
	if err != nil || len(body) > maxRequestBytes {
		return preparedRequest{}, problem(413, "model-request-too-large", "模型请求超过允许的大小")
	}
	base := strings.TrimRight(p.BaseURL, "/")
	// Anthropic 官方基址不含 /v1；同时允许已显式填写 /v1 的兼容服务。
	if anthropic && strings.HasSuffix(base, "/v1") {
		path = "/messages"
	}
	headers := map[string]string{}
	if anthropic {
		headers["anthropic-version"] = "2023-06-01"
		if p.Credential != "" {
			headers["x-api-key"] = p.Credential
		}
	} else if p.Credential != "" {
		headers["Authorization"] = "Bearer " + p.Credential
	}
	return preparedRequest{endpoint: base + path, body: body, headers: headers, decode: decode}, nil
}
