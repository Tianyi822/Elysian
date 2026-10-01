package middleware

import (
	"context"
	"net/http"
	"strings"
)

// StripTailSlash 对 /api/* 路径剥单个尾部斜杠（go-plan §3.5）：/api/auth/login/ →
// /api/auth/login；/api/auth/login// 只剥一层得 /api/auth/login/；/ 不变；非 /api
// 路径原样放行（SPA 自理）。对齐 Hono strict:false 的自剥语义。
//
// 剥层发生时把剥前的原始路径存进请求上下文（InboundPath）：TS 侧没有剥斜杠中间件，
// requireSession 的鉴权豁免判定收到的是原始未归一路径、isAuthExemptPath 只自剥一层。
// 豁免判定若在本中间件已剥过的路径上再剥一层，/api/auth/login// 会被还原成豁免命中
// ——401 闸门不拦，请求落到路由层 404 而非 TS 的 401。判定必须以原始路径为准。
func StripTailSlash(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p := r.URL.Path; isAPIPath(p) && len(p) > 1 && strings.HasSuffix(p, "/") {
			r = r.WithContext(context.WithValue(r.Context(), inboundPathKey{}, p))
			r.URL.Path = strings.TrimSuffix(p, "/")
		}
		next.ServeHTTP(w, r)
	})
}

// inboundPathKey 上下文键：剥层前的原始请求路径（只有 StripTailSlash 写入）。
type inboundPathKey struct{}

// InboundPath 返回本请求被 StripTailSlash 剥层前的原始路径；未发生剥层时第二返回值
// 为 false（此时 r.URL.Path 本身就是原始路径，调用方直接用它）。
func InboundPath(r *http.Request) (string, bool) {
	p, ok := r.Context().Value(inboundPathKey{}).(string)
	return p, ok
}

// isAPIPath 判定路径属于 /api 域（/api 或 /api/...；/apifoo 不算）。
func isAPIPath(p string) bool {
	return p == "/api" || strings.HasPrefix(p, "/api/")
}
