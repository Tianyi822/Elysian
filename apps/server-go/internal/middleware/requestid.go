// Package middleware 是公共层请求防护原语（go-plan §3.4-§3.7）：请求 ID、剥尾斜杠、
// 同源守卫、读体守卫、错误映射与 WS 升级。全局注册次序（internal/app）：
// RequestID → StripTailSlash → OperationAudit(logs) → RequireSession(auth) → 各域子路由。
package middleware

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/http"
)

// RequestIDHeader 请求 ID 的进出处请求/响应头名。
const RequestIDHeader = "X-Request-Id"

// requestIDMaxLength 回显外部请求 ID 的长度上限。
const requestIDMaxLength = 128

type requestIDKey struct{}

// RequestID 请求 ID 中间件（go-plan §3.4，Go 侧新增的进程内诊断设施，不改变任何既有
// 契约）：请求头 X-Request-Id 存在且 ≤128 个安全可打印字符则回显，否则生成 16 位 hex；
// 响应头写 X-Request-Id。挂载在最外层（先于剥斜杠与审计）。请求 ID不进入任何持久化
// 日志字段、不出现在任何错误消息文本中，仅用于 stderr 诊断与 goroutine 关联。
func RequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := sanitizeRequestID(r.Header.Get(RequestIDHeader))
		if id == "" {
			id = newRequestID()
		}
		w.Header().Set(RequestIDHeader, id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

// RequestIDFrom 取当前请求的请求 ID（未挂中间件时为空串）。
func RequestIDFrom(ctx context.Context) string {
	if v, ok := ctx.Value(requestIDKey{}).(string); ok {
		return v
	}
	return ""
}

// sanitizeRequestID 校验外部回显：非空、长度 ≤128、全部为安全可打印字符
// （0x21-0x7E，可见且不含空白）；不合法回空串改为自行生成。
func sanitizeRequestID(v string) string {
	if v == "" || len(v) > requestIDMaxLength {
		return ""
	}
	for i := 0; i < len(v); i++ {
		if v[i] < 0x21 || v[i] > 0x7E {
			return ""
		}
	}
	return v
}

// newRequestID 生成 16 位 hex（8 随机字节）；熵源失败属宿主故障，panic 收口。
func newRequestID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic("生成请求 ID 失败：" + err.Error())
	}
	return hex.EncodeToString(b[:])
}
