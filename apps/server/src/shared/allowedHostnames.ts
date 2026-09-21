/**
 * Host 允许名单：写请求的 Host 头必须解析到名单内的本机地址。Origin 与 Host 互相一致
 * 挡不住 DNS rebinding（攻击域名两头上自身一致），名单把可写的访问面钉死在本机回环；
 * web 的 vite.config 的 server.allowedHosts 引用同一份常量，使两道防线是一个显式决定。
 * 本文件保持零依赖纯常量：不 import hono、不 import node:*，让 vite.config 这类
 * 浏览器侧构建链也能安全解析它。
 */
export const ALLOWED_HOSTNAMES: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']
