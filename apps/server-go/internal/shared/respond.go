package shared

import (
	"bytes"
	"encoding/json"
	"net/http"
)

// JSON 编码红线（go-plan §3.3）：全部 JSON 输出经 MarshalJSON——json.Encoder 加
// SetEscapeHTML(false)（不转义 <>&），结构体字段声明序即键序（对齐 TS JSON.stringify
// 的插入序）。logs 域的 bytes 列记账与所有逐字断言测试依赖此约定。
//
// json.Encoder 会追加换行符，这里裁掉，保证返回值与 TS JSON.stringify 逐字节一致。

// MarshalJSON 编码任意值为不转义 HTML 的 JSON 字节串。
func MarshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// errorBody 错误响应的固定形状：{"error":"<中文消息>"}。
type errorBody struct {
	Error string `json:"error"`
}

// SendJSON 以 application/json; charset=utf-8 写出状态码与 JSON 响应体。
func SendJSON(w http.ResponseWriter, status int, body any) {
	data, err := MarshalJSON(body)
	if err != nil {
		// 编码失败属于服务端构造响应的故障，回 500 纯文本，不再递归。
		http.Error(w, "响应 JSON 编码失败", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

// SendError 写出统一错误响应 {"error":"<message>"}；所有错误响应体恒为此形状。
func SendError(w http.ResponseWriter, status int, message string) {
	SendJSON(w, status, errorBody{Error: message})
}
