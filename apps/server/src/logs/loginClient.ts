import { isIP } from 'node:net'

/*
 * 登录日志的对端地址与归属地（纯函数）。
 *
 * 地址只认 TCP 对端：面板只监听回环，浏览器经本机（或 vite 代理）连上来，
 * 对端就是 127.0.0.1 / ::1。不读 X-Forwarded-For——回环上任何本机进程都能伪造它。
 * 归属地不查询外部地址库：回环标「本机」，RFC1918 / 链路本地 / IPv6 ULA 标「内网」，
 * 其余（含无法识别的字符串）标「未知」。
 */

const MAPPED_V4_PREFIX = '::ffff:'

/** 非法、缺失或带 zone id 的地址一律收成「未知」，不把客户端可控字符串写进 IP 列。 */
export function normalizePeerAddress(raw: string | undefined): string {
  if (raw === undefined) return '未知'
  const ip = raw.trim()
  if (ip.length === 0 || ip.includes('%')) return '未知'
  return isIP(ip) === 0 ? '未知' : ip
}

/**
 * 从 Hono 的 env 取 Bun server.requestIP。
 * `app.fetch(request, server)` 时 env 就是 server；包了一层 `{ server }` 时取内层。
 * 没有 server（vitest 的 app.request 不传第三参）或 requestIP 抛错时回「未知」。
 */
export function peerAddressFromEnv(env: unknown, request: Request): string {
  const server =
    env !== null && typeof env === 'object' && 'server' in env ? (env as { server: unknown }).server : env
  if (server === null || typeof server !== 'object' || !('requestIP' in server)) return '未知'
  const requestIP = (server as { requestIP: unknown }).requestIP
  if (typeof requestIP !== 'function') return '未知'
  try {
    const info = (requestIP as (req: Request) => { address?: unknown } | null)(request)
    return normalizePeerAddress(typeof info?.address === 'string' ? info.address : undefined)
  } catch {
    return '未知'
  }
}

/** IPv4 或 IPv4 映射地址（::ffff:a.b.c.d）的四段；不是 IPv4 时回 null。 */
function ipv4Parts(ip: string): readonly [number, number, number, number] | null {
  const lower = ip.toLowerCase()
  const v4 = isIP(ip) === 4 ? ip : lower.startsWith(MAPPED_V4_PREFIX) ? ip.slice(MAPPED_V4_PREFIX.length) : null
  if (v4 === null || isIP(v4) !== 4) return null
  const parts = v4.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return null
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!]
}

function isLoopback(ip: string): boolean {
  if (ip.toLowerCase() === '::1') return true
  const v4 = ipv4Parts(ip)
  return v4 !== null && v4[0] === 127
}

function isPrivate(ip: string): boolean {
  const v4 = ipv4Parts(ip)
  if (v4 !== null) {
    const [a, b] = v4
    if (a === 10 || a === 127) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }
  const lower = ip.toLowerCase()
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  return lower.startsWith('fe80:')
}

/** 归属地：本机 / 内网 / 未知。公网地址没有本地地址库，同样标未知。 */
export function loginLocationOf(ip: string): string {
  if (isLoopback(ip)) return '本机'
  if (isPrivate(ip)) return '内网'
  return '未知'
}
