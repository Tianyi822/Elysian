import { constants as fsConstants, createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGunzip, createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PlatformLogCategory } from '@elysian/contracts'
import { parseLoginLogLine, parseOperationLogLine, parseRuntimeLogLine } from './logRecords'
import type { LogShardCategory } from './logsPaths'
import { createLogWriter } from './logWriter'
import { LOG_SWEEP_INTERVAL_MS, createLogsService, type LogsService } from './logsService'
import type { LogRetentionDeps } from './logRetention'

/*
 * 服务编排的行为测试：真临时目录 + 真实 fs/zlib，注入时钟与定时器出口。
 * 覆盖列表（运行与操作都倒序）、清空（含自指留痕与串行语义）、计数器、
 * clear 与 sweep 的互斥、巡检合并、fire-and-forget（巡检不阻塞 append 与读）。
 */

const NOW = new Date('2026-09-23T12:00:00.000Z')
const OLD_AGE_MS = 3 * 24 * 60 * 60 * 1000

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elysian-logs-service-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type Harness = {
  service: LogsService
  state: {
    failAppend: boolean
    gzipDelay: Promise<void> | null
    events: string[]
    timers: { onTick: () => void; intervalMs: number }[]
    /** 首次进入 gzipFile 时兑现：让「巡检已经进到 gzip」这件事有确定性信号，不靠定时器猜。 */
    gzipStarted: Promise<void>
    /** 可推进的注入时钟：让「哪一次巡检发生在什么时刻」可判定。 */
    clock: Date
  }
}

function createHarness(overrides: { failAppend?: boolean } = {}): Harness {
  let signalGzipStarted: () => void = () => {}
  const gzipStarted = new Promise<void>((resolve) => {
    signalGzipStarted = resolve
  })
  const state: Harness['state'] = {
    failAppend: overrides.failAppend ?? false,
    gzipDelay: null,
    events: [],
    timers: [],
    gzipStarted,
    clock: new Date(NOW),
  }

  const appendLine = async (path: string, line: string): Promise<void> => {
    if (state.failAppend) throw new Error('磁盘满')
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
  }

  const ensureDir = async (dir: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
  }

  /** 读取侧的列目录：只给普通文件（与真实接线同形）。 */
  const listRegularFiles = async (category: LogShardCategory) => {
    const listed: { path: string; name: string; sizeBytes: number }[] = []
    for (const name of await readdir(join(root, category)).catch(() => [])) {
      const path = join(root, category, name)
      try {
        const info = await lstat(path)
        if (!info.isFile()) continue
        listed.push({ path, name, sizeBytes: info.size })
      } catch {
        // 竞态：条目在列出与 lstat 之间消失。
      }
    }
    return listed
  }

  /** 保留/统计侧的列目录：给目录里的全部条目（含符号链接与子目录，子目录按递归字节和）。 */
  const listAllEntries = async (category: LogShardCategory) => {
    const listed: {
      path: string
      name: string
      sizeBytes: number
      mtimeMs: number
      kind: 'file' | 'directory' | 'symlink'
    }[] = []
    for (const name of await readdir(join(root, category)).catch(() => [])) {
      const path = join(root, category, name)
      try {
        const info = await lstat(path)
        listed.push({
          path,
          name,
          sizeBytes: info.isDirectory() ? await directorySizeBytes(path) : info.size,
          mtimeMs: info.mtimeMs,
          kind: info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'symlink',
        })
      } catch {
        // 竞态：条目在列出与 lstat 之间消失。
      }
    }
    return listed
  }

  const readLines = async (path: string, onLine: (line: string) => void): Promise<void> => {
    const source = createReadStream(path)
    const input = path.endsWith('.gz') ? source.pipe(createGunzip()) : source
    const reader = createInterface({ input, crlfDelay: Infinity })
    try {
      for await (const line of reader) onLine(line)
    } finally {
      reader.close()
      source.destroy()
    }
  }

  const gzipFile = async (src: string, dest: string): Promise<void> => {
    state.events.push(`gzip:${src}`)
    signalGzipStarted()
    if (state.gzipDelay !== null) await state.gzipDelay
    const info = await lstat(src)
    const tmp = `${dest}.tmp`
    await pipeline(createReadStream(src), createGzip(), createWriteStream(tmp, { mode: 0o600 }))
    await utimes(tmp, info.atime, info.mtime)
    await rename(tmp, dest)
  }

  const mkWriter = (category: LogShardCategory) =>
    createLogWriter(
      {
        platformLogsDir: root,
        now: () => state.clock,
        ensureDir,
        listNames: async (dir) => readdir(dir).catch(() => []),
        sizeOf: async (path) => stat(path).then((info) => info.size, () => null),
        isRegularFile: async (path) => lstat(path).then((info) => info.isFile(), () => false),
        appendLine,
        requestSweep: () => {},
      },
      category,
    )

  const readerFiles = { listFiles: listRegularFiles, readLines }

  const mkRetention = (): Omit<LogRetentionDeps, 'writer'> => ({
    platformLogsDir: root,
    now: () => state.clock,
    ensureDir,
    listFiles: listAllEntries,
    gzipFile,
    removeFile: async (path) => {
      state.events.push(`remove:${path}`)
      await rm(path, { recursive: true, force: true })
    },
  })

  const service = createLogsService({
    writers: { runtime: mkWriter('runtime'), operation: mkWriter('operation'), login: mkWriter('login') },
    readers: {
      runtime: { listFiles: readerFiles.listFiles, readLines: readerFiles.readLines, parseLine: parseRuntimeLogLine },
      operation: {
        listFiles: readerFiles.listFiles,
        readLines: readerFiles.readLines,
        parseLine: parseOperationLogLine,
      },
      login: { listFiles: readerFiles.listFiles, readLines: readerFiles.readLines, parseLine: parseLoginLogLine },
    },
    retention: { runtime: mkRetention(), operation: mkRetention(), login: mkRetention() },
    now: () => state.clock,
    startTimer: (onTick, intervalMs) => {
      state.timers.push({ onTick, intervalMs })
    },
  })

  return { service, state }
}

