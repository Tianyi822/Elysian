import { constants as fsConstants } from 'node:fs'
import { mkdir, mkdtemp, lstat, open, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOG_SHARD_MAX_BYTES } from '@elysian/contracts'
import { serializeRuntimeLogRecord, type RuntimeLogRecord } from './logRecords'
import { logShardName } from './logsPaths'
import { createLogWriter, type LogWriter, type LogWriterDeps } from './logWriter'

/*
 * 写入器的行为测试：真临时目录 + 真实 fs 原语（宿主机安全，不执行任何系统命令）、
 * 注入时钟。覆盖首次写建目录、采用当日片、跨天封盘、超阈值封盘、同时命中只封一次、
 * 恰好落在阈值上、并发不交错、符号链接占位失败计数、目录被删后自愈、巡检不阻塞 append。
 */

const CEILING = LOG_SHARD_MAX_BYTES

let root = ''
let clock = new Date('2026-09-23T03:15:00.000Z')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elysian-logs-writer-'))
  clock = new Date('2026-09-23T03:15:00.000Z')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 真实 fs 原语（与 logsHostDeps 同形，测试自带一份以免接线层的 bug 掩盖写入器的 bug）。 */
function createDeps(overrides: Partial<LogWriterDeps> = {}): LogWriterDeps {
  return {
    platformLogsDir: root,
    now: () => clock,
    ensureDir: async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 })
    },
    listNames: async (dir) => readdir(dir).catch(() => []),
    sizeOf: async (path) => stat(path).then((info) => info.size, () => null),
    isRegularFile: async (path) => lstat(path).then((info) => info.isFile(), () => false),
    appendLine: async (path, line) => {
      const handle = await open(
        path,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
        0o600,
      )
      try {
        await handle.write(line)
      } finally {
        await handle.close()
      }
    },
    requestSweep: () => {},
    ...overrides,
  }
}

function runtimeDir(): string {
  return join(root, 'runtime')
}

async function listRuntimeNames(): Promise<string[]> {
  return (await readdir(runtimeDir()).catch(() => [])).sort()
}

function record(seq: number, message = `第 ${seq} 条`): RuntimeLogRecord {
  return { at: clock.toISOString(), seq, level: 'info', source: 'logs.test', message }
}

async function readLines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0)
}

