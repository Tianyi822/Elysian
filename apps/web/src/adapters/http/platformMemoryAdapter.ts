import { parsePlatformMemoryResponse, type PlatformMemorySample } from '../platformMemory/types'

export type { PlatformMemorySample }

/**
 * 浏览器侧同源读取平台内存。进程采样只存在于 dev/preview 中间件，
 * 这里只做 JSON 形状校验与中文错误。
 */
export async function fetchPlatformMemory(
  url = '/api/platform/memory',
): Promise<PlatformMemorySample> {
  let response: Response
  try {
    response = await fetch(url)
  } catch {
    throw new Error('平台内存采集失败')
  }
  if (!response.ok) {
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
