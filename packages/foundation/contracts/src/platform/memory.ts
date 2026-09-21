/*
 * 平台运行域：进程内存采样。Elysian 进程自身的常驻集与 V8/JavaScriptCore 堆，
 * 数字单位是 MB，由服务端按 process.memoryUsage 换算；server 产样本、浏览器消费
 * 同一份 JSON，两侧共用这里的类型与换算，保证徽标字段形状始终一致。零运行时依赖。
 */

/** 平台内存采样：数字单位是 MB，由服务端 process.memoryUsage 换算；浏览器只消费这份 JSON。 */
export type PlatformMemorySample = {
  rssMb: number
  heapUsedMb: number
  heapTotalMb: number
}

const BYTES_PER_MB = 1024 * 1024

/** 把 process.memoryUsage 的字节读数换算成 MB 采样。 */
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
