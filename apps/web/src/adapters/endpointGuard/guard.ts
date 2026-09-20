import type { IncomingMessage, ServerResponse } from 'node:http'

/*
 * 端点守卫：真实主机端点共享的请求防护原语——写请求同源校验、JSON 请求体读取
 * （Content-Type 与 64 KiB 体积双拦）与 JSON 响应写出。防火墙端点在用，SSH 端点
 * 复用同一模块；这里只做防护与读写形状，不含业务路由，不执行任何真实命令。
 */

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export function sendError(res: ServerResponse, status: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, status, { error: message })
}

/** 请求体上限：64 KiB。规则与配置都远小于它，超限一律 413，防大包拖垮解析与内存。 */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** 带状态码的错误：端点守卫（同源、Content-Type、体积上限）失败时抛出，端点 handler 按 status 映射响应。 */
export class EndpointGuardError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** 同源校验：写请求必须带 Origin 且其 host 与 Host 头一致（大小写归一，解析失败视为不匹配）；GET/HEAD 无副作用不校验。 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = req.headers.origin
  const host = req.headers.host
  if (!origin || !host) return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const contentType = (req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new EndpointGuardError(415, 'Content-Type 必须为 application/json')
  }
  // 先按申报的 content-length 直接拒；实读再累计字节数，防谎报长度绕过。
  const declaredLength = Number(req.headers['content-length'])
  if (declaredLength > MAX_JSON_BODY_BYTES) {
    throw new EndpointGuardError(413, '请求体过大')
  }
  const chunks: Buffer[] = []
  let receivedBytes = 0
  for await (const chunk of req) {
    receivedBytes += (chunk as Buffer).length
    if (receivedBytes > MAX_JSON_BODY_BYTES) {
      throw new EndpointGuardError(413, '请求体过大')
    }
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) throw new Error('请求体不能为空')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是有效 JSON')
  }
}
