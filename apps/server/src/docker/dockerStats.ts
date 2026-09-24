function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type CpuStatsBlock = {
  totalUsage: number
  systemUsage: number
  online: number
}

function readCpuBlock(block: unknown): CpuStatsBlock | undefined {
  if (!isRecord(block)) {
    return undefined
  }
  const cpuUsage = block.cpu_usage
  if (!isRecord(cpuUsage)) {
    return undefined
  }
  const totalUsage = cpuUsage.total_usage
  const systemUsage = block.system_cpu_usage
  if (typeof totalUsage !== 'number' || typeof systemUsage !== 'number') {
    return undefined
  }
  if (!Number.isFinite(totalUsage) || !Number.isFinite(systemUsage)) {
    return undefined
  }

  let online: number | undefined
  if (typeof block.online_cpus === 'number' && Number.isFinite(block.online_cpus)) {
    online = block.online_cpus
  } else if (Array.isArray(cpuUsage.percpu_usage)) {
    online = cpuUsage.percpu_usage.length
  }
  if (online === undefined || online <= 0) {
    return undefined
  }

  return { totalUsage, systemUsage, online }
}

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10
}

const MIB = 1024 * 1024

export function cpuPercent(current: unknown, _previous: unknown): number | undefined {
  if (!isRecord(current)) {
    return undefined
  }
  const currentCpu = readCpuBlock(current.cpu_stats)
  const preCpu = readCpuBlock(current.precpu_stats)
  if (!currentCpu || !preCpu) {
    return undefined
  }

  const cpuDelta = currentCpu.totalUsage - preCpu.totalUsage
  const systemDelta = currentCpu.systemUsage - preCpu.systemUsage
  if (systemDelta <= 0) {
    return undefined
  }

  const percent = (cpuDelta / systemDelta) * currentCpu.online * 100
  if (!Number.isFinite(percent)) {
    return undefined
  }

  const clamped = Math.min(100, Math.max(0, percent))
  return roundOneDecimal(clamped)
}

function readCacheBytes(memoryStats: Record<string, unknown>): number {
  const nested = memoryStats.stats
  if (isRecord(nested) && typeof nested.inactive_file === 'number' && Number.isFinite(nested.inactive_file)) {
    return nested.inactive_file
  }
  if (typeof memoryStats.total_inactive_file === 'number' && Number.isFinite(memoryStats.total_inactive_file)) {
    return memoryStats.total_inactive_file
  }
  if (typeof memoryStats.cache === 'number' && Number.isFinite(memoryStats.cache)) {
    return memoryStats.cache
  }
  return 0
}

export function memoryMb(stats: unknown): number | undefined {
  if (!isRecord(stats)) {
    return undefined
  }
  const memoryStats = stats.memory_stats
  if (!isRecord(memoryStats)) {
    return undefined
  }
  const usage = memoryStats.usage
  if (typeof usage !== 'number' || !Number.isFinite(usage)) {
    return undefined
  }

  const cache = readCacheBytes(memoryStats)
  const bytes = Math.max(0, usage - cache)
  return Math.round(bytes / MIB)
}
