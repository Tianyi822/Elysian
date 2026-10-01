package shared

// AllowedHostnames 写请求的 Host 头必须解析到的本机回环名单（TS allowedHostnames.ts
// 等价物）。Origin 与 Host 互相一致挡不住 DNS rebinding（攻击域名两头上自身一致），
// 名单把可写的访问面钉死在本机回环。取值与 TS 版逐字一致，含 IPv6 带括号原样。
var AllowedHostnames = []string{"127.0.0.1", "localhost", "[::1]"}
