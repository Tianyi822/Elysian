/**
 * 资源指标展示格式化：百分比原样；吞吐（存为 MB/s）按量级换成 B/s～GB/s。
 */

export type ThroughputUnit = 'B/s' | 'KB/s' | 'MB/s' | 'GB/s'

const KIB = 1024
const MIB = KIB * KIB
const GIB = MIB * KIB

/** 把存盘的 MB/s 换成字节/秒。 */
export function mbpsToBytesPerSec(mbPerSec: number): number {
  return mbPerSec * MIB
}

/** 按一组 MB/s 采样的峰值选图表纵轴单位。 */
export function pickThroughputUnit(mbPerSecValues: readonly number[]): ThroughputUnit {
  const peak = Math.max(0, ...mbPerSecValues.map((value) => Math.abs(value)))
  const bytes = mbpsToBytesPerSec(peak)
  if (bytes < KIB) return 'B/s'
  if (bytes < MIB) return 'KB/s'
  if (bytes < GIB) return 'MB/s'
  return 'GB/s'
}

/** 把 MB/s 换到指定吞吐单位。 */
export function mbpsToUnit(mbPerSec: number, unit: ThroughputUnit): number {
  const bytes = mbpsToBytesPerSec(mbPerSec)
  switch (unit) {
    case 'B/s':
      return bytes
    case 'KB/s':
      return bytes / KIB
    case 'MB/s':
      return bytes / MIB
    case 'GB/s':
      return bytes / GIB
  }
}

function formatCompactNumber(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 100) return String(Math.round(value))
  if (absolute >= 10) return value.toFixed(1)
  if (absolute >= 1) return value.toFixed(2)
  if (absolute >= 0.1) return value.toFixed(2)
  return value.toFixed(3)
}

/** 单点吞吐展示：按该点量级自动选单位。 */
export function formatThroughputFromMbps(mbPerSec: number): string {
  const unit = pickThroughputUnit([mbPerSec])
  return `${formatCompactNumber(mbpsToUnit(mbPerSec, unit))} ${unit}`
}

/** 资源卡大字号：% 紧跟数值，吞吐自动换算，其余「数值 单位」。 */
export function formatResourceMetricValue(value: number, unit: string): string {
  if (unit === '%') return `${Math.round(value * 10) / 10}%`
  if (unit === 'MB/s') return formatThroughputFromMbps(value)
  return `${formatCompactNumber(value)} ${unit}`
}
