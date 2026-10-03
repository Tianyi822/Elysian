package logs

import (
	"net"
	"net/http"

	"elysian/server/internal/shared"
	"strings"
)

/*
 * 登录日志的对端地址与归属地（loginClient.ts 等价物，纯函数）。
 *
 * 地址只认 TCP 对端（Go 侧即 RemoteAddr 剥端口）：面板只监听回环，浏览器经本机
 * （或 vite 代理）连上来。不读 X-Forwarded-For——回环上任何本机进程都能伪造它。
 * 归属地不查外部地址库：回环「本机」、RFC1918/链路本地/IPv6 ULA「内网」、其余「未知」。
 */

const mappedV4Prefix = "::ffff:"

// unknownAddress 非法、缺失或带 zone id 的地址一律收成的固定值。
const unknownAddress = "未知"

// NormalizePeerAddress 归一对端地址：trim 后为空、含 %（zone id）或不是 IP → 未知；
// 其余原样（IPv4/IPv6 均可，::ffff:10.0.0.8 保留原形）。
func NormalizePeerAddress(raw string) string {
	ip := trimJS(raw)
	if ip == "" || strings.Contains(ip, "%") {
		return unknownAddress
	}
	if net.ParseIP(ip) == nil {
		return unknownAddress
	}
	return ip
}

// PeerAddressFromRequest 从请求取 TCP 对端地址（Bun server.requestIP 的 Go 对应物）：
// RemoteAddr 剥端口（IPv6 带方括号由 SplitHost 处理），失败回「未知」。
func PeerAddressFromRequest(r *http.Request) string {
	if r == nil || r.RemoteAddr == "" {
		return unknownAddress
	}
	host, _, err := net.SplitHostPort(shared.PanelPeerAddress(r))
	if err != nil {
		return unknownAddress
	}
	return NormalizePeerAddress(host)
}

// ipv4Parts IPv4 或 IPv4 映射地址（::ffff:a.b.c.d）的四段；不是 IPv4 时 false。
func ipv4Parts(ip string) ([4]byte, bool) {
	var parts [4]byte
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return parts, false
	}
	v4 := parsed.To4()
	if v4 == nil {
		return parts, false
	}
	copy(parts[:], v4)
	return parts, true
}

// isLoopbackIP 回环判定：字符串 "::1" 或 IPv4/映射 IPv4 的 127 段。
func isLoopbackIP(ip string) bool {
	if strings.EqualFold(ip, "::1") {
		return true
	}
	v4, ok := ipv4Parts(ip)
	return ok && v4[0] == 127
}

// isPrivateIP 私网判定：v4 走四段（10/8、127/8、172.16-31、192.168/16、169.254/16）；
// v6 按字符串前缀（fc/fd 即 fc00::/7、fe80:），与 TS 逐字同口径。
func isPrivateIP(ip string) bool {
	if v4, ok := ipv4Parts(ip); ok {
		a, b := v4[0], v4[1]
		if a == 10 || a == 127 {
			return true
		}
		if a == 172 && b >= 16 && b <= 31 {
			return true
		}
		if a == 192 && b == 168 {
			return true
		}
		if a == 169 && b == 254 {
			return true
		}
		return false
	}
	lower := strings.ToLower(ip)
	if strings.HasPrefix(lower, "fc") || strings.HasPrefix(lower, "fd") {
		return true
	}
	return strings.HasPrefix(lower, "fe80:")
}

// LoginLocationOf 归属地：本机 / 内网 / 未知（公网与无法识别的同样标未知）。
func LoginLocationOf(ip string) string {
	if isLoopbackIP(ip) {
		return "本机"
	}
	if isPrivateIP(ip) {
		return "内网"
	}
	return unknownAddress
}