describe('首次写入与活动片采用', () => {
  it('装配期零副作用：没写过日志时不建目录、不上报巡检', async () => {
    const sweeps: string[] = []
    const writer = createLogWriter(createDeps({ requestSweep: (reason) => sweeps.push(reason) }), 'runtime')
    expect(writer.currentPath()).toBeNull()
    expect(writer.counters()).toEqual({ droppedRecords: 0, failedWrites: 0 })
    // 装配 + 一次读取目录：目录仍不存在。
    await expect(stat(runtimeDir())).rejects.toThrow()
    expect(sweeps).toEqual([])
  })

  it('首次 append 建目录（0700）、写第一行，并上报一次 first-write', async () => {
    const sweeps: { reason: string; at: number }[] = []
    const writer = createLogWriter(
      createDeps({
        requestSweep: (reason) => {
          sweeps.push({ reason, at: Date.now() })
        },
      }),
      'runtime',
    )
    await writer.append(record(1))
    await writer.append(record(2))

    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260923T031500Z.jsonl'))
    expect((await stat(runtimeDir())).isDirectory()).toBe(true)
    expect((await stat(runtimeDir())).mode & 0o777).toBe(0o700)
    expect(await listRuntimeNames()).toEqual(['runtime-20260923T031500Z.jsonl'])
    expect(await readLines(writer.currentPath()!)).toEqual([
      serializeRuntimeLogRecord(record(1)),
      serializeRuntimeLogRecord(record(2)),
    ])
    // first-write 只上报一次；没有封盘就没有 after-roll。
    expect(sweeps.map((entry) => entry.reason)).toEqual(['first-write'])
  })

  it('沿用当日分片继续写（重启不制造碎片）', async () => {
    await mkdir(runtimeDir(), { recursive: true })
    const existing = join(runtimeDir(), 'runtime-20260923T010000Z.jsonl')
    await writeFile(existing, '{"at":"2026-09-23T01:00:00.000Z","seq":1,"level":"info","source":"old","message":"旧行"}\n')

    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(2))

    expect(writer.currentPath()).toBe(existing)
    expect(await listRuntimeNames()).toEqual(['runtime-20260923T010000Z.jsonl'])
    expect((await readLines(existing)).length).toBe(2)
  })

  it('最大分片不是今天 → 新建今天的片（旧片留作已封盘片）', async () => {
    await mkdir(runtimeDir(), { recursive: true })
    await writeFile(join(runtimeDir(), 'runtime-20260922T010000Z.jsonl'), 'x\n')

    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))

    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260923T031500Z.jsonl'))
    expect(await listRuntimeNames()).toEqual([
      'runtime-20260922T010000Z.jsonl',
      'runtime-20260923T031500Z.jsonl',
    ])
  })

  it('只采用未压缩的当日片：已压缩的当日片不参与（活动片永远是 .jsonl）', async () => {
    await mkdir(runtimeDir(), { recursive: true })
    await writeFile(join(runtimeDir(), 'runtime-20260923T010000Z.jsonl.gz'), 'not-really-gzip')

    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))

    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260923T031500Z.jsonl'))
  })

  it('同名冲突按 `_2` 后缀新建（同秒第二次分片）', async () => {
    await mkdir(runtimeDir(), { recursive: true })
    // 占掉基本名（同秒）：采用分支不会选中它——日键相同也会被采用，因此换成「超阈值」逼它封盘。
    const taken = logShardName('runtime', clock, false)
    await writeFile(join(runtimeDir(), taken), 'x'.repeat(CEILING))

    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))

    expect(await listRuntimeNames()).toContain(`${logShardName('runtime', clock, false, 2)}`)
    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260923T031500Z_2.jsonl'))
  })
})

describe('滚动分片', () => {
  it('跨 UTC 自然日封盘：新片名取本次写入时刻', async () => {
    const sweeps: string[] = []
    const writer = createLogWriter(createDeps({ requestSweep: (reason) => sweeps.push(reason) }), 'runtime')
    await writer.append(record(1))
    const first = writer.currentPath()
    clock = new Date('2026-09-24T00:00:01.000Z')
    await writer.append(record(2))

    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260924T000001Z.jsonl'))
    expect(writer.currentPath()).not.toBe(first)
    expect(await listRuntimeNames()).toHaveLength(2)
    expect(sweeps).toEqual(['first-write', 'after-roll'])
    expect((await readLines(first!)).length).toBe(1)
  })

  it('跨阈值封盘：当前片 + 本行 > 8 MiB 即换新片', async () => {
    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))
    const shard = writer.currentPath()!

    const line = serializeRuntimeLogRecord(record(2))
    const lineBytes = Buffer.byteLength(line, 'utf8')
    // 预置：让 size + lineBytes 恰好超过上限一个字节。
    await writeFile(shard, 'x'.repeat(CEILING - lineBytes + 1))
    clock = new Date('2026-09-23T03:20:00.000Z')
    await writer.append(record(2))

    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260923T032000Z.jsonl'))
    expect(await listRuntimeNames()).toHaveLength(2)
  })

  it('恰好落在阈值上不封盘（判定是严格大于）', async () => {
    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))
    const shard = writer.currentPath()!

    const line = serializeRuntimeLogRecord(record(2))
    const lineBytes = Buffer.byteLength(line, 'utf8')
    await writeFile(shard, 'x'.repeat(CEILING - lineBytes))
    await writer.append(record(2))

    // 没换片；文件最终大小 = 上限 + 换行。
    expect(writer.currentPath()).toBe(shard)
    expect(await listRuntimeNames()).toHaveLength(1)
    expect((await stat(shard)).size).toBe(CEILING + 1)
  })

  it('跨天与超阈值同时命中只封一次盘、只产生一个新片', async () => {
    clock = new Date('2026-09-23T23:59:00.000Z')
    const sweeps: string[] = []
    const writer = createLogWriter(createDeps({ requestSweep: (reason) => sweeps.push(reason) }), 'runtime')
    await writer.append(record(1))
    const full = writer.currentPath()!

    // 把活动片垫到「再写一行就超阈值」，然后让时钟跨过 UTC 日界：两个条件同时命中。
    const line = serializeRuntimeLogRecord(record(2))
    await writeFile(full, 'x'.repeat(CEILING - Buffer.byteLength(line, 'utf8') + 1))
    clock = new Date('2026-09-24T00:00:01.000Z')
    await writer.append(record(2))

    expect(await listRuntimeNames()).toEqual([
      'runtime-20260923T235900Z.jsonl',
      'runtime-20260924T000001Z.jsonl',
    ])
    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260924T000001Z.jsonl'))
    // 只封一次盘 → 只上报一次 after-roll。
    expect(sweeps).toEqual(['first-write', 'after-roll'])
  })

  it('活动片缺失（外部删除）不用旧时刻的名字原地重建', async () => {
    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))
    const first = writer.currentPath()!
    await rm(first)

    clock = new Date('2026-09-23T04:00:00.000Z')
    await writer.append(record(2))

    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260923T040000Z.jsonl'))
  })
})

