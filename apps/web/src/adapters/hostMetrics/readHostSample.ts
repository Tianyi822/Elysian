import type { DiskUsage, SystemLoad } from '../mock/resourceMetrics.ts'

export const PROC_LOADAVG = '/proc/loadavg'
export const PROC_MEMINFO = '/proc/meminfo'
export const PROC_STAT = '/proc/stat'
export const PROC_NET_DEV = '/proc/net/dev'
export const PROC_DISKSTATS = '/proc/diskstats'

const BYTES_PER_SECTOR = 512
const BYTES_PER_MB = 1024 * 1024

export type HostSample = {
  cpu: number
  memory: number
  networkIo: number
  diskIo: number
  load: SystemLoad
  disks: DiskUsage[]
}

export type HostSamplePrev = {
  stat: string
  net: string
  disk: string
  at: number
}

export type ReadHostSampleResult = {
  sample: HostSample
  nextPrev: HostSamplePrev
}

export function parseLoadavg(text: string): SystemLoad {
  const parts = text.trim().split(/\s+/)
  if (parts.length < 3) {
    throw new Error('loadavg 格式无效')
  }
  const m1 = Number.parseFloat(parts[0] ?? '')
  const m5 = Number.parseFloat(parts[1] ?? '')
  const m15 = Number.parseFloat(parts[2] ?? '')
  if ([m1, m5, m15].some((value) => Number.isNaN(value))) {
    throw new Error('loadavg 负载值无法解析')
  }
  return { m1, m5, m15 }
}

export function parseMeminfo(text: string): number {
  let memTotalKb: number | undefined
  let memAvailableKb: number | undefined

  for (const line of text.split('\n')) {
    const totalMatch = /^MemTotal:\s+(\d+)\s+kB/i.exec(line)
    if (totalMatch) {
      memTotalKb = Number.parseInt(totalMatch[1] ?? '', 10)
      continue
    }
    const availableMatch = /^MemAvailable:\s+(\d+)\s+kB/i.exec(line)
    if (availableMatch) {
      memAvailableKb = Number.parseInt(availableMatch[1] ?? '', 10)
    }
  }

  if (memTotalKb === undefined || memTotalKb <= 0) {
    throw new Error('meminfo 缺少有效的 MemTotal')
  }
  if (memAvailableKb === undefined) {
    throw new Error('meminfo 缺少 MemAvailable')
  }

  const usedPct = ((memTotalKb - memAvailableKb) / memTotalKb) * 100
  return Math.round(usedPct)
}

export function parseDf(text: string): DiskUsage[] {
  const lines = text.trim().split('\n')
  const disks: DiskUsage[] = []

  for (const line of lines.slice(1)) {
    if (!line.trim()) {
      continue
    }
    const parts = line.trim().split(/\s+/)
    if (parts.length < 6) {
      continue
    }
    const capacity = parts[parts.length - 2] ?? ''
    const mount = parts[parts.length - 1] ?? ''
    const pctMatch = /^(\d+)%$/.exec(capacity)
    if (!pctMatch || !mount.startsWith('/')) {
      continue
    }
    disks.push({
      mount,
      usagePct: Number.parseInt(pctMatch[1] ?? '', 10),
    })
  }

  return disks
}

function parseCpuAggregateLine(text: string): { total: number; idle: number } | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith('cpu ')) {
      continue
    }
    const fields = line.trim().split(/\s+/).slice(1).map((value) => Number.parseInt(value, 10))
    if (fields.length < 4 || fields.some((value) => Number.isNaN(value))) {
      return null
    }
    const [user, nice, system, idle, iowait = 0] = fields
    const total =
      (user ?? 0) +
      (nice ?? 0) +
      (system ?? 0) +
      (idle ?? 0) +
      iowait +
      fields.slice(5).reduce((sum, value) => sum + (Number.isNaN(value) ? 0 : value), 0)
    return { total, idle: (idle ?? 0) + iowait }
  }
  return null
}

