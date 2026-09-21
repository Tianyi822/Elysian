/**
 * 平台内存采样：类型与换算来自 @elysian/contracts（server 产样本、浏览器消费同一形状），
 * 这里 re-export 保持既有导入路径不变；本文件只保留浏览器侧的响应校验。
 */
import type { PlatformMemorySample } from '@elysian/contracts'

export type { PlatformMemorySample }
export { sampleFromUsage } from '@elysian/contracts'

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 校验 GET /api/platform/memory 的 JSON；认不出一律当无效，不把脏数据送上徽标。 */
export function parsePlatformMemoryResponse(body: unknown): PlatformMemorySample {
  if (!body || typeof body !== 'object') {
    throw new Error('平台内存响应格式无效')
  }
  const row = body as Record<string, unknown>
  if (
    !isNonNegativeFinite(row.rssMb) ||
    !isNonNegativeFinite(row.heapUsedMb) ||
    !isNonNegativeFinite(row.heapTotalMb)
  ) {
    throw new Error('平台内存响应格式无效')
  }
  return { rssMb: row.rssMb, heapUsedMb: row.heapUsedMb, heapTotalMb: row.heapTotalMb }
}