describe('并发与失败路径', () => {
  it('并发 100 次 append 串行落地：不交错、行数与内容完整', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const inner = createDeps().appendLine
    const writer = createLogWriter(
      createDeps({
        appendLine: async (path, line) => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise((resolve) => setTimeout(resolve, 1))
          try {
            await inner(path, line)
          } finally {
            inFlight -= 1
          }
        },
      }),
      'runtime',
    )

    await Promise.all(Array.from({ length: 100 }, (_, index) => writer.append(record(index + 1))))

    expect(maxInFlight).toBe(1)
    const lines = await readLines(writer.currentPath()!)
    expect(lines).toHaveLength(100)
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1))
    expect(writer.counters()).toEqual({ droppedRecords: 0, failedWrites: 0 })
  })

  it('分片路径被符号链接占位时顺延到 `_2` 继续写：不写穿、不丢行、不计失败', async () => {
    const target = join(root, 'victim.jsonl')
    await writeFile(target, '')
    await mkdir(runtimeDir(), { recursive: true })
    const squatted = join(runtimeDir(), logShardName('runtime', clock, false))
    await symlink(target, squatted)

    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))
    await writer.append(record(2))

    // 占位者被当作不可写（lstat 判定），既不采用它、也不替外部删它；写入顺延到 `_2`。
    expect(writer.currentPath()).toBe(join(runtimeDir(), logShardName('runtime', clock, false, 2)))
    expect(writer.counters()).toEqual({ droppedRecords: 0, failedWrites: 0 })
    expect(await readLines(writer.currentPath()!)).toEqual([
      serializeRuntimeLogRecord(record(1)),
      serializeRuntimeLogRecord(record(2)),
    ])
    expect(await readFile(target, 'utf8')).toBe('')
    expect((await lstat(squatted)).isSymbolicLink()).toBe(true)
  })

  it('采用分支只认普通文件：同日有真片时不因链接名字更大而上钩', async () => {
    await mkdir(runtimeDir(), { recursive: true })
    const real = join(runtimeDir(), 'runtime-20260923T010000Z.jsonl')
    await writeFile(real, 'x\n')
    const target = join(root, 'victim3.jsonl')
    await writeFile(target, '')
    // 名字更大（更晚）的符号链接正好是「取名字最大者」判据会先撞上的那一个。
    await symlink(target, join(runtimeDir(), 'runtime-20260923T230000Z.jsonl'))

    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))

    expect(writer.currentPath()).toBe(real)
    expect(writer.counters().failedWrites).toBe(0)
    expect(await readFile(target, 'utf8')).toBe('')
  })

  it('分片名被目录占位时同样顺延（目录不是可写文件）', async () => {    await mkdir(join(runtimeDir(), logShardName('runtime', clock, false)), { recursive: true })

    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))

    expect(writer.currentPath()).toBe(join(runtimeDir(), logShardName('runtime', clock, false, 2)))
    expect(writer.counters().failedWrites).toBe(0)
  })

  it('活动片路径被换成符号链接后不卡死：下一次 append 换到可写的名字，链接目标不受影响', async () => {
    const target = join(root, 'victim2.jsonl')
    await writeFile(target, '')
    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))
    const first = writer.currentPath()!
    await rm(first)
    await symlink(target, first)

    clock = new Date('2026-09-23T04:00:00.000Z')
    await writer.append(record(2))

    expect(writer.counters().failedWrites).toBe(0)
    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260923T040000Z.jsonl'))
    expect(await readFile(target, 'utf8')).toBe('')
  })

  it('超长记录（64 KiB 硬闸）丢弃并计数，不写盘也不抛错', async () => {
    const writer = createLogWriter(createDeps(), 'runtime')
    // at 是唯一不参与净化的字段（只由服务端时钟生成）：用超长 at 构造一条越过硬闸的记录。
    await writer.append({ at: 'x'.repeat(70_000), seq: 1, level: 'info', source: 'logs.test', message: 'b' })
    expect(writer.counters()).toEqual({ droppedRecords: 1, failedWrites: 0 })
    expect(await listRuntimeNames()).toEqual([])
  })

  it('目录被外部删除后，下一次 append 自动重建目录并继续写', async () => {
    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))
    await rm(runtimeDir(), { recursive: true, force: true })

    await writer.append(record(2))

    expect((await stat(runtimeDir())).isDirectory()).toBe(true)
    expect(await listRuntimeNames()).toHaveLength(1)
    expect((await readLines(writer.currentPath()!)).length).toBe(1)
    expect(writer.counters().failedWrites).toBe(0)
  })

  it('巡检再慢也不阻塞 append 的返回（requestSweep 是 fire-and-forget）', async () => {
    const writer = createLogWriter(
      createDeps({
        // 永不落定的巡检：写入器若 await 它，append 就永远不返回。
        requestSweep: () => new Promise<void>(() => {}),
      }),
      'runtime',
    )
    await expect(writer.append(record(1))).resolves.toBeUndefined()
    expect(await listRuntimeNames()).toHaveLength(1)
  })

  it('append 失败不打断后续 append（队列不因单次失败断裂）', async () => {
    let failNext = true
    const inner = createDeps().appendLine
    const writer = createLogWriter(
      createDeps({
        appendLine: async (path, line) => {
          if (failNext) {
            failNext = false
            throw new Error('磁盘满')
          }
          await inner(path, line)
        },
      }),
      'runtime',
    )
    const original = console.error
    console.error = (() => {}) as typeof console.error
    try {
      await writer.append(record(1))
      await writer.append(record(2))
    } finally {
      console.error = original
    }
    expect(writer.counters().failedWrites).toBe(1)
    expect((await readLines(writer.currentPath()!)).length).toBe(1)
  })
})