export function cpuUsagePercent(prevStat: string, nextStat: string): number {
  const prev = parseCpuAggregateLine(prevStat)
  const next = parseCpuAggregateLine(nextStat)
  if (!prev || !next) {
    throw new Error('stat 缺少 cpu 聚合行')
  }

  const totalDelta = next.total - prev.total
  const idleDelta = next.idle - prev.idle
  if (totalDelta <= 0) {
    return 0
  }

  const usage = (1 - idleDelta / totalDelta) * 100
  return Math.round(Math.min(100, Math.max(0, usage)))
}

function sumNetworkBytes(text: string): number {
  let total = 0
  for (const line of text.split('\n')) {
    const match = /^\s*([\w.-]+):\s*(\d+)/.exec(line)
    if (!match) {
      continue
    }
    const iface = match[1] ?? ''
    if (iface === 'lo') {
      continue
    }
    const parts = line.trim().split(/\s+/)
    const rx = Number.parseInt(parts[1] ?? '0', 10)
    const tx = Number.parseInt(parts[9] ?? '0', 10)
    if (!Number.isNaN(rx) && !Number.isNaN(tx)) {
      total += rx + tx
    }
  }
  return total
}

function sumDiskSectors(text: string): number {
  let total = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const parts = trimmed.split(/\s+/)
    if (parts.length < 11) {
      continue
    }
    const minor = Number.parseInt(parts[1] ?? '', 10)
    if (minor !== 0) {
      continue
    }
    const sectorsRead = Number.parseInt(parts[5] ?? '0', 10)
    const sectorsWritten = Number.parseInt(parts[9] ?? '0', 10)
    if (!Number.isNaN(sectorsRead) && !Number.isNaN(sectorsWritten)) {
      total += sectorsRead + sectorsWritten
    }
  }
  return total
}

export function ioMbps(
  prev: string,
  next: string,
  kind: 'net' | 'disk',
  elapsedMs: number,
): number {
  if (elapsedMs <= 0) {
    return 0
  }

  const delta =
    kind === 'net'
      ? sumNetworkBytes(next) - sumNetworkBytes(prev)
      : (sumDiskSectors(next) - sumDiskSectors(prev)) * BYTES_PER_SECTOR

  if (delta <= 0) {
    return 0
  }

  const bytesPerSecond = (delta / elapsedMs) * 1000
  return bytesPerSecond / BYTES_PER_MB
}

export async function readHostSample(deps: {
  readFile(path: string): Promise<string>
  execDf(): Promise<string>
  prev?: HostSamplePrev
}): Promise<ReadHostSampleResult> {
  const [loadavgText, meminfoText, statText, netText, diskText, dfText] = await Promise.all([
    deps.readFile(PROC_LOADAVG),
    deps.readFile(PROC_MEMINFO),
    deps.readFile(PROC_STAT),
    deps.readFile(PROC_NET_DEV),
    deps.readFile(PROC_DISKSTATS),
    deps.execDf(),
  ])

  const now = Date.now()
  const elapsedMs = deps.prev ? Math.max(1, now - deps.prev.at) : 0

  const sample: HostSample = {
    cpu:
      deps.prev && elapsedMs > 0
        ? cpuUsagePercent(deps.prev.stat, statText)
        : 0,
    memory: parseMeminfo(meminfoText),
    networkIo:
      deps.prev && elapsedMs > 0
        ? ioMbps(deps.prev.net, netText, 'net', elapsedMs)
        : 0,
    diskIo:
      deps.prev && elapsedMs > 0
        ? ioMbps(deps.prev.disk, diskText, 'disk', elapsedMs)
        : 0,
    load: parseLoadavg(loadavgText),
    disks: parseDf(dfText),
  }

  return {
    sample,
    nextPrev: {
      stat: statText,
      net: netText,
      disk: diskText,
      at: now,
    },
  }
}
