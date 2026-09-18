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
  networkRx: number
  networkTx: number
  diskIo: number
  diskRead: number
  diskWrite: number
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

const DF_NOISE_FILESYSTEMS = new Set([
  'tmpfs',
  'devtmpfs',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'squashfs',
  'ramfs',
  'devpts',
  'mqueue',
])

/** 排除伪文件系统与 /dev|/proc|/sys|/run 下挂载；每个挂载点的占用率相对自身容量，互不嵌套。 */
export function isNoiseDfMount(filesystem: string, mount: string): boolean {
  const fs = filesystem.toLowerCase()
  if (DF_NOISE_FILESYSTEMS.has(fs)) return true
  if (mount === '/dev' || mount.startsWith('/dev/')) return true
  if (mount.startsWith('/proc') || mount.startsWith('/sys') || mount.startsWith('/run')) return true
  return false
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
    const filesystem = parts[0] ?? ''
    const sizeKb = Number.parseInt(parts[parts.length - 5] ?? '', 10)
    const usedKb = Number.parseInt(parts[parts.length - 4] ?? '', 10)
    const capacity = parts[parts.length - 2] ?? ''
    const mount = parts[parts.length - 1] ?? ''
    const pctMatch = /^(\d+)%$/.exec(capacity)
    if (!pctMatch || !mount.startsWith('/')) {
      continue
    }
    if (!Number.isFinite(sizeKb) || !Number.isFinite(usedKb) || sizeKb <= 0) {
      continue
    }
    if (isNoiseDfMount(filesystem, mount)) {
      continue
    }
    disks.push({
      mount,
      usagePct: Number.parseInt(pctMatch[1] ?? '', 10),
      usedKb,
      sizeKb,
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

function sumNetworkBytesByDirection(text: string): { rx: number; tx: number } {
  let rx = 0
  let tx = 0
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
    const rxBytes = Number.parseInt(parts[1] ?? '0', 10)
    const txBytes = Number.parseInt(parts[9] ?? '0', 10)
    if (!Number.isNaN(rxBytes)) rx += rxBytes
    if (!Number.isNaN(txBytes)) tx += txBytes
  }
  return { rx, tx }
}

function sumDiskSectorsByDirection(text: string): { read: number; write: number } {
  let read = 0
  let write = 0
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
    if (!Number.isNaN(sectorsRead)) read += sectorsRead
    if (!Number.isNaN(sectorsWritten)) write += sectorsWritten
  }
  return { read, write }
}

function bytesDeltaToMbps(deltaBytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0 || deltaBytes <= 0) return 0
  return ((deltaBytes / elapsedMs) * 1000) / BYTES_PER_MB
}

export function networkIoMbps(
  prev: string,
  next: string,
  elapsedMs: number,
): { rx: number; tx: number; total: number } {
  const before = sumNetworkBytesByDirection(prev)
  const after = sumNetworkBytesByDirection(next)
  const rx = bytesDeltaToMbps(after.rx - before.rx, elapsedMs)
  const tx = bytesDeltaToMbps(after.tx - before.tx, elapsedMs)
  return { rx, tx, total: rx + tx }
}

export function diskIoMbps(
  prev: string,
  next: string,
  elapsedMs: number,
): { read: number; write: number; total: number } {
  const before = sumDiskSectorsByDirection(prev)
  const after = sumDiskSectorsByDirection(next)
  const read = bytesDeltaToMbps((after.read - before.read) * BYTES_PER_SECTOR, elapsedMs)
  const write = bytesDeltaToMbps((after.write - before.write) * BYTES_PER_SECTOR, elapsedMs)
  return { read, write, total: read + write }
}

/** @deprecated 使用 networkIoMbps / diskIoMbps；保留合计兼容旧断言。 */
export function ioMbps(
  prev: string,
  next: string,
  kind: 'net' | 'disk',
  elapsedMs: number,
): number {
  return kind === 'net'
    ? networkIoMbps(prev, next, elapsedMs).total
    : diskIoMbps(prev, next, elapsedMs).total
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

  const network =
    deps.prev && elapsedMs > 0
      ? networkIoMbps(deps.prev.net, netText, elapsedMs)
      : { rx: 0, tx: 0, total: 0 }
  const disk =
    deps.prev && elapsedMs > 0
      ? diskIoMbps(deps.prev.disk, diskText, elapsedMs)
      : { read: 0, write: 0, total: 0 }

  const sample: HostSample = {
    cpu:
      deps.prev && elapsedMs > 0
        ? cpuUsagePercent(deps.prev.stat, statText)
        : 0,
    memory: parseMeminfo(meminfoText),
    networkIo: network.total,
    networkRx: network.rx,
    networkTx: network.tx,
    diskIo: disk.total,
    diskRead: disk.read,
    diskWrite: disk.write,
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
