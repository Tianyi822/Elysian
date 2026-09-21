/**
 * 平台内存采样：Elysian 进程自身的常驻集与 V8/JavaScriptCore 堆。
 * 数字单位是 MB，由服务端 process.memoryUsage 换算；浏览器只消费这份 JSON。
 */
export type PlatformMemorySample = {
  rssMb: number
  heapUsedMb: number
  heapTotalMb: number
}

const BYTES_PER_MB = 1024 * 1024

export function sampleFromUsage(usage: {
  rss: number
  heapUsed: number
  heapTotal: number
}): PlatformMemorySample {
  return {
    rssMb: usage.rss / BYTES_PER_MB,
    heapUsedMb: usage.heapUsed / BYTES_PER_MB,
    heapTotalMb: usage.heapTotal / BYTES_PER_MB,
  }
}

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