async function namesOf(category: PlatformLogCategory = 'runtime'): Promise<string[]> {
  return (await readdir(join(root, category)).catch(() => [])).sort()
}

/** 目录内容的递归字节和（不跟随符号链接）：与 logsHostDeps 的接线同形，测试自带一份。 */
async function directorySizeBytes(dir: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const child = join(dir, entry.name)
    try {
      const info = await lstat(child)
      if (info.isDirectory()) total += await directorySizeBytes(child)
      else total += info.size
    } catch {
      // 竞态：条目在列出与 lstat 之间消失。
    }
  }
  return total
}

async function linesOf(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter((line) => line.length > 0)
}

/** 预置一个已封盘分片（mtime 足够旧，可被压缩）。 */
async function seedShard(name: string, content: string, ageMs = OLD_AGE_MS): Promise<string> {
  await mkdir(join(root, 'runtime'), { recursive: true })
  const path = join(root, 'runtime', name)
  await writeFile(path, content)
  const mtime = new Date(NOW.getTime() - ageMs)
  await utimes(path, mtime, mtime)
  return path
}

/**
 * 预置一个指定字节数的分片（稀疏文件：逻辑大小到位、几乎不占磁盘），用来把总量顶过预算。
 * mtime 落在窗口内、且已静默：只有预算删除会动作。
 */
async function writeSparseShard(
  name: string,
  sizeBytes: number,
  category: PlatformLogCategory,
  ageMs = 24 * 60 * 60 * 1000,
): Promise<string> {
  await mkdir(join(root, category), { recursive: true })
  const path = join(root, category, name)
  await writeFile(path, '')
  await truncate(path, sizeBytes)
  const mtime = new Date(NOW.getTime() - ageMs)
  await utimes(path, mtime, mtime)
  return path
}

function runtimeLine(seq: number, message = `第 ${seq} 条`): string {
  return `{"at":"2026-09-23T11:00:00.000Z","seq":${seq},"level":"info","source":"logs.test","message":"${message}"}`
}

function yieldToQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('写运行日志与列表', () => {
  it('log 写入运行日志；列表倒序（新 → 旧）、字段齐全、带存储统计', async () => {
    const { service } = createHarness()

    await service.log('info', 'logs.test', '第一条')
    await service.log('warning', 'logs.test', '第二条')

    const report = await service.runtimeLog()

    expect(report.entries.map((entry) => entry.message)).toEqual(['第二条', '第一条'])
    expect(report.entries.map((entry) => entry.level)).toEqual(['warning', 'info'])
    expect(report.entries[0]).toMatchObject({
      at: NOW.toISOString(),
      source: 'logs.test',
      id: `${NOW.toISOString()}#2`,
    })
    expect(report).toMatchObject({ truncated: false, skippedLines: 0, skippedFiles: 0 })
    expect(report.storage).toMatchObject({
      operationBytes: 0,
      fileCount: 1,
      oldestAt: '2026-09-23T12:00:00Z',
      lastSweepAt: null,
      trimmedBySize: false,
      droppedRecords: 0,
      failedWrites: 0,
    })
    expect(report.storage.totalBytes).toBe(report.storage.runtimeBytes)
    expect(report.storage.runtimeBytes).toBeGreaterThan(0)
  })

  it('recordOperation 写入操作日志，列表倒序（新 → 旧）', async () => {
    const { service } = createHarness()

    await service.recordOperation({
      category: 'security',
      action: '修改 SSH 监听端口',
      result: 'success',
      httpStatus: 200,
      method: 'PUT',
      path: '/api/security/ssh/port',
      summary: '端口 2222',
    })
    await service.recordOperation({ category: 'files', action: '复制文件', result: 'failure', httpStatus: 500 })
    await service.recordOperation({ category: 'logs', action: '清空运行日志', result: 'success' })

    const report = await service.operationLog()

    expect(report.entries.map((entry) => entry.action)).toEqual(['清空运行日志', '复制文件', '修改 SSH 监听端口'])
    expect(report.entries[2]).toMatchObject({
      category: 'security',
      target: null,
      summary: '端口 2222',
      method: 'PUT',
      path: '/api/security/ssh/port',
      httpStatus: 200,
      result: 'success',
    })
    expect(report.storage.operationBytes).toBeGreaterThan(0)
    expect(report.storage.runtimeBytes).toBe(0)
    expect(report.storage.fileCount).toBe(1)
  })

  it('写盘失败只计数（storage.failedWrites），不影响调用方', async () => {
    const { service } = createHarness({ failAppend: true })
    const original = console.error
    console.error = (() => {}) as typeof console.error
    try {
      await expect(service.log('info', 'logs.test', '写不进去')).resolves.toBeUndefined()
      await service.recordOperation({ category: 'logs', action: '清空运行日志', result: 'success' })
    } finally {
      console.error = original
    }

    const report = await service.runtimeLog()
    // 两个写入器的失败计数合并上报。
    expect(report.storage.failedWrites).toBe(2)
    expect(report.storage.droppedRecords).toBe(0)
  })

  it('坏行与坏文件计入报告字段', async () => {
    const { service } = createHarness()
    await seedShard('runtime-20260922T000000Z.jsonl', `${runtimeLine(1)}\n不是 JSON\n`)
    await writeFile(join(root, 'runtime', 'runtime-20260921T000000Z.jsonl.gz'), '半截压缩产物')

    const report = await service.runtimeLog()

    expect(report.skippedLines).toBe(1)
    expect(report.skippedFiles).toBe(1)
    expect(report.entries.map((entry) => entry.message)).toEqual(['第 1 条'])
  })
})

