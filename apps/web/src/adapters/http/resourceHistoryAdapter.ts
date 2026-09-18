import type {
  ResourceHistoryAdapter,
  ResourceHistoryTimeRange,
  ResourceSamplePoint,
} from '../../contracts/adapters'

function isSamplePoint(value: unknown): value is ResourceSamplePoint {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.ts === 'number' &&
    typeof row.cpu === 'number' &&
    typeof row.memory === 'number' &&
    typeof row.networkIo === 'number' &&
    typeof row.networkRx === 'number' &&
    typeof row.networkTx === 'number' &&
    typeof row.diskIo === 'number' &&
    typeof row.diskRead === 'number' &&
    typeof row.diskWrite === 'number'
  )
}

/** 解析 history 端点 JSON 数组；格式不符时抛中文错误。 */
export function parseResourceHistoryResponse(body: unknown): readonly ResourceSamplePoint[] {
  if (!Array.isArray(body)) {
    throw new Error('历史响应格式无效：应为数组')
  }
  for (const item of body) {
    if (!isSamplePoint(item)) {
      throw new Error('历史响应包含无效的采样点')
    }
  }
  return body
}

/** 浏览器侧同源 history 查询；系统采样与 SQLite 仅存在于 dev/preview 中间件。 */
export function createHttpResourceHistoryAdapter(
  baseUrl = '/api/resources/history',
): ResourceHistoryAdapter {
  return {
    async list(range: ResourceHistoryTimeRange): Promise<readonly ResourceSamplePoint[]> {
      const url = `${baseUrl}?range=${encodeURIComponent(range)}`
      let response: Response
      try {
        response = await fetch(url)
      } catch {
        throw new Error('历史查询网络失败')
      }
      if (!response.ok) {
        throw new Error(`历史查询失败：HTTP ${response.status}`)
      }
      let body: unknown
      try {
        body = await response.json()
      } catch {
        throw new Error('历史响应不是有效 JSON')
      }
      return parseResourceHistoryResponse(body)
    },
  }
}
