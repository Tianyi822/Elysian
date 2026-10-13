import { withRequestDeadline } from './requestDeadline'
import { parsePlatformMemoryResponse, type PlatformMemorySample } from '../platformMemory/types'
import { fetchWithSession, reportUnauthorized } from './unauthorized'

export type { PlatformMemorySample }

export function fetchPlatformMemory(url = '/api/platform/memory', signal?: AbortSignal): Promise<PlatformMemorySample> {
  return withRequestDeadline({ signal }, (init) => readPlatformMemory(url, init.signal ?? undefined))
}

/**
 * 浏览器侧同源读取 Go 后端进程内存，
 * 这里只做 JSON 形状校验与中文错误。
 */
async function readPlatformMemory(
  url = '/api/platform/memory',
  signal?: AbortSignal,
): Promise<PlatformMemorySample> {
  let response: Response
  try {
    response = await fetchWithSession(url, { cache: 'no-store', signal })
  } catch {
    throw new Error('平台内存采集失败')
  }
  if (!response.ok) {
    if (reportUnauthorized(response)) throw new Error('登录状态已失效，请重新登录')
    throw new Error('平台内存采集失败')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error('平台内存响应不是有效 JSON')
  }
  return parsePlatformMemoryResponse(body)
}
