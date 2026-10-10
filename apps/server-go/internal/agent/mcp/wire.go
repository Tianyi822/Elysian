package mcp

import (
	"bytes"
	"encoding/base64"
	"encoding/json"

	"elysian/server/internal/agent/jsonvalue"
)

type incoming struct {
	ID     json.RawMessage
	Method string
	Result json.RawMessage
	Error  json.RawMessage
	Params json.RawMessage
}

func parseIncoming(raw []byte) (incoming, error) {
	if len(raw) > MaxMessageBytes {
		return incoming{}, protocolError()
	}
	canonical, err := jsonvalue.Canonical(raw)
	if err != nil {
		return incoming{}, protocolError()
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(canonical, &m) != nil || m == nil {
		return incoming{}, protocolError()
	}
	var version string
	if json.Unmarshal(m["jsonrpc"], &version) != nil || version != "2.0" {
		return incoming{}, protocolError()
	}
	out := incoming{ID: m["id"], Result: m["result"], Error: m["error"], Params: m["params"]}
	if method, ok := m["method"]; ok {
		if json.Unmarshal(method, &out.Method) != nil || !cleanText(out.Method, 256) || len(out.Result) > 0 || len(out.Error) > 0 {
			return incoming{}, protocolError()
		}
		if len(out.ID) > 0 && !validRPCID(out.ID) {
			return incoming{}, protocolError()
		}
		if len(out.Params) > 0 {
			if _, err := jsonvalue.Object(out.Params); err != nil {
				return incoming{}, protocolError()
			}
		}
		return out, nil
	}
	if !validRPCID(out.ID) || (len(out.Result) == 0) == (len(out.Error) == 0) {
		return incoming{}, protocolError()
	}
	if len(out.Result) > 0 {
		if _, err := jsonvalue.Object(out.Result); err != nil {
			return incoming{}, protocolError()
		}
	}
	if len(out.Error) > 0 {
		var e struct {
			Code    *int    `json:"code"`
			Message *string `json:"message"`
		}
		if json.Unmarshal(out.Error, &e) != nil || e.Message == nil || e.Code == nil {
			return incoming{}, protocolError()
		}
	}
	return out, nil
}
func validRPCID(raw json.RawMessage) bool {
	v, err := jsonvalue.Decode(raw)
	if err != nil {
		return false
	}
	switch n := v.(type) {
	case string:
		return cleanText(n, 200)
	case json.Number:
		return len(n.String()) <= 200
	}
	return false
}
func responseFor(m incoming, id string) (json.RawMessage, error) {
	var got string
	if json.Unmarshal(m.ID, &got) != nil || got != id || m.Method != "" {
		return nil, protocolError()
	}
	if len(m.Error) > 0 {
		return nil, problem(502, "mcp-remote-error", "MCP 服务拒绝了请求，错误正文未公开")
	}
	return m.Result, nil
}
func reverseReply(m incoming) []byte {
	b, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": "客户端不支持服务器发起的请求"}})
	return b
}
func changedMethod(method string) bool {
	return method == "notifications/tools/list_changed" || method == "notifications/resources/list_changed" || method == "notifications/prompts/list_changed"
}

func validateBlocks(blocks []json.RawMessage) error {
	if len(blocks) > MaxContentBlocks {
		return protocolError()
	}
	for _, raw := range blocks {
		if len(raw) > MaxMessageBytes {
			return protocolError()
		}
		var block map[string]json.RawMessage
		if json.Unmarshal(raw, &block) != nil || block == nil {
			return protocolError()
		}
		var kind string
		if json.Unmarshal(block["type"], &kind) != nil {
			return protocolError()
		}
		switch kind {
		case "text":
			var text string
			if !stringField(block["text"], &text) {
				return protocolError()
			}
		case "image", "audio":
			var data, mime string
			if !stringField(block["data"], &data) || !stringField(block["mimeType"], &mime) || !cleanText(mime, 256) {
				return protocolError()
			}
			if _, err := base64.StdEncoding.Strict().DecodeString(data); err != nil {
				return protocolError()
			}
		case "resource":
			if validateResource(block["resource"]) != nil {
				return protocolError()
			}
		case "resource_link":
			var r Resource
			if json.Unmarshal(raw, &r) != nil || !cleanText(r.URI, 4096) || !cleanText(r.Name, 256) {
				return protocolError()
			}
		default:
			return protocolError()
		}
	}
	return nil
}
func validateResource(raw json.RawMessage) error {
	var r map[string]json.RawMessage
	if json.Unmarshal(raw, &r) != nil || r == nil {
		return protocolError()
	}
	var uri string
	if json.Unmarshal(r["uri"], &uri) != nil || !cleanText(uri, 4096) {
		return protocolError()
	}
	text, hasText := r["text"]
	blob, hasBlob := r["blob"]
	if hasText == hasBlob {
		return protocolError()
	}
	if hasText {
		var v string
		if !stringField(text, &v) {
			return protocolError()
		}
	} else {
		var v string
		if !stringField(blob, &v) {
			return protocolError()
		}
		if _, err := base64.StdEncoding.Strict().DecodeString(v); err != nil {
			return protocolError()
		}
	}
	if raw, ok := r["mimeType"]; ok {
		var mime string
		if json.Unmarshal(raw, &mime) != nil || !cleanText(mime, 256) {
			return protocolError()
		}
	}
	return nil
}
func stringField(raw json.RawMessage, target *string) bool {
	return len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, target) == nil
}
func marshalRequest(req wireRequest) ([]byte, error) {
	b, err := json.Marshal(req)
	if err != nil || len(b) > MaxMessageBytes {
		return nil, problem(413, "mcp-request-too-large", "MCP 请求超过允许大小")
	}
	if _, err = jsonvalue.Canonical(b); err != nil {
		return nil, problem(400, "invalid-mcp-request", "MCP 请求格式无效")
	}
	return bytes.TrimSpace(b), nil
}
