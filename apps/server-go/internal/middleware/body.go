package middleware

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"elysian/server/internal/shared"
)

// DefaultJSONBodyMaxBytes 读体守卫的缺省上限：64 KiB（规则与配置都远小于它，超限一律
// 413，防大包拖垮解析与内存）。websites 域两端点用 256 KiB 上限，由该域自行传参。
const DefaultJSONBodyMaxBytes int64 = 64 * 1024

// ReadJSONBody 读体守卫（go-plan §3.5，TS readJsonBody 等价物）：
// Content-Type 前缀非 application/json → 415「Content-Type 必须为 application/json」；
// 申报 content-length 或实读累计超限 → 413「请求体过大」（先按申报直接拒、实读再累计，
// 防谎报长度绕过）；空体 → 400「请求体不能为空」；坏 JSON → 400「请求体不是有效 JSON」。
// maxBytes <= 0 时取缺省 64 KiB。
func ReadJSONBody(w http.ResponseWriter, r *http.Request, maxBytes int64) (any, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultJSONBodyMaxBytes
	}
	contentType := strings.ToLower(r.Header.Get("Content-Type"))
	if !strings.HasPrefix(contentType, "application/json") {
		return nil, &shared.EndpointGuardError{Status: http.StatusUnsupportedMediaType, Message: "Content-Type 必须为 application/json"}
	}
	if r.ContentLength > maxBytes {
		return nil, &shared.EndpointGuardError{Status: http.StatusRequestEntityTooLarge, Message: "请求体过大"}
	}
	chunks, received, err := readChunks(r, maxBytes)
	if err != nil {
		return nil, err
	}
	merged := make([]byte, received)
	offset := 0
	for _, chunk := range chunks {
		copy(merged[offset:], chunk)
		offset += len(chunk)
	}
	text := string(merged)
	if strings.TrimSpace(text) == "" {
		return nil, shared.InvalidRequest("请求体不能为空")
	}
	var parsed any
	if err := json.Unmarshal(merged, &parsed); err != nil {
		return nil, shared.InvalidRequest("请求体不是有效 JSON")
	}
	return parsed, nil
}

// readChunks 读完全部请求体并累计字节数，超限即 413。
func readChunks(r *http.Request, maxBytes int64) ([][]byte, int64, error) {
	var chunks [][]byte
	var received int64
	if r.Body == nil {
		return chunks, received, nil
	}
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Body.Read(buf)
		if n > 0 {
			received += int64(n)
			if received > maxBytes {
				return nil, 0, &shared.EndpointGuardError{Status: http.StatusRequestEntityTooLarge, Message: "请求体过大"}
			}
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			chunks = append(chunks, chunk)
		}
		if err == io.EOF {
			return chunks, received, nil
		}
		if err != nil {
			return nil, 0, err
		}
	}
}
