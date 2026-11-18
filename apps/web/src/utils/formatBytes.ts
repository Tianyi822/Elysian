const scales = ['byte', 'kilo', 'mega', 'giga'] as const
const units = {
  si: { base: 1000, labels: ['B', 'kB', 'MB', 'GB'] },
  iec: { base: 1024, labels: ['B', 'KiB', 'MiB', 'GiB'] },
  // 旧界面沿用 KB/MB/GB 标签，但按 1024 换算。
  legacy: { base: 1024, labels: ['B', 'KB', 'MB', 'GB'] },
} as const

type Precision = number | 'raw' | 'round' | 'ceil'
interface CapacityFormat {
  unit?: keyof typeof units
  digits?: number | Partial<Record<typeof scales[number], Precision>>
  minUnit?: 'kilo'
  maxUnit?: 'mega' | 'giga'
}

function formatCapacity(value: number, scale: number, {
  unit = 'iec', digits, minUnit, maxUnit = 'giga',
}: CapacityFormat): string {
  const { base, labels } = units[unit]
  const limit = scales.indexOf(maxUnit)
  const minimum = minUnit === 'kilo' ? 1 : scale
  // 按原始值选单位；舍入后即使达到进位值，也不重新选单位。
  while (scale < limit && (scale < minimum || value >= base)) {
    value /= base
    scale += 1
  }
  const precision = typeof digits === 'number'
    ? (scale === 0 ? 'raw' : digits)
    : digits?.[scales[scale]!] ?? (scale === 0 ? 'raw' : 1)
  const amount = precision === 'raw' ? value
    : precision === 'round' ? Math.round(value)
    : precision === 'ceil' ? Math.ceil(value)
    : value.toFixed(precision)
  return `${amount} ${labels[scale]}`
}

export function formatBytes(bytes: number, format: CapacityFormat = {}): string {
  return formatCapacity(bytes, 0, format)
}

export function formatFromMiB(mib: number, format: Omit<CapacityFormat, 'unit' | 'minUnit'> & {
  unit?: 'iec' | 'legacy'
} = {}): string {
  return formatCapacity(mib, 2, format)
}
