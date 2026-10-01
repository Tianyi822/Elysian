package shared

// AllowedHostnames 写请求的 Host 头必须解析到的本机回环名单。Origin 与 Host 互相一致
// 挡不住 DNS rebinding（攻击域名两头上自身一致），名单把可写的访问面钉死在本机回环。
// web 侧 vite.config 的 ALLOWED_HOSTNAMES 是同一份清单，两道防线是一个显式决定，
// 含 IPv6 带括号原样。
var AllowedHostnames = []string{"127.0.0.1", "localhost", "[::1]"}
