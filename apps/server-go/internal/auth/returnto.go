package auth

import (
	"net/url"
	"strings"

	"elysian/server/internal/shared"
)

// SSO returnTo 裁决（returnTo.ts 等价物）：只认「origin 精确落在允许名单里」的绝对
// http/https 地址，且 hostname 必须仍在回环名单内（纵深：名单被误写进外部域名时仍跳
// 不出去）。通过回 WHATWG 归一化后的 href——归一化只发生一次，裁决所见即浏览器所去。
//
// Go net/url 不是 WHATWG 解析器，本文件自实现等价归一（auth 盘点 §6.2 钉住的差异点）：
//   - 反斜杠当路径分隔符（special scheme）：解析前把 `\` 归一为 `/`，主机因此停在
//     名单内的地址上（`http://127.0.0.1:5173\@evil.example` 的主机仍是 127.0.0.1:5173）；
//   - 默认端口吞并：http:80 / https:443 在 origin 计算里被吞掉（WHATWG url.origin 语义）；
//   - 协议与主机小写化；IPv6 hostname 保留方括号（shared.AllowedHostnames 的 `[::1]` 同形）；
//   - userinfo 伪装（`http://127.0.0.1:5173@evil.example/`）天然被 net/url 拆出 User，
//     Host 取 @ 之后的 evil.example，origin 因此不在名单内。
//
// 已知与 WHATWG 的残余差异（测试锚点不覆盖）：query/fragment 内的 `\` 也被本实现
// 归一为 `/`（WHATWG 只在 path state 折叠）；IPv6 地址不做零组压缩（`[0:0:0:0:0:0:0:1]`
// 不会被折叠成 `[::1]`，按原样小写比较）。

// parseLoopbackURL 以 WHATWG 等价归一解析一个绝对 http/https 地址；失败回 false。
func parseLoopbackURL(raw string) (scheme, host, hostname string, ok bool) {
	normalized := strings.ReplaceAll(raw, "\\", "/")
	u, err := url.Parse(normalized)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", "", "", false
	}
	scheme = strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", "", "", false
	}
	host = strings.ToLower(u.Host)
	// 默认端口吞并：WHATWG 把 http:80 / https:443 从 origin 里吞掉。
	switch {
	case scheme == "http" && strings.HasSuffix(host, ":80"):
		host = strings.TrimSuffix(host, ":80")
	case scheme == "https" && strings.HasSuffix(host, ":443"):
		host = strings.TrimSuffix(host, ":443")
	}
	// hostname 从小写 host 提取；IPv6 保留方括号，与 shared.AllowedHostnames 同形。
	hostname = extractHostname(host)
	return scheme, host, hostname, true
}

// extractHostname 从小写 host 取 hostname：IPv6 保留方括号原样（[::1]），其余去端口。
func extractHostname(host string) string {
	if strings.HasPrefix(host, "[") {
		if end := strings.Index(host, "]"); end >= 0 {
			return host[:end+1]
		}
		return host
	}
	if i := strings.LastIndex(host, ":"); i >= 0 {
		return host[:i]
	}
	return host
}

// isAllowedLoopbackHostname hostname 是否落在回环名单内（大小写已归一）。
func isAllowedLoopbackHostname(hostname string) bool {
	for _, allowed := range shared.AllowedHostnames {
		if hostname == allowed {
			return true
		}
	}
	return false
}

// AdjudicateReturnTo 裁决回跳地址：通过回归一化 href（指针非 nil）；任何一条不过回 nil。
// 长度按 UTF-16 计（与 TS raw.trim().length 同口径），超长不交给 URL 解析。
func AdjudicateReturnTo(raw string, allowed []string) *string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || utf16Length(trimmed) > ReturnToMaxLength {
		return nil
	}
	scheme, host, hostname, ok := parseLoopbackURL(trimmed)
	if !ok {
		return nil
	}
	origin := scheme + "://" + host
	if !containsExact(allowed, origin) {
		return nil
	}
	// 纵深：名单被人写成外部域名时仍然跳不出去（returnOriginRegistry 写入侧同一条校验）。
	if !isAllowedLoopbackHostname(hostname) {
		return nil
	}
	href := origin + trimmedPathAndAfter(trimmed)
	return &href
}

// containsExact 精确匹配（名单里的条目已是归一 origin）。
func containsExact(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}
	return false
}

// trimmedPathAndAfter 从归一化后的原始串取 path/query/fragment 部分：跳过 authority
// 后，从第一个 `/`、`?` 或 `#` 起原样保留；`?`/`#` 打头（空 path）与只有 authority 时
// 补一个 `/`（WHATWG 空 path 序列化为 `/`）。原样保留意味着 userinfo（若有）不出现在
// href——WHATWG 会保留，但 userinfo 只可能伴随名单外主机，测试锚点不覆盖该差异。
func trimmedPathAndAfter(normalized string) string {
	marker := "://"
	i := strings.Index(normalized, marker)
	if i < 0 {
		return "/"
	}
	rest := normalized[i+len(marker):]
	for j := 0; j < len(rest); j++ {
		switch rest[j] {
		case '/':
			return rest[j:]
		case '?', '#':
			return "/" + rest[j:]
		}
	}
	return "/"
}

// NormalizeOrigin 白名单单项校验（returnOriginRegistry.normalizeOrigin 等价物）：
// 单项合法 = 纯 origin 形式——可解析、协议 http/https、host 在回环名单、且与归一后
// 的 origin 逐字相等（等价于「不带 path、不带尾斜杠、已小写」；默认端口被吞并的条目
// 如 `http://127.0.0.1:80` 也丢弃，因为它在裁决处永远匹配不上）。不合法回 false。
func NormalizeOrigin(entry string) bool {
	scheme, host, hostname, ok := parseLoopbackURL(entry)
	if !ok {
		return false
	}
	if !isAllowedLoopbackHostname(hostname) {
		return false
	}
	return scheme+"://"+host == entry
}
