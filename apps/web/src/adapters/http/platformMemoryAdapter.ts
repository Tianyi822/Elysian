import type { PlatformMemorySample } from '@elysian/contracts'
import type { PlatformMemoryAdapter } from '../../contracts/adapters'
import { withRequestDeadline } from './requestDeadline'
import { parsePlatformMemoryResponse } from '../platformMemory/types'
import { fetchWithSession, reportUnauthorized } from './unauthorized'

export function createHttpPlatformMemoryAdapter(): PlatformMemoryAdapter {
  return {
    read: (signal) => withRequestDeadline({ signal }, (init) => readPlatformMemory(init.signal)),
  }
}

/**
 * 浏览器侧同源读取 Go 后端进程内存，
 * 这里只做 JSON 形状校验与中文错误。
 */
async function readPlatformMemory(signal: RequestInit['signal']): Promise<PlatformMemorySample> {
  let response: Response
  try {
    response = await fetchWithSession('/api/platform/memory', { cache: 'no-store', signal })
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
