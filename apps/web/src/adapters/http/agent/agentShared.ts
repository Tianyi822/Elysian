import type { RuntimePage } from '@elysian/contracts'
import { AgentHttpError } from '../../../contracts/agentHttpError'
import { withRequestDeadline } from '../requestDeadline'
import { fetchWithSession, isCurrentSessionResponse, reportUnauthorized } from '../unauthorized'

type AgentUnavailableReporter = (reason: string) => void

/** 模型设置的同源 JSON 请求：统一超时、401、服务端错误与内核不可用处理。 */
async function parseAgentResponse(response: Response, onGlobalUnavailable?: AgentUnavailableReporter): Promise<unknown> {
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    const body = await response.json().catch(() => null)
    const row = body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
    const detail = row !== null && typeof row.error === 'string' ? row.error : null
    const code = row !== null && typeof row.code === 'string' ? row.code : undefined
    if (detail !== null) {
      const error = new AgentHttpError(detail, code, response.status)
      if (isAgentGlobalUnavailableError(error) && isCurrentSessionResponse(response)) onGlobalUnavailable?.(detail)
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

/** HTTP 503 与业务校验错误分开；分项故障只在受影响的页面显示。 */
export function isAgentUnavailableError(error: unknown): boolean {
  return error instanceof AgentHttpError && error.status === 503
}

/** 模型设置仅响应内核级 503；扩展/MCP/执行器分项故障不阻断模型配置。 */
export function isAgentGlobalUnavailableError(error: unknown): boolean {
  return isAgentUnavailableError(error) && error instanceof AgentHttpError &&
    !['extensions-unavailable', 'mcp-unavailable', 'execution-unavailable', 'resource-rules-unavailable'].includes(error.code ?? '')
}

/**
 * JSON 请求唯一出口。写方法超时即抛「操作结果尚未确认」，不自动重放；
 * 长时限端点（如技能导入 multipart 由各域自行组包，不经本出口）由调用方显式传入。
 */
async function readAgentJson(
  url: string,
  init: RequestInit | undefined,
  options: { timeoutMs?: number } | undefined,
  readResponse: AgentHttpClient['readAgentResponse'],
): Promise<unknown> {
  return withRequestDeadline(init, async (bounded) => {
    const headers = new Headers(init?.headers)
    headers.set('content-type', 'application/json')
    let response: Response
    try {
      response = await fetchWithSession(url, { ...init, headers, cache: 'no-store', signal: bounded.signal })
    } catch (error) {
      if (bounded.signal?.aborted) throw error
      throw new Error('Agent 请求网络失败')
    }
    return readResponse(response)
  }, options?.timeoutMs)
}

/**
 * 无正文写请求（如 204 删除）：超时与错误口径同 JSON 出口，
 * 成功直接结束，不把空响应体当 JSON 解析。
 */
async function readAgentNoContent(
  url: string,
  init: RequestInit | undefined,
  options: { timeoutMs?: number } | undefined,
  readResponse: AgentHttpClient['readAgentResponse'],
): Promise<void> {
  return withRequestDeadline(init, async (bounded) => {
    let response: Response
    try {
      response = await fetchWithSession(url, { ...init, cache: 'no-store', signal: bounded.signal })
    } catch (error) {
      if (bounded.signal?.aborted) throw error
      throw new Error('Agent 请求网络失败')
    }
    if (!response.ok) await readResponse(response)
  }, options?.timeoutMs)
}

export type AgentHttpClient = {
  readAgentResponse(response: Response): Promise<unknown>
  requestAgentJson(url: string, init?: RequestInit, options?: { timeoutMs?: number }): Promise<unknown>
  requestAgentNoContent(url: string, init?: RequestInit, options?: { timeoutMs?: number }): Promise<void>
}

export function createAgentHttpClient(onGlobalUnavailable?: AgentUnavailableReporter): AgentHttpClient {
  const readAgentResponse = (response: Response) => parseAgentResponse(response, onGlobalUnavailable)
  return {
    readAgentResponse,
    requestAgentJson: (url, init, options) => readAgentJson(url, init, options, readAgentResponse),
    requestAgentNoContent: (url, init, options) => readAgentNoContent(url, init, options, readAgentResponse),
  }
}

export const defaultAgentHttpClient = createAgentHttpClient()

/** 路径段编码：空标识直接抛中文错误，非空逐段 encodeURIComponent。 */
export function agentPathPart(value: string, label = '标识'): string {
  if (!value) throw new Error(`Agent ${label}不能为空`)
  return encodeURIComponent(value)
}

export function assertRequestId(value: string): string {
  if (!AGENT_REQUEST_ID_PATTERN.test(value)) {
    throw new Error('requestId 必须以字母或数字开头，仅含字母、数字与 . _ : -，长度 1 到 128')
  }
  return value
}

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

export function agentQueryString(params: Readonly<Record<string, string | number | undefined>>): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.join('&')
}

export const AGENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
