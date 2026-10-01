package middleware

import (
	"net/http"
	"net/url"
	"strings"

	"elysian/server/internal/shared"
)

// 同源守卫（go-plan §3.5）：写方法（非 GET/HEAD）必须带 Origin 且 origin.host（小写
// 归一）== Host 头，且 Host 的 hostname ∈ shared.AllowedHostnames，否则 403
// {"error":"请求来源不允许"}；WS 升级专用版要求必须带 Origin（GET 也不放行）。守卫
// 在各域路由器内挂于 503 判定之后、读体之前。

// SameOrigin REST 同源判定（纯函数）：GET/HEAD 无副作用放行；写请求须 Origin 与 Host
// 一致且 Host 落在回环名单内（解析失败视为不匹配）。
func SameOrigin(r *http.Request) bool {
	method := strings.ToUpper(r.Method)
	if method == http.MethodGet || method == http.MethodHead {
		return true
	}
	return sameOriginStrict(r)
}

// SameOriginUpgrade WS 升级专用同源判定（纯函数，比 REST 的 GET 放行更严）：必须带
// Origin；Origin 的 host（含端口，小写归一）与 Host 头一致；Host 的 hostname 落在
// 回环允许名单内。Upgrade 是 GET，SameOrigin 拦不到，WS 路由需在升级前显式前置此判定。
func SameOriginUpgrade(r *http.Request) bool {
	return sameOriginStrict(r)
}

// sameOriginStrict 写请求与 WS 升级共用的严格同源判定。注意：Go 的 server 请求里
// Host 头在 r.Host 字段（r.Header 不含 Host），与 TS 读 host 头等价。
func sameOriginStrict(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	host := r.Host
	if origin == "" || host == "" {
		return false
	}
	originURL, err := url.Parse(origin)
	if err != nil {
		return false
	}
	if !strings.EqualFold(originURL.Host, host) {
		return false
	}
	return isAllowedHostname(host)
}

// isAllowedHostname 从 Host 头取 hostname（去端口、IPv6 保留方括号、大小写归一）；
// 解析失败视为不在名单。名单取值与 TS 版逐字一致（含 [::1] 原样带括号——URL 解析出的
// hostname 不带括号，故带括号的 IPv6 Host 与 TS 版一样不匹配）。
func isAllowedHostname(host string) bool {
	u, err := url.Parse("http://" + host)
	if err != nil {
		return false
	}
	hostname := strings.ToLower(u.Hostname())
	for _, allowed := range shared.AllowedHostnames {
		if hostname == allowed {
			return true
		}
	}
	return false
}

// SameOriginGuard 同源守卫中间件：跨源写请求一律 403；域路由把它挂在可用性判定
// （503）之后、读体之前。
func SameOriginGuard() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !SameOrigin(r) {
				shared.SendError(w, http.StatusForbidden, "请求来源不允许")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
