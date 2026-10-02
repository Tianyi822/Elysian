/**
 * 平台内存采样：类型与换算来自 @elysian/contracts（server 产样本、浏览器消费同一形状），
 * 这里 re-export 保持既有导入路径不变；本文件只保留浏览器侧的响应校验。
 */
import type { PlatformMemorySample } from '@elysian/contracts'

export type { PlatformMemorySample }

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 校验 GET /api/platform/memory 的 JSON；认不出一律当无效，不把脏数据送上徽标。 */
export function parsePlatformMemoryResponse(body: unknown): PlatformMemorySample {
  if (!body || typeof body !== 'object') {
    throw new Error('平台内存响应格式无效')
  }
  const row = body as Record<string, unknown>
  const source = row.rssSource
  if (source !== 'smaps-rollup' && source !== 'smaps' && source !== 'statm' && source !== 'unavailable') {
    throw new Error('平台内存响应格式无效')
  }
  const rssMb = row.rssMb
  if (source === 'unavailable' ? rssMb !== null : !isNonNegativeFinite(rssMb)) {
    throw new Error('平台内存响应格式无效')
  }
  const systemTotalMb = row.systemTotalMb ?? null
  if (systemTotalMb !== null && (!isNonNegativeFinite(systemTotalMb) || systemTotalMb === 0)) {
    throw new Error('平台内存响应格式无效')
  }
  if (typeof row.sampledAt !== 'string' || !Number.isFinite(Date.parse(row.sampledAt))) {
    throw new Error('平台内存响应格式无效')
  }
  const numberField = (key: string): number => {
    const value = row[key]
    if (!isNonNegativeFinite(value)) throw new Error('平台内存响应格式无效')
    return value
  }
  const gcCount = numberField('gcCount')
  if (!Number.isSafeInteger(gcCount)) throw new Error('平台内存响应格式无效')
  return {
    rssMb: rssMb as number | null,
    rssSource: source,
    systemTotalMb: systemTotalMb as number | null,
    sampledAt: row.sampledAt,
    heapUsedMb: numberField('heapUsedMb'),
    heapTotalMb: numberField('heapTotalMb'),
    heapUnusedMb: numberField('heapUnusedMb'),
    heapRetainedMb: numberField('heapRetainedMb'),
    heapReleasedMb: numberField('heapReleasedMb'),
    runtimeOtherMb: numberField('runtimeOtherMb'),
    heapLiveMb: numberField('heapLiveMb'),
    gcCount,
  }
}