describe('seal 与 sealAndRun', () => {
  it('seal 封盘并忘掉当前片：下一次 append 重新采用或新建', async () => {
    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))
    const first = writer.currentPath()!
    await writer.seal()
    expect(writer.currentPath()).toBeNull()

    // 当日片还在：采用分支会继续写它（封盘本身不改文件，只重置写入器状态）。
    await writer.append(record(2))
    expect(writer.currentPath()).toBe(first)
    expect((await readLines(first)).length).toBe(2)
  })

  it('sealAndRun 里的删除与 append 互不插入：清空后 append 落在新建的片', async () => {
    const writer = createLogWriter(createDeps(), 'runtime')
    const first = writer.append(record(1)).then(() => writer.currentPath()!)

    const cleared = writer.sealAndRun(async () => {
      // 任务里模拟清空：把目录下的分片全删掉。
      for (const name of await listRuntimeNames()) {
        await rm(join(runtimeDir(), name), { force: true })
      }
      return 'cleared'
    })
    // 队列顺序：append(1) → sealAndRun → append(2)，因此 append(2) 一定落在清空之后的空目录里。
    expect(await cleared).toBe('cleared')
    expect(await first).not.toBeNull()
    await writer.append(record(2))
    expect(await listRuntimeNames()).toEqual(['runtime-20260923T031500Z.jsonl'])
    expect((await readLines(writer.currentPath()!)).length).toBe(1)
  })

  it('sealAndRun 的任务抛错不会卡死队列（后续 append 照常）', async () => {
    const writer = createLogWriter(createDeps(), 'runtime')
    await expect(
      writer.sealAndRun(async () => {
        throw new Error('清空失败')
      }),
    ).rejects.toThrow('清空失败')
    await writer.append(record(1))
    expect(await listRuntimeNames()).toHaveLength(1)
  })
})

