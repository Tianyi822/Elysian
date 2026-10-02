import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROC_DISKSTATS,
  PROC_LOADAVG,
  PROC_MEMINFO,
  PROC_NET_DEV,
  PROC_STAT,
  cpuUsagePercent,
  ioMbps,
  parseLoadavg,
  parseMeminfo,
  readHostSample,
} from './readHostSample'

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8')
}

describe('parseLoadavg', () => {
  it('解析 /proc/loadavg 前三项为 1/5/15 分钟负载', () => {
    expect(parseLoadavg(fixture('loadavg.txt'))).toEqual({
      m1: 0.52,
      m5: 0.58,
      m15: 0.59,
    })
  })
})

describe('parseMeminfo', () => {
  it('按 MemTotal 与 MemAvailable 计算内存占用百分比', () => {
    expect(parseMeminfo(fixture('meminfo.txt'))).toBe(60)
  })
})

describe('cpuUsagePercent', () => {
  it('由两次 /proc/stat 聚合行差分得到 CPU 使用率', () => {
    expect(cpuUsagePercent(fixture('stat-prev.txt'), fixture('stat-next.txt'))).toBe(50)
  })
})

describe('ioMbps', () => {
  it('网络：汇总非 lo 接口收发字节差分，换算为 MB/s', () => {
    const mbps = ioMbps(fixture('netdev-prev.txt'), fixture('netdev-next.txt'), 'net', 1000)
    expect(mbps).toBeCloseTo(1, 5)
  })

  it('磁盘：仅统计整块盘（minor 0）扇区读写差分，换算为 MB/s', () => {
    const mbps = ioMbps(fixture('diskstats-prev.txt'), fixture('diskstats-next.txt'), 'disk', 1000)
    expect(mbps).toBeCloseTo(1, 5)
  })
})

describe('readHostSample', () => {
  const files: Record<string, string> = {
    [PROC_LOADAVG]: fixture('loadavg.txt'),
    [PROC_MEMINFO]: fixture('meminfo.txt'),
    [PROC_STAT]: fixture('stat-next.txt'),
    [PROC_NET_DEV]: fixture('netdev-next.txt'),
    [PROC_DISKSTATS]: fixture('diskstats-next.txt'),
  }

  it('无 prev 时 IO 与 CPU 差分为 0，仍解析负载与内存', async () => {
    const result = await readHostSample({
      readFile: async (path) => files[path] ?? '',
    })

    expect(result.sample).toEqual({
      cpu: 0,
      memory: 60,
      networkIo: 0,
      networkRx: 0,
      networkTx: 0,
      diskIo: 0,
      diskRead: 0,
      diskWrite: 0,
      load: { m1: 0.52, m5: 0.58, m15: 0.59 },
    })
    expect(result.nextPrev.stat).toBe(fixture('stat-next.txt'))
    expect(result.nextPrev.net).toBe(fixture('netdev-next.txt'))
    expect(result.nextPrev.disk).toBe(fixture('diskstats-next.txt'))
    expect(result.nextPrev.at).toBeGreaterThan(0)
  })

  it('有 prev 时按时间差计算 CPU 与 IO 吞吐', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const prevAt = 1_000

    const result = await readHostSample({
      readFile: async (path) => files[path] ?? '',
      prev: {
        stat: fixture('stat-prev.txt'),
        net: fixture('netdev-prev.txt'),
        disk: fixture('diskstats-prev.txt'),
        at: prevAt,
      },
    })

    expect(result.sample.cpu).toBe(50)
    expect(result.sample.memory).toBe(60)
    expect(result.sample.networkIo).toBeCloseTo(1, 5)
    expect(result.sample.networkRx + result.sample.networkTx).toBeCloseTo(result.sample.networkIo, 5)
    expect(result.sample.diskIo).toBeCloseTo(1, 5)
    expect(result.sample.diskRead + result.sample.diskWrite).toBeCloseTo(result.sample.diskIo, 5)
    expect(result.sample.load.m1).toBe(0.52)
    nowSpy.mockRestore()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
})
