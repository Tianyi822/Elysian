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

import { parseDf } from '../hostMetrics/readHostSample.ts'
import { DF_ARGS, readHostSampleFromProc } from './mockEventsPlugin.node'

/** Linux /proc 固定样例：loadavg、meminfo、stat、net/dev、diskstats 与 df 的真实格式。 */
const PROC_FILES: Record<string, string> = {
  '/proc/loadavg': '0.20 0.18 0.12 1/527 1234\n',
  '/proc/meminfo': 'MemTotal:       8000212 kB\nMemFree:         3900000 kB\nMemAvailable:    4000106 kB\n',
  '/proc/stat': 'cpu  123 1 200 99999 100 0 0 0 0 0\ncpu0 123 1 200 99999 100 0 0 0 0 0\n',
  '/proc/net/dev':
    'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n  lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0\n  eth0: 2000000 3000 0 0 0 0 0 0 1000000 2000 0 0 0 0 0 0\n',
  '/proc/diskstats': '   7       0 sda 4096 100 8192 1000 2048 50 4096 500 0 500 1500\n',
}

/** df -k -P 的 POSIX 单行输出：容量列为纯数字 KiB，与 parseDf 的解析约定一致。 */
const DF_KIB_OUTPUT =
  'Filesystem     1024-blocks      Used Available Capacity Mounted on\n' +
  '/dev/vda1         61784384  20538368  38059012      36% /\n'

/** 同一块盘的 df -h -P 输出：人类可读列（59G/20G）就是被误截成两位数的 bug 形态。 */
const DF_HUMAN_OUTPUT =
  'Filesystem      Size  Used Avail Use% Mounted on\n' + '/dev/vda1        59G   20G   37G  36% /\n'

describe('df 采样参数与解析约定', () => {
  it('df 输出纯数字 KiB 列：参数固定为 -k -P', () => {
    expect(DF_ARGS).toEqual(['-k', '-P'])
  })

  it('人类可读列按纯数字解析会错约 6 个数量级：解析约定只认 KiB 数字列', () => {
    const parsed = parseDf(DF_HUMAN_OUTPUT)
    expect(parsed).toHaveLength(1)
    // '59G'/'20G' 被 parseInt 截断成 59/20——这正是修复前的 Docker 磁盘数值。
    expect(parsed[0]).toMatchObject({ sizeKb: 59, usedKb: 20 })
  })
})

describe('readHostSampleFromProc', () => {
  it('df 输出与解析约定一致：磁盘容量落在真实 KiB 量级，不再是两位数', async () => {
    const { sample } = await readHostSampleFromProc(undefined, async () => DF_KIB_OUTPUT, (path) =>
      Promise.resolve(PROC_FILES[path] ?? ''),
    )
    expect(sample.disks).toEqual([{ mount: '/', usagePct: 36, usedKb: 20538368, sizeKb: 61784384 }])
    // 量级断言：约 60 GB 的盘是数千万 KiB；人类可读误解析只会得到几十。
    expect(sample.disks[0]!.sizeKb).toBeGreaterThan(10_000_000)
    expect(sample.disks[0]!.sizeKb).toBeLessThan(1_000_000_000)
  })

  it('/proc 样例按真实格式解析：内存、负载与无前置采样的 CPU', async () => {
    const { sample, nextPrev } = await readHostSampleFromProc(undefined, async () => DF_KIB_OUTPUT, (path) =>
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