describe('清空', () => {
  it('清空删除该类别全部日志文件并回报告，然后留下正好一条留痕', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史一')
    await service.log('info', 'logs.test', '历史二')
    await seedShard('runtime-20260922T000000Z.jsonl', `${runtimeLine(1, '旧片')}\n`)
    await seedShard('runtime-20260920T000000Z.jsonl.gz.tmp', '残留')
    expect(await namesOf()).toHaveLength(3)

    const report = await service.clear('runtime')

    expect(report).toMatchObject({
      category: 'runtime',
      fileCount: 2, // 活动片 + 已封盘片；.tmp 残留被删但不进入统计口径
      oldestAt: '2026-09-22T00:00:00Z',
      clearedAt: NOW.toISOString(),
    })
    expect(report.totalBytes).toBeGreaterThan(0)
    // 清空后：只剩新建的活动片，里面正好一条「已清空」留痕。
    expect(await namesOf()).toHaveLength(1)
    const after = await service.runtimeLog()
    expect(after.entries).toHaveLength(1)
    expect(after.entries[0]?.level).toBe('warning')
    expect(after.entries[0]?.source).toBe('logs.clear')
    expect(after.entries[0]?.message).toMatch(/^运行日志已清空：删除 2 个文件，释放 [\d.]+ (KB|MB|GB)$/)
  })

  it('连清两次状态等价：第二次删掉的正是第一次的留痕文件', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史')

    const first = await service.clear('runtime')
    const leftover = (await namesOf())[0]!
    const leftoverSize = (await lstat(join(root, 'runtime', leftover))).size
    const second = await service.clear('runtime')

    expect(first.fileCount).toBe(1)
    // 第一次之后目录里只剩「已清空」留痕那一个文件，第二次删掉的就是它——报告里的数字
    // 逐字对上那个文件（文件数、字节、片名时刻），证明删的是留痕而不是别的什么。
    // 幂等体现在「两次之后的状态一致」，而不是第二次的文件数为 0：后者与 §7.2 自己的
    // 自指留痕（清空必须把留痕写回新文件）互斥，两条规则不可能同时成立，这里选留痕
    // ——前端的 adapter 契约也要求「该类别最多剩 1 条，且若剩 1 条必须是本次清空的留痕」。
    expect(second.fileCount).toBe(1)
    expect(second.totalBytes).toBe(leftoverSize)
    expect(second.oldestAt).toBe('2026-09-23T12:00:00Z')
    expect(await namesOf()).toHaveLength(1)
    expect((await service.runtimeLog()).entries).toHaveLength(1)
  })

  it('清空从未写过日志的类别：fileCount 与字节都是 0，oldestAt 为 null', async () => {
    const { service } = createHarness()

    const report = await service.clear('operation')

    expect(report).toMatchObject({ category: 'operation', fileCount: 0, totalBytes: 0, oldestAt: null })
    expect(report.clearedAt).toBe(NOW.toISOString())
    expect(await namesOf('operation')).toEqual([])
  })

  it('清空清掉该类别目录里的一切条目（含非本模块命名、符号链接与子目录），链接目标与目录外文件不受影响', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史')
    await writeFile(join(root, 'runtime', 'notes.txt'), '手工放进来的笔记')
    await writeFile(join(root, 'runtime', 'runtime-20260920T000000Z.jsonl.gz.tmp'), '压缩残留')
    const outsideDir = join(root, 'outside')
    await mkdir(outsideDir, { recursive: true })
    const outsideFile = join(outsideDir, 'data.bin')
    await writeFile(outsideFile, '外部文件的内容')
    await symlink(outsideFile, join(root, 'runtime', 'notes-link.txt'))
    const innerDir = join(root, 'runtime', 'attachments')
    await mkdir(innerDir, { recursive: true })
    await writeFile(join(innerDir, 'a.bin'), 'y'.repeat(64))
    await symlink(outsideDir, join(root, 'runtime', 'dir-link'))

    const report = await service.clear('runtime')

    // 活动片 + notes.txt + 链接 + 子目录 + 目录链接都计入报告（.tmp 删掉但不计）；
    // 报告里的字节含子目录的递归和。
    expect(report.fileCount).toBe(5)
    expect(report.totalBytes).toBeGreaterThan(64)
    expect(await namesOf()).toEqual(['runtime-20260923T120000Z.jsonl'])
    // 链接目标与目录外的文件都不受影响（清空从不跟随链接）。
    expect(await readFile(outsideFile, 'utf8')).toBe('外部文件的内容')
    expect((await readdir(outsideDir)).sort()).toEqual(['data.bin'])
  })

  it('清空只清本类别：另一个类别目录里的文件不动', async () => {
    const { service } = createHarness()
    await mkdir(join(root, 'runtime'), { recursive: true })
    await writeFile(join(root, 'runtime', 'sshd.log'), 'sshd 自己的日志')
    await writeFile(join(root, 'runtime', 'not-a-shard.txt'), '外部文件')
    await service.recordOperation({ category: 'logs', action: '清空操作日志', result: 'success' })

    const report = await service.clear('operation')

    expect(report.fileCount).toBe(1)
    // 操作日志那条「已清空」留痕由采集中间件写（本层不替它写），所以清空后该目录是空的。
    expect(await namesOf('operation')).toEqual([])
    // 运行日志另写一条 warning 留痕；另一个类别目录里的文件原样不动。
    expect(await namesOf()).toEqual([
      'not-a-shard.txt',
      'runtime-20260923T120000Z.jsonl',
      'sshd.log',
    ])
    const trace = (await service.runtimeLog()).entries.at(-1)
    expect(trace?.source).toBe('logs.clear')
    expect(trace?.message).toMatch(/^操作日志已清空：删除 1 个文件，释放 /)
  })

  it('清空与 append 的串行语义：清空期间排队的 append 落在新建的分片里', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史')

    const clearing = service.clear('runtime')
    // 让 clear 先取到维护锁并把「封盘 + 删除」排进写入队列。
    await yieldToQueue()
    const appending = service.log('info', 'logs.test', '清空期间写入')
    await Promise.all([clearing, appending])

    const names = await namesOf()
    expect(names).toHaveLength(1)
    const lines = await linesOf(join(root, 'runtime', names[0]!))
    // 「清空留痕」与「排队中的 append」都排在 seal 之后，谁先落地取决于 clear 的续体与
    // 调用方的 append 谁先到达写入队列——两者的先后不作承诺；承诺的是：清空前的历史不再出现、
    // 排队的那条不丢、且两条都落在**新建的**分片里（没有被写进刚被删掉的文件）。
    expect(lines).toHaveLength(2)
    expect(lines.some((line) => line.includes('运行日志已清空'))).toBe(true)
    expect(lines.some((line) => line.includes('清空期间写入'))).toBe(true)
    expect(lines.some((line) => line.includes('历史'))).toBe(false)
  })

  it('清空后新的 append 写进新建的分片（不写进刚被删掉的文件名）', async () => {
    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史')
    await service.clear('runtime')

    await service.log('info', 'logs.test', '清空之后')

    const names = await namesOf()
    expect(names).toHaveLength(1)
    const messages = (await linesOf(join(root, 'runtime', names[0]!))).map((line) => JSON.parse(line).message)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatch(/^运行日志已清空：/)
    expect(messages[1]).toBe('清空之后')
  })
})

