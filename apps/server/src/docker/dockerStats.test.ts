import { describe, expect, it } from 'vitest'
import { cpuPercent, memoryMb } from './dockerStats'

const MIB = 1024 * 1024

function statsCpuBlock(total: number, system: number, online?: number, percpu?: number[]) {
  return {
    cpu_usage: { total_usage: total, percpu_usage: percpu ?? [0] },
    system_cpu_usage: system,
    ...(online !== undefined ? { online_cpus: online } : {}),
  }
}

function dockerStatsSnapshot(
  cpu: ReturnType<typeof statsCpuBlock>,
  precpu: ReturnType<typeof statsCpuBlock>,
) {
  return { cpu_stats: cpu, precpu_stats: precpu }
}

describe('cpuPercent', () => {
  it('缺少 precpu_stats 时返回 undefined', () => {
    const current = {
      cpu_stats: statsCpuBlock(200, 2000, 2),
    }
    expect(cpuPercent(current, undefined)).toBeUndefined()
  })

  it('systemDelta <= 0 时返回 undefined', () => {
    const block = statsCpuBlock(100, 5000, 2)
    const current = dockerStatsSnapshot(statsCpuBlock(200, 5000, 2), block)
    expect(cpuPercent(current, undefined)).toBeUndefined()

    const decreasing = dockerStatsSnapshot(statsCpuBlock(200, 4000, 2), statsCpuBlock(300, 5000, 2))
    expect(cpuPercent(decreasing, undefined)).toBeUndefined()
  })

  it('按规格差值计算并钳制到 0–100 的一位小数', () => {
    const current = dockerStatsSnapshot(
      statsCpuBlock(1_000_000, 10_000_000, 4),
      statsCpuBlock(0, 0, 4),
    )
    expect(cpuPercent(current, undefined)).toBe(40)

    const halfCore = dockerStatsSnapshot(
      statsCpuBlock(500_000, 10_000_000, 2),
      statsCpuBlock(0, 0, 2),
    )
    expect(cpuPercent(halfCore, undefined)).toBe(10)
  })

  it('online_cpus 缺失时用 percpu_usage 长度', () => {
    const current = dockerStatsSnapshot(
      statsCpuBlock(1_000_000, 10_000_000, undefined, [0, 0, 0]),
      statsCpuBlock(0, 0, undefined, [0, 0, 0]),
    )
    expect(cpuPercent(current, undefined)).toBe(30)
  })

  it('非有限结果时返回 undefined', () => {
    expect(cpuPercent(null, undefined)).toBeUndefined()
    expect(cpuPercent({}, undefined)).toBeUndefined()
  })
})

describe('memoryMb', () => {
  it('usage 100 MiB、inactive_file 40 MiB 时得到 60', () => {
    const stats = {
      memory_stats: {
        usage: 100 * MIB,
        stats: { inactive_file: 40 * MIB },
      },
    }
    expect(memoryMb(stats)).toBe(60)
  })

  it('inactive_file 优先于 cache', () => {
    const stats = {
      memory_stats: {
        usage: 200 * MIB,
        stats: { inactive_file: 50 * MIB },
        cache: 80 * MIB,
      },
    }
    expect(memoryMb(stats)).toBe(150)
  })

  it('无 inactive_file 时用 total_inactive_file，再否则 cache', () => {
    expect(
      memoryMb({
        memory_stats: {
          usage: 100 * MIB,
          total_inactive_file: 25 * MIB,
          cache: 40 * MIB,
        },
      }),
    ).toBe(75)

    expect(
      memoryMb({
        memory_stats: {
          usage: 100 * MIB,
          cache: 30 * MIB,
        },
      }),
    ).toBe(70)
  })

  it('无缓存字段时用 usage，四舍五入为整数 MB', () => {
    expect(
      memoryMb({
        memory_stats: {
          usage: 1.4 * MIB,
        },
      }),
    ).toBe(1)
    expect(
      memoryMb({
        memory_stats: {
          usage: 1.6 * MIB,
        },
      }),
    ).toBe(2)
  })

  it('扣除后不为负', () => {
    expect(
      memoryMb({
        memory_stats: {
          usage: 10 * MIB,
          stats: { inactive_file: 20 * MIB },
        },
      }),
    ).toBe(0)
  })

  it('形状无效时返回 undefined', () => {
    expect(memoryMb(null)).toBeUndefined()
    expect(memoryMb({})).toBeUndefined()
  })
})
