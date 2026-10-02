import { describe, expect, it, vi } from 'vitest'

/*
 * Docker 采样链路的 /proc 与 df 对接测试。vitest 不加载 bun:sqlite（见 vitest.config.ts 注释），
 * 这里 mock 掉 metricsStore；df 与 /proc 全部用注入的固定文本还原 Linux 真实格式，
 * 不执行任何真实命令、不读任何真实文件。
 */

vi.mock('../hostMetrics/metricsStore.ts', () => ({
  METRICS_SQLITE_PATH: '/tmp/elysian-test-metrics.sqlite',
  openMetricsStore: () => {
    throw new Error('测试不应打开指标库')
  },
}))

import { readHostSampleFromProc } from './mockEventsPlugin.node'

/** Linux /proc 固定样例：loadavg、meminfo、stat、net/dev 与 diskstats 的真实格式。 */
const PROC_FILES: Record<string, string> = {
  '/proc/loadavg': '0.20 0.18 0.12 1/527 1234\n',
  '/proc/meminfo': 'MemTotal:       8000212 kB\nMemFree:         3900000 kB\nMemAvailable:    4000106 kB\n',
  '/proc/stat': 'cpu  123 1 200 99999 100 0 0 0 0 0\ncpu0 123 1 200 99999 100 0 0 0 0 0\n',
  '/proc/net/dev':
    'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eth0: 2000000 3000 0 0 0 0 0 0 1000000 2000 0 0 0 0 0 0\n',
  '/proc/diskstats': '   7       0 sda 4096 100 8192 1000 2048 50 4096 500 0 500 1500\n',
}

describe('readHostSampleFromProc', () => {
  it('/proc 样例按真实格式解析：内存、负载与无前置采样的 CPU', async () => {
    const { sample, nextPrev } = await readHostSampleFromProc(undefined, (path) =>
      Promise.resolve(PROC_FILES[path] ?? ''),
    )
    // (8000212 - 4000106) / 8000212 ≈ 50%。
    expect(sample.memory).toBe(50)
    expect(sample.load).toEqual({ m1: 0.2, m5: 0.18, m15: 0.12 })
    // 无前置采样：CPU 与 IO 速率为 0，原始文本进 nextPrev 供下一拍求差。
    expect(sample.cpu).toBe(0)
    expect(sample.networkIo).toBe(0)
    expect(sample.diskIo).toBe(0)
    expect(nextPrev.stat).toBe(PROC_FILES['/proc/stat'])
    expect(nextPrev.net).toBe(PROC_FILES['/proc/net/dev'])
    expect(nextPrev.disk).toBe(PROC_FILES['/proc/diskstats'])
  })
})