describe('sizeOf 与活动片的关系', () => {
  it('活动片文件消失时采用现存最大的当日片，不用旧时刻的名字原地重建', async () => {
    await mkdir(runtimeDir(), { recursive: true })
    const older = join(runtimeDir(), 'runtime-20260923T010000Z.jsonl')
    const active = join(runtimeDir(), 'runtime-20260923T020000Z.jsonl')
    await writeFile(older, 'x\n')
    await writeFile(active, 'y\n')

    const writer = createLogWriter(createDeps(), 'runtime')
    clock = new Date('2026-09-23T02:00:00.000Z')
    await writer.append(record(1))
    expect(writer.currentPath()).toBe(active)
    await rm(active)

    clock = new Date('2026-09-23T05:00:00.000Z')
    await writer.append(record(2))
    // 采用现存最大的当日片（不是重建被删掉的 02:00，也不是新建 05:00）。
    expect(writer.currentPath()).toBe(older)
    expect(await listRuntimeNames()).toEqual(['runtime-20260923T010000Z.jsonl'])
    expect((await readLines(older)).length).toBe(2)
  })

  it('采用已封盘但当日、且已超阈值的片时立刻封盘（不往满片里硬塞）', async () => {
    await mkdir(runtimeDir(), { recursive: true })
    const existing = join(runtimeDir(), 'runtime-20260923T010000Z.jsonl')
    await writeFile(existing, 'x'.repeat(CEILING))
    await utimes(existing, clock, clock)

    const writer = createLogWriter(createDeps(), 'runtime')
    await writer.append(record(1))
    expect(writer.currentPath()).toBe(join(runtimeDir(), 'runtime-20260923T031500Z.jsonl'))
  })
})

describe('操作日志类别', () => {
  it('写出的是操作日志目录与操作日志行', async () => {
    const writer: LogWriter = createLogWriter(createDeps(), 'operation')
    await writer.append({
      at: clock.toISOString(),
      seq: 7,
      category: 'logs',
      action: '清空运行日志',
      target: null,
      result: 'success',
      httpStatus: 200,
      method: 'POST',
      path: '/api/logs/runtime/clear',
      summary: '',
    })
    expect(writer.currentPath()).toBe(join(root, 'operation', 'operation-20260923T031500Z.jsonl'))
    const [line] = await readLines(writer.currentPath()!)
    expect(JSON.parse(line!)).toMatchObject({ category: 'logs', seq: 7 })
  })
})
