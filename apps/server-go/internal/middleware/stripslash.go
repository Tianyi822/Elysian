package middleware

import (
	"net/http"
	"strings"
)

// StripTailSlash 对 /api/* 路径剥单个尾部斜杠（go-plan §3.5）：/api/auth/login/ →
// /api/auth/login；/api/auth/login// 只剥一层得 /api/auth/login/（与鉴权豁免判定
// 「剥单个尾斜杠后精确匹配」同口径）；/ 不变；非 /api 路径原样放行（SPA 自理）。
// 对齐 Hono strict:false 的自剥语义。
func StripTailSlash(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if p := r.URL.Path; isAPIPath(p) && len(p) > 1 && strings.HasSuffix(p, "/") {
			r.URL.Path = strings.TrimSuffix(p, "/")
		}
		next.ServeHTTP(w, r)
	})
}

// isAPIPath 判定路径属于 /api 域（/api 或 /api/...；/apifoo 不算）。
func isAPIPath(p string) bool {
	return p == "/api" || strings.HasPrefix(p, "/api/")
}
