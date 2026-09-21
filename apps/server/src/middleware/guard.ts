import type { ErrorHandler, MiddlewareHandler } from 'hono'
import { ALLOWED_HOSTNAMES } from '../shared/allowedHostnames.ts'
import { EndpointGuardError, InvalidRequestError } from '../shared/errors.ts'

/*
 * 端点守卫：安全区真实端点共享的请求防护原语——写请求同源校验、JSON 请求体读取
 * （Content-Type 与 64 KiB 体积双拦）与 JSON 响应写出。防火墙端点在用，SSH 与用户
 * 管理端点复用同一模块；这里只做防护与读写形状，不含业务路由，不执行任何真实命令。
 */

// 共享常量与错误类从这里统一出口，消费方（路由、服务、vite.config）不必各自深入 shared。
export { ALLOWED_HOSTNAMES } from '../shared/allowedHostnames.ts'
export { EndpointGuardError, InvalidRequestError, invalidRequest } from '../shared/errors.ts'

export function sendJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

export function sendError(status: number, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return sendJson(status, { error: message })
}

/** 请求体上限：64 KiB。规则与配置都远小于它，超限一律 413，防大包拖垮解析与内存。 */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** 从 Host 头取 hostname（去端口、IPv6 保留方括号、大小写归一）；解析失败视为不在名单。 */
function isAllowedHostname(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase()
    return ALLOWED_HOSTNAMES.includes(hostname)
  } catch {
    return false
  }
}

/** 同源校验：写请求必须带 Origin 且其 host 与 Host 头一致（大小写归一，解析失败视为不匹配），Host 还须落在允许名单内；GET/HEAD 无副作用不校验。 */
export function isSameOrigin(req: Request): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = req.headers.get('origin')
  const host = req.headers.get('host')
  if (!origin || !host) return false
  try {
    if (new URL(origin).host.toLowerCase() !== host.toLowerCase()) return false
  } catch {
    return false
  }
  return isAllowedHostname(host)
}

/** 同源守卫中间件：跨源写请求一律 403；安全区路由把它挂在可用性判定（503）之后、读体之前。 */
export function sameOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (!isSameOrigin(c.req.raw)) {
      return sendJson(403, { error: '请求来源不允许' })
    }
    await next()
  }
}

export async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = (req.headers.get('content-type') ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new EndpointGuardError(415, 'Content-Type 必须为 application/json')
  }
  // 先按申报的 content-length 直接拒；实读再累计字节数，防谎报长度绕过。
  const declaredLength = Number(req.headers.get('content-length'))
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    throw new EndpointGuardError(413, '请求体过大')
  }
  const chunks: Uint8Array[] = []
  let receivedBytes = 0
  if (req.body) {
    const reader = req.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      receivedBytes += value.byteLength
      if (receivedBytes > MAX_JSON_BODY_BYTES) {
        throw new EndpointGuardError(413, '请求体过大')
      }
      chunks.push(value)
    }
  }
  const merged = new Uint8Array(receivedBytes)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(merged)
  if (!text.trim()) throw new InvalidRequestError(400, '请求体不能为空')
  try {
    return JSON.parse(text)
  } catch {
    throw new InvalidRequestError(400, '请求体不是有效 JSON')
  }
}

/**
 * 路由层错误映射：EndpointGuardError/InvalidRequestError 按自带 status 返回 4xx，
 * 其余系统侧错误一律 500；响应体统一 { error: 中文消息 }。挂到 app.onError。
 */
export const endpointErrorHandler: ErrorHandler = (error) => {
  if (error instanceof EndpointGuardError || error instanceof InvalidRequestError) {
    return sendError(error.status, error)
  }
  return sendError(500, error)
}
