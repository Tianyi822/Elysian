import type { RuntimePage } from '@elysian/contracts'
import { withRequestDeadline } from '../requestDeadline'
import { reportUnauthorized } from '../unauthorized'
import { useAgentRuntimeStore } from '../../../stores/agentRuntimeStore'

/*
 * Agent（Ely）域 HTTP 请求的共享出口。全部端点挂同源 /api/agent 前缀：
 * - requestAgentJson 只承载 JSON 体，Content-Type 恒 application/json；
 * - sendRawBytes 专供体为原始文件字节的端点（当前仅 PUT /tasks/{id}/workspace），
 *   绝不设 Content-Type、绝不 JSON 包装或 base64 编码——服务端把请求体直接交给
 *   WriteWorkspace，按 JSON 惯例发送会把包装文本存进文件且服务端不报错。
 * 两者都经 withRequestDeadline（写超时不重放，结果记为未确认）并在失败分支先经
 * reportUnauthorized 上报 401，再透传服务端 {error,code} 的中文 error。
 */

/** requestId 与服务端同一正则（manager.go:160）；仅用于输入体声明了 requestId 的七类提交。 */
export const AGENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

/** 前端预检：不合格的 requestId 直接抛中文错误，不发出请求。 */
export function assertRequestId(value: string): string {
  if (!AGENT_REQUEST_ID_PATTERN.test(value)) {
    throw new Error('requestId 必须以字母或数字开头，仅含字母、数字与 . _ : -，长度 1 到 128')
  }
  return value
}

/** 规范非负十进制字符串（拒空串、+、前导零与非数字），与服务端事件游标同口径。 */
export function isDecimalCursor(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value)
}

/** 断言游标为规范十进制字符串；seq/lastSeq/eventSeq 等一律保持字符串，不得转 number。 */
export function assertDecimalCursor(value: string, label = '事件序号'): string {
  if (!isDecimalCursor(value)) throw new Error(`${label}必须为规范非负十进制字符串`)
  return value
}

function canonicalDecimal(value: string): string {
  return value.replace(/^0+(?=\d)/, '')
}

/** 十进制字符串游标的数值比较（先长后字典序，不经 number，大整数不丢精度）。 */
export function compareDecimalCursors(a: string, b: string): number {
  const left = canonicalDecimal(a)
  const right = canonicalDecimal(b)
  if (left === right) return 0
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left < right ? -1 : 1
}

export async function readAgentResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const body = await response.json().catch(() => null)
    const row = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
    const detail = row !== null && typeof row.error === 'string' ? row.error : null
    const code = row !== null && typeof row.code === 'string' ? row.code : undefined
    if (detail !== null) {
      const error = new AgentHttpError(detail, code, response.status)
      if (isAgentGlobalUnavailableError(error)) useAgentRuntimeStore.getState().reportUnavailable(detail)
      throw error
    }
    throw new Error(`Agent 请求失败：HTTP ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('Agent 响应不是有效 JSON')
  }
}

/** 服务端 {error,code} 的透传错误：message 为中文 error，code 保留机器判定用。 */
export class AgentHttpError extends Error {
  readonly code?: string
  readonly status?: number
  constructor(message: string, code?: string, status?: number) {
    super(message)
    this.name = 'AgentHttpError'
    this.code = code
    this.status = status
  }
}

/** HTTP 503 与业务校验错误分开；分项故障只在受影响的页面显示。 */
export function isAgentUnavailableError(error: unknown): boolean {
  return error instanceof AgentHttpError && error.status === 503
}

/** 内核级 503 才能遮挡全部 Ely 页面；扩展/MCP/执行器故障不得阻断模型和会话。 */
export function isAgentGlobalUnavailableError(error: unknown): boolean {
  return isAgentUnavailableError(error) && error instanceof AgentHttpError &&
    !['extensions-unavailable', 'mcp-unavailable', 'execution-unavailable', 'resource-rules-unavailable'].includes(error.code ?? '')
}

/**
 * JSON 请求唯一出口。写方法超时即抛「操作结果尚未确认」，不自动重放；
 * 长时限端点（如技能导入 multipart 由各域自行组包，不经本出口）由调用方显式传入。
 */
export async function requestAgentJson(
  url: string,
  init?: RequestInit,
  options?: { timeoutMs?: number },
): Promise<unknown> {
  return withRequestDeadline(init, async (bounded) => {
    const headers = new Headers(init?.headers)
    headers.set('content-type', 'application/json')
    let response: Response
    try {
      response = await fetch(url, { ...init, headers, cache: 'no-store', signal: bounded.signal })
    } catch (error) {
      if (bounded.signal?.aborted) throw error
      throw new Error('Agent 请求网络失败')
    }
    return readAgentResponse(response)
  }, options?.timeoutMs)
}

/** 原始字节请求唯一出口：不设 Content-Type、不 JSON 包装，字节原样作为请求体。 */
export async function sendRawBytes(
  url: string,
  method: string,
  bytes: Uint8Array,
  init?: RequestInit,
  options?: { timeoutMs?: number },
): Promise<unknown> {
  const raw = bytes as unknown as BodyInit
  return withRequestDeadline({ ...init, method, body: raw }, async (bounded) => {
    let response: Response
    try {
      response = await fetch(url, { method, body: raw, cache: 'no-store', signal: bounded.signal })
    } catch (error) {
      if (bounded.signal?.aborted) throw error
      throw new Error('Agent 请求网络失败')
    }
    return readAgentResponse(response)
  }, options?.timeoutMs)
}

/** Page<T> 信封解析：items/nextCursor/hasMore 三键齐全才算有效，逐项走 parseItem 校验。 */
export function parseAgentPage<T>(
  value: unknown,
  parseItem: (item: unknown) => T,
  label = '分页',
): RuntimePage<T> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Agent ${label}响应无效`)
  }
  const row = value as Record<string, unknown>
  if (!Array.isArray(row.items) || typeof row.nextCursor !== 'string' || typeof row.hasMore !== 'boolean') {
    throw new Error(`Agent ${label}响应无效`)
  }
  return { items: row.items.map(parseItem), nextCursor: row.nextCursor, hasMore: row.hasMore }
}

/** 只把定义了的查询参数编进查询串，键值逐个 encodeURIComponent；返回串不带前导 ?。 */
export function agentQueryString(params: Readonly<Record<string, string | number | undefined>>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.join('&')
}

/** 路径段编码：空标识直接抛中文错误，非空逐段 encodeURIComponent。 */
export function agentPathPart(value: string, label = '标识'): string {
  if (!value) throw new Error(`Agent ${label}不能为空`)
  return encodeURIComponent(value)
}