describe('巡检', () => {
  it('runSweep 压缩已封盘分片、写入巡检状态，并把时间写进 storage', async () => {
    const { service } = createHarness()
    await seedShard('runtime-20260920T000000Z.jsonl', `${runtimeLine(1)}\n`)

    const result = await service.runSweep('runtime', 'manual')

    expect(result.compressed).toBe(1)
    // 压缩产物就位；目录里同时有巡检自己那条留痕新建的活动片。
    expect(await namesOf()).toEqual(['runtime-20260920T000000Z.jsonl.gz', 'runtime-20260923T120000Z.jsonl'])
    const report = await service.runtimeLog()
    expect(report.storage.lastSweepAt).toBe(NOW.toISOString())
    expect(report.storage.trimmedBySize).toBe(false)
    // 巡检自己也留痕：压缩 1、删除 0、释放 0。
    expect(
      report.entries.some((entry) => entry.source === 'logs.retention' && entry.message.includes('压缩 1')),
    ).toBe(true)
  })

  it('首次巡检请求注册定时器（每类别一次，间隔 5 分钟）', async () => {
    const { service, state } = createHarness()
    expect(state.timers).toHaveLength(0)

    await service.runSweep('runtime', 'manual')
    await service.runSweep('runtime', 'manual')
    expect(state.timers).toHaveLength(1)

    await service.runSweep('operation', 'manual')
    expect(state.timers).toHaveLength(2)
    expect(LOG_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000)
    expect(state.timers[0]?.intervalMs).toBe(LOG_SWEEP_INTERVAL_MS)
  })

  it('并发触发同一类别合并到同一次（返回同一个结果）', async () => {
    const harness = createHarness()
    let release: () => void = () => {}
    harness.state.gzipDelay = new Promise<void>((resolve) => {
      release = resolve
    })
    await harness.service.log('info', 'logs.test', '让目录里有活动片')
    await seedShard('runtime-20260920T000000Z.jsonl', `${runtimeLine(1)}\n`)

    const first = harness.service.runSweep('runtime', 'manual')
    const second = harness.service.runSweep('runtime', 'manual')
    expect(second).toBe(first)

    release()
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(a.compressed).toBe(1)
  })

  it('巡检执行期间 append 与读请求不被阻塞（fire-and-forget）', async () => {
    const harness = createHarness()
    let release: () => void = () => {}
    harness.state.gzipDelay = new Promise<void>((resolve) => {
      release = resolve
    })
    await harness.service.log('info', 'logs.test', '历史')
    await seedShard('runtime-20260920T000000Z.jsonl', `${runtimeLine(1)}\n`)

    const sweeping = harness.service.runSweep('runtime', 'manual')
    await harness.state.gzipStarted
    expect(harness.state.events.some((event) => event.startsWith('gzip:'))).toBe(true)

    // 巡检卡在 gzip 上时，写与读都照常完成。
    await harness.service.log('info', 'logs.test', '巡检期间写入')
    const report = await harness.service.runtimeLog()
    expect(report.entries.some((entry) => entry.message === '巡检期间写入')).toBe(true)

    release()
    await sweeping
  })

  it('巡检状态按类别：操作日志的裁剪不出现在运行日志报告里，也不被无关巡检重置', async () => {
    const harness = createHarness()
    await harness.service.log('info', 'logs.test', '运行日志一条')
    // 操作日志的预算是 64 MiB：用稀疏文件把总量顶到 80 MiB，只有预算删除会动作
    // （mtime 在窗口内、也已静默）。
    await writeSparseShard('operation-20260920T000000Z.jsonl.gz', 40 * 1024 * 1024, 'operation')
    await writeSparseShard('operation-20260922T000000Z.jsonl.gz', 40 * 1024 * 1024, 'operation')

    const sweep = await harness.service.runSweep('operation', 'manual')
    expect(sweep.trimmedBySize).toBe(true)
    expect((await harness.service.operationLog()).storage.trimmedBySize).toBe(true)
    // G1：另一个类别的报告不受影响。
    expect((await harness.service.runtimeLog()).storage.trimmedBySize).toBe(false)

    // G1b：无关类别（运行日志）的一次普通巡检不会把它冲掉。
    harness.state.clock = new Date(NOW.getTime() + 60_000)
    await harness.service.runSweep('runtime', 'manual')
    expect((await harness.service.operationLog()).storage.trimmedBySize).toBe(true)
    expect((await harness.service.operationLog()).storage.lastSweepAt).toBe(NOW.toISOString())

    // 该类别自己的下一次巡检（这次没删东西）才把它归位。
    harness.state.clock = new Date(NOW.getTime() + 120_000)
    await harness.service.runSweep('operation', 'manual')
    expect((await harness.service.operationLog()).storage.trimmedBySize).toBe(false)
    expect((await harness.service.operationLog()).storage.lastSweepAt).toBe(
      new Date(NOW.getTime() + 120_000).toISOString(),
    )
  })

  it('clear 与 sweep 互斥：并发触发时清空等巡检结束', async () => {
    const harness = createHarness()
    await harness.service.log('info', 'logs.test', '历史')
    await seedShard('runtime-20260920T000000Z.jsonl', `${runtimeLine(1)}\n`)
    let release: () => void = () => {}
    harness.state.gzipDelay = new Promise<void>((resolve) => {
      release = resolve
    })

    const sweeping = harness.service.runSweep('runtime', 'manual')
    await harness.state.gzipStarted
    const clearing = harness.service.clear('runtime')
    await yieldToQueue()
    // 巡检还没结束，清空还没动过任何文件。
    expect(harness.state.events.filter((event) => event.startsWith('remove:'))).toEqual([])

    release()
    await sweeping
    const report = await clearing

    // 清空看到的是巡检之后的目录：压缩包与残留都被清掉，报告里两件都算上。
    expect(report.fileCount).toBe(2)
    expect(await namesOf()).toHaveLength(1)
    expect((await linesOf(join(root, 'runtime', (await namesOf())[0]!))).length).toBe(1)
  })

  it('清空与保留动作交叉：清空期间排队的巡检不会复活被删的文件', async () => {
    const harness = createHarness()
    await harness.service.log('info', 'logs.test', '历史')
    await seedShard('runtime-20260920T000000Z.jsonl', `${runtimeLine(1)}\n`)

    const clearing = harness.service.clear('runtime')
    await yieldToQueue()
    const sweeping = harness.service.runSweep('runtime', 'manual')
    await Promise.all([clearing, sweeping])

    // 目录里只剩清空后的留痕文件；巡检没有把被删的片重新压出来。
    const names = await namesOf()
    expect(names).toHaveLength(1)
    expect(names).not.toContain('runtime-20260920T000000Z.jsonl.gz')
    const lines = await linesOf(join(root, 'runtime', names[0]!))
    // 清空留痕在前，排在其后的巡检摘要（manual 那次）也落在同一个新片里。
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).source).toBe('logs.clear')
    expect(JSON.parse(lines[1]!).source).toBe('logs.retention')
  })

  it('after-clear 的巡检不再重复写摘要行（清空后正好一条留痕）', async () => {    const { service } = createHarness()
    await service.log('info', 'logs.test', '历史')

    await service.clear('runtime')

    const report = await service.runtimeLog()
    expect(report.entries).toHaveLength(1)
    expect(report.entries[0]?.source).toBe('logs.clear')
    // 但巡检状态仍被 after-clear 更新（清空携带的巡检确实跑过）。
    expect(report.storage.lastSweepAt).toBe(NOW.toISOString())
  })

  it('巡检失败只计数，不抛给调用方', async () => {
    const { service } = createHarness()
    await seedShard('runtime-20260920T000000Z.jsonl', `${runtimeLine(1)}\n`)
    const original = console.error
    console.error = (() => {}) as typeof console.error
    try {
      // 目录被换成同名文件：ensureDir 抛错 → 跳过本轮并计数。
      await rm(join(root, 'runtime'), { recursive: true, force: true })
      await writeFile(join(root, 'runtime'), '不是目录')
      const result = await service.runSweep('runtime', 'manual')
      expect(result.failed).toBe(1)
    } finally {
      console.error = original
    }
  })

  it('登录日志按时间倒序读回，地址归一、归属地由地址推导、用户代理单行化', async () => {
    const { service, state } = createHarness()
    await service.recordLogin({ ip: '127.0.0.1', userAgent: 'Browser/1', status: 'failure' })
    state.clock = new Date(NOW.getTime() + 1000)
    await service.recordLogin({ ip: '10.1.2.3', userAgent: 'Browser/2', status: 'success' })
    state.clock = new Date(NOW.getTime() + 2000)
    await service.recordLogin({ ip: 'not-an-ip', userAgent: 'bad\nagent', status: 'success' })

    const report = await service.loginLog()
    expect(report.entries.map((entry) => entry.ip)).toEqual(['未知', '10.1.2.3', '127.0.0.1'])
    expect(report.entries.map((entry) => entry.location)).toEqual(['未知', '内网', '本机'])
    expect(report.entries.map((entry) => entry.status)).toEqual(['success', 'success', 'failure'])
    expect(report.entries[0]?.userAgent).toBe('bad agent')
    expect(report.entries[2]?.userAgent).toBe('Browser/1')
    expect(report.truncated).toBe(false)
    expect(report.skippedLines).toBe(0)
  })
})
