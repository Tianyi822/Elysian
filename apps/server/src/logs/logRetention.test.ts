import { createGunzip, createGzip } from 'node:zlib'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, lutimes, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LOG_RETENTION_POLICIES } from '@elysian/contracts'
import { collectStorageStats, runRetentionSweep, LOG_FILE_QUIET_MS, type LogFileStat, type LogRetentionDeps } from './logRetention'

/*
 * 保留策略的行为测试：真实临时目录 + 真实 zlib（宿主机安全），注入时钟——不依赖真实
 * home 目录、不依赖真实时钟。
 *
 * 压缩、临时残留、时间窗口删除、静默窗口、目录自愈用真实文件（要验 mtime 与产物字节）；
 * 总量预算的两条用例用「虚拟目录」（listFiles/removeFile 的假实现）——运行日志的预算是
 * 256 MiB，材料化这么大的文件既不快也不该由单元测试来写；预算步只消费 listing 的
 * sizeBytes 与名字顺序，虚拟 listing 是这一层最合适的观测面。
 *
 * 合并级（原设计的「超出 7 天合并成月块」）在本方案里**已砍掉**，因此没有对应用例：
 * 合并块的过期判定不落在本实现里，见文档 6.1/6.5。
 */

const NOW = new Date('2026-09-23T12:00:00.000Z')
const RUNTIME_POLICY = LOG_RETENTION_POLICIES.runtime
const RETENTION_MS = RUNTIME_POLICY.retentionDays * 24 * 60 * 60 * 1000

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elysian-logs-retention-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function dirOf(category: 'runtime' | 'operation' = 'runtime'): string {
  return join(root, category)
}

/** 造一个分片：内容 + mtime（距今 ageMs 毫秒）。 */
async function writeShard(
  name: string,
  content: string,
  ageMs: number,
  category: 'runtime' | 'operation' = 'runtime',
): Promise<string> {
  const path = join(dirOf(category), name)
  await mkdir(dirOf(category), { recursive: true })
  await writeFile(path, content)
  const mtime = new Date(NOW.getTime() - ageMs)
  await utimes(path, mtime, mtime)
  return path
}

/** 真实 gzip：写 .tmp → 搬 mtime → rename（与 logsHostDeps 的契约同形）。 */
async function gzipAtomic(src: string, dest: string): Promise<void> {
  const info = await lstat(src)
  const tmp = `${dest}.tmp`
  await pipeline(createReadStream(src), createGzip(), createWriteStream(tmp, { mode: 0o600 }))
  await utimes(tmp, info.atime, info.mtime)
  await rename(tmp, dest)
}

async function gunzipToString(path: string): Promise<string> {
  const chunks: Buffer[] = []
  await pipeline(
    createReadStream(path),
    createGunzip(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk)
        callback()
      },
    }),
  )
  return Buffer.concat(chunks).toString('utf8')
}

async function namesOf(category: 'runtime' | 'operation' = 'runtime'): Promise<string[]> {
  return (await readdir(dirOf(category)).catch(() => [])).sort()
}

type RealHarness = {
  deps: LogRetentionDeps
  state: { activePath: string | null; sealed: number; gzipCalls: string[] }
}

function createRealDeps(options: { gzipFails?: boolean; ensureDirFails?: boolean } = {}): RealHarness {
  const state = { activePath: null as string | null, sealed: 0, gzipCalls: [] as string[] }
  const deps: LogRetentionDeps = {
    platformLogsDir: root,
    now: () => NOW,
    ensureDir: async (dir) => {
      if (options.ensureDirFails) throw new Error('EACCES')
      await mkdir(dir, { recursive: true, mode: 0o700 })
    },
    listFiles: async (category) => {
      const listed: LogFileStat[] = []
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
    },
    gzipFile: async (src, dest) => {
      state.gzipCalls.push(src)
      if (options.gzipFails) throw new Error('Z_DATA_ERROR')
      await gzipAtomic(src, dest)
    },
    removeFile: async (path) => {
      await rm(path, { recursive: true, force: true })
    },
    writer: {
      currentPath: () => state.activePath,
      seal: async () => {
        state.sealed += 1
        state.activePath = null
      },
    },
  }
  return { deps, state }
}

/** 造一个指定字节数的条目（稀疏文件：逻辑大小到位、几乎不占磁盘），mtime 距今 ageMs。 */
async function writeSparse(path: string, sizeBytes: number, ageMs: number): Promise<string> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '')
  await truncate(path, sizeBytes)
  const mtime = new Date(NOW.getTime() - ageMs)
  await utimes(path, mtime, mtime)
  return path
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

/** 虚拟目录：只用于总量预算的算术与顺序断言（256 MiB 的预算不材料化成真实文件）。 */
function createVirtualDeps(
  entries: readonly { name: string; sizeBytes: number; ageMs: number; kind?: LogFileStat['kind'] }[],
) {
  const files = entries.map((entry) => ({
    path: join('/virtual/runtime', entry.name),
    name: entry.name,
    sizeBytes: entry.sizeBytes,
    mtimeMs: NOW.getTime() - entry.ageMs,
    kind: entry.kind ?? ('file' as const),
  }))
  const removed: string[] = []
  const state = { activePath: null as string | null, sealed: 0 }
  const deps: LogRetentionDeps = {
    platformLogsDir: '/virtual',
    now: () => NOW,
    ensureDir: async () => {},
    listFiles: async () => files.filter((file) => !removed.includes(file.path)),
    gzipFile: async () => {
      throw new Error('预算用例的分片应已是压缩形态，不该触发压缩')
    },
    removeFile: async (path) => {
      removed.push(path)
    },
    writer: {
      currentPath: () => state.activePath,
      seal: async () => {
        state.sealed += 1
        state.activePath = null
      },
    },
  }
  return { deps, removed, state }
}

describe('动作二：压缩', () => {
  it('已封盘的静默分片压成 .jsonl.gz，产物逐行等于源，源片消失', async () => {
    const content = '{"at":"2026-09-20T00:00:00.000Z","seq":1,"level":"info","source":"a","message":"一"}\n{"at":"2026-09-20T00:00:01.000Z","seq":2,"level":"info","source":"a","message":"二"}\n'
    await writeShard('runtime-20260920T000000Z.jsonl', content, 1 * 24 * 60 * 60 * 1000)
    const { deps, state } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.compressed).toBe(1)
    expect(result.failed).toBe(0)
    expect(await namesOf()).toEqual(['runtime-20260920T000000Z.jsonl.gz'])
    expect(await gunzipToString(join(dirOf(), 'runtime-20260920T000000Z.jsonl.gz'))).toBe(content)
    expect(state.gzipCalls).toEqual([join(dirOf(), 'runtime-20260920T000000Z.jsonl')])
    // 压缩换形态不释放空间：同基名的 .gz 取代了源片，源片的删除不计入 freedBytes。
    expect(result.freedBytes).toBe(0)
  })

  it('压缩后 .gz 的 mtime 等于源片 mtime（保留窗口不重新起算）', async () => {
    // 操作日志的窗口是 30 天：10 天前的源片既没过期、也已静默，走的是纯压缩路径。
    const ageMs = 10 * 24 * 60 * 60 * 1000
    const source = await writeShard('operation-20260913T000000Z.jsonl', 'x\n', ageMs, 'operation')
    const sourceMtime = (await stat(source)).mtimeMs
    const { deps } = createRealDeps()

    await runRetentionSweep(deps, 'operation')

    const product = await stat(join(dirOf('operation'), 'operation-20260913T000000Z.jsonl.gz'))
    expect(Math.round(product.mtimeMs)).toBe(Math.round(sourceMtime))
    expect(await namesOf('operation')).toEqual(['operation-20260913T000000Z.jsonl.gz'])
  })

  it('活动片永不压缩，其它分片照压', async () => {
    const active = await writeShard(
      'runtime-20260922T000000Z.jsonl',
      '{"at":"2026-09-22T00:00:00.000Z","seq":1,"level":"info","source":"a","message":"活动"}\n',
      2 * 24 * 60 * 60 * 1000,
    )
    await writeShard(
      'runtime-20260921T000000Z.jsonl',
      '{"at":"2026-09-21T00:00:00.000Z","seq":1,"level":"info","source":"a","message":"封盘"}\n',
      2 * 24 * 60 * 60 * 1000,
    )
    const { deps, state } = createRealDeps()
    state.activePath = active

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.compressed).toBe(1)
    expect(state.gzipCalls).toEqual([join(dirOf(), 'runtime-20260921T000000Z.jsonl')])
    expect(await namesOf()).toEqual([
      'runtime-20260921T000000Z.jsonl.gz',
      'runtime-20260922T000000Z.jsonl',
    ])
  })

  it('已过期的片跳过压缩直接删（不产生 .gz）', async () => {
    const expiredAge = (RUNTIME_POLICY.retentionDays + 1) * 24 * 60 * 60 * 1000
    await writeShard('runtime-20260910T000000Z.jsonl', 'x\n', expiredAge)
    const { deps, state } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(state.gzipCalls).toEqual([])
    expect(result.compressed).toBe(0)
    expect(result.deletedByAge).toBe(1)
    expect(await namesOf()).toEqual([])
  })

  it('压缩失败只计数：源片保留，下一轮或多轮后仍可重做', async () => {
    const source = await writeShard('runtime-20260920T000000Z.jsonl', 'x\n', 24 * 60 * 60 * 1000)
    const { deps } = createRealDeps({ gzipFails: true })

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.failed).toBe(1)
    expect(result.compressed).toBe(0)
    expect(await namesOf()).toEqual(['runtime-20260920T000000Z.jsonl'])
    expect((await stat(source)).size).toBe(2)
  })
})

describe('动作零：临时残留', () => {
  it('目录里的 .tmp 一律清掉并计数，不计入统计口径', async () => {
    await writeShard('runtime-20260920T000000Z.jsonl.gz.tmp', '半截压缩产物', 24 * 60 * 60 * 1000)
    await writeShard('runtime-20260921T000000Z.jsonl', 'x\n', 24 * 60 * 60 * 1000)
    const { deps } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.removedTmp).toBe(1)
    expect(await namesOf()).toEqual(['runtime-20260921T000000Z.jsonl.gz'])
  })
})

describe('动作三：按时间窗口删除', () => {
  it('覆盖上界（mtime）早于窗口就删；压缩包同样参与判定', async () => {
    const old = (RUNTIME_POLICY.retentionDays + 1) * 24 * 60 * 60 * 1000
    await writeShard('runtime-20260910T000000Z.jsonl', 'x\n', old)
    await writeShard('runtime-20260911T000000Z.jsonl.gz', 'x\n', old)
    await writeShard('runtime-20260912T000000Z.jsonl.gz', 'x\n', 24 * 60 * 60 * 1000)
    const { deps } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.deletedByAge).toBe(2)
    expect(result.freedBytes).toBe(4)
    expect(await namesOf()).toEqual(['runtime-20260912T000000Z.jsonl.gz'])
  })

  it('恰好落在窗口上不删（判定是严格大于）；多一天即删', async () => {
    await writeShard('runtime-20260916T000000Z.jsonl.gz', 'x\n', RETENTION_MS)
    await writeShard('runtime-20260915T000000Z.jsonl.gz', 'x\n', RETENTION_MS + 1)
    const { deps } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.deletedByAge).toBe(1)
    expect(await namesOf()).toEqual(['runtime-20260916T000000Z.jsonl.gz'])
  })

  it('静默窗口内的文件不删（跨进程兜底）', async () => {
    const old = (RUNTIME_POLICY.retentionDays + 1) * 24 * 60 * 60 * 1000
    await writeShard('runtime-20260910T000000Z.jsonl.gz', 'x\n', LOG_FILE_QUIET_MS - 1)
    // 对照：同样过期但已静默足够久的文件会被删。
    await writeShard('runtime-20260909T000000Z.jsonl.gz', 'x\n', old)
    const { deps } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.deletedByAge).toBe(1)
    expect(await namesOf()).toEqual(['runtime-20260910T000000Z.jsonl.gz'])
  })

  it('过期的活动片先封盘、本轮不删；下一轮（已封盘）才删', async () => {
    const old = (RUNTIME_POLICY.retentionDays + 1) * 24 * 60 * 60 * 1000
    const active = await writeShard('runtime-20260905T000000Z.jsonl', 'x\n', old)
    const { deps, state } = createRealDeps()
    state.activePath = active

    const first = await runRetentionSweep(deps, 'runtime')
    expect(state.sealed).toBe(1)
    expect(first.deletedByAge).toBe(0)
    expect(await namesOf()).toEqual(['runtime-20260905T000000Z.jsonl'])

    const second = await runRetentionSweep(deps, 'runtime')
    expect(second.deletedByAge).toBe(1)
    expect(await namesOf()).toEqual([])
  })
})

describe('动作四：按总量预算删除（虚拟 listing）', () => {
  const MIB = 1024 * 1024
  const withinWindow = 24 * 60 * 60 * 1000

  function entries(sizes: readonly number[]) {
    return sizes.map((sizeBytes, index) => ({
      // 名字升序 = 时间序：从旧到新。
      name: `runtime-2026092${index + 1}T000000Z.jsonl.gz`,
      sizeBytes,
      ageMs: withinWindow,
    }))
  }

  it('超预算时从最旧的已封盘文件删起，直到 ≤ 预算', async () => {
    const { deps, removed } = createVirtualDeps(entries([100 * MIB, 100 * MIB, 100 * MIB]))
    expect(RUNTIME_POLICY.maxTotalBytes).toBe(256 * MIB)

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.deletedBySize).toBe(1)
    expect(result.trimmedBySize).toBe(true)
    expect(result.totalBytes).toBe(200 * MIB)
    expect(removed).toEqual([join('/virtual/runtime', 'runtime-20260921T000000Z.jsonl.gz')])
  })

  it('恰好落在预算上不删（判定是严格大于）', async () => {
    const { deps, removed } = createVirtualDeps(entries([128 * MIB, 128 * MIB]))

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.deletedBySize).toBe(0)
    expect(result.trimmedBySize).toBe(false)
    expect(removed).toEqual([])
    expect(result.totalBytes).toBe(256 * MIB)
  })

  it('预算删除同样覆盖外来文件：按覆盖下界排序（外来文件取下界 = mtime）', async () => {
    const { deps, removed } = createVirtualDeps([
      // 覆盖下界：notes.txt 取 mtime（NOW − 3 天）→ 最旧；两个片取片名时刻。
      { name: 'notes.txt', sizeBytes: 100 * MIB, ageMs: 3 * 24 * 60 * 60 * 1000 },
      { name: 'runtime-20260923T000000Z.jsonl.gz', sizeBytes: 100 * MIB, ageMs: withinWindow },
      { name: 'runtime-20260924T000000Z.jsonl.gz', sizeBytes: 100 * MIB, ageMs: withinWindow },
    ])

    const result = await runRetentionSweep(deps, 'runtime')

    expect(removed).toEqual([join('/virtual/runtime', 'notes.txt')])
    expect(result.deletedBySize).toBe(1)
    expect(result.trimmedBySize).toBe(true)
    expect(result.totalBytes).toBe(200 * MIB)
  })

  it('预算删除先清外来条目：一个外来大文件不会把窗口内的日志片挤掉', async () => {
    // 复核者实测过的场景：64 MiB 预算下「60 MiB 外来文件（mtime 5 分钟前，静默但在窗口内）
    // + 3 × 8 MiB 窗口内日志片」共 84 MiB。若按覆盖下界混排，分片会被全删、外来文件留下。
    const { deps, removed } = createVirtualDeps([
      { name: 'notes.bin', sizeBytes: 60 * MIB, ageMs: 5 * 60 * 1000 },
      { name: 'operation-20260921T000000Z.jsonl.gz', sizeBytes: 8 * MIB, ageMs: withinWindow },
      { name: 'operation-20260922T000000Z.jsonl.gz', sizeBytes: 8 * MIB, ageMs: withinWindow },
      { name: 'operation-20260923T000000Z.jsonl.gz', sizeBytes: 8 * MIB, ageMs: withinWindow },
    ])

    const result = await runRetentionSweep(deps, 'operation')

    expect(removed).toEqual([join('/virtual/runtime', 'notes.bin')])
    expect(result.deletedBySize).toBe(1)
    expect(result.trimmedBySize).toBe(true)
    expect(result.totalBytes).toBe(24 * MIB)
  })

  it('预算删除先清外来条目（真文件复核）：60 MiB 外来文件 + 3 × 8 MiB 窗口内日志片', async () => {
    // 复核者实测的输入：operation 目录里一个 60 MiB、mtime 5 分钟前（静默但在 30 天窗口内）的
    // 无关文件，加三个各 8 MiB 的窗口内日志片，共 84 MiB，超过 64 MiB 预算。
    await writeSparse(join(dirOf('operation'), 'notes.bin'), 60 * MIB, 5 * 60 * 1000)
    for (const day of ['21', '22', '23']) {
      await writeSparse(
        join(dirOf('operation'), `operation-202609${day}T000000Z.jsonl.gz`),
        8 * MIB,
        24 * 60 * 60 * 1000,
      )
    }
    expect(LOG_RETENTION_POLICIES.operation.maxTotalBytes).toBe(64 * MIB)
    const { deps } = createRealDeps()

    const result = await runRetentionSweep(deps, 'operation')

    // 被删的是那个外来文件，三个日志片一片不少。
    expect(result.deletedBySize).toBe(1)
    expect(result.trimmedBySize).toBe(true)
    expect(await namesOf('operation')).toEqual([
      'operation-20260921T000000Z.jsonl.gz',
      'operation-20260922T000000Z.jsonl.gz',
      'operation-20260923T000000Z.jsonl.gz',
    ])
    expect(result.totalBytes).toBe(24 * MIB)
  })

  it('活动片不参与预算删除：跳过它继续删下一个更旧的', async () => {
    const { deps, removed, state } = createVirtualDeps(entries([100 * MIB, 100 * MIB, 100 * MIB]))
    state.activePath = join('/virtual/runtime', 'runtime-20260921T000000Z.jsonl.gz') // 最旧的那个恰是活动片

    const result = await runRetentionSweep(deps, 'runtime')

    expect(removed).toEqual([join('/virtual/runtime', 'runtime-20260922T000000Z.jsonl.gz')])
    expect(result.deletedBySize).toBe(1)
  })

  it('删到只剩活动片仍超预算：停止且不置 trimmedBySize', async () => {
    const { deps, removed, state } = createVirtualDeps(entries([500 * MIB]))
    state.activePath = join('/virtual/runtime', 'runtime-20260921T000000Z.jsonl.gz')

    const result = await runRetentionSweep(deps, 'runtime')

    expect(removed).toEqual([])
    expect(result.deletedBySize).toBe(0)
    expect(result.trimmedBySize).toBe(false)
    expect(result.totalBytes).toBe(500 * MIB)
  })

  it('静默窗口内的文件不参与预算删除', async () => {
    const { deps, removed } = createVirtualDeps([
      { name: 'runtime-20260921T000000Z.jsonl.gz', sizeBytes: 300 * MIB, ageMs: LOG_FILE_QUIET_MS - 1 },
    ])

    const result = await runRetentionSweep(deps, 'runtime')

    expect(removed).toEqual([])
    expect(result.deletedBySize).toBe(0)
  })
})

describe('巡检的幂等与边界', () => {
  it('空目录：全 0，不抛错', async () => {
    const { deps } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result).toMatchObject({
      removedTmp: 0,
      compressed: 0,
      deletedByAge: 0,
      deletedBySize: 0,
      freedBytes: 0,
      totalBytes: 0,
      trimmedBySize: false,
      failed: 0,
    })
    expect(result.at).toBe(NOW.toISOString())
    // 目录被建出来了（幂等 ensureDir）：空目录也自愈。
    expect((await stat(dirOf())).isDirectory()).toBe(true)
  })

  it('连跑两次结果稳定（第二次无动作）', async () => {
    await writeShard('runtime-20260920T000000Z.jsonl', 'x\n', 24 * 60 * 60 * 1000)
    const { deps } = createRealDeps()

    const first = await runRetentionSweep(deps, 'runtime')
    const second = await runRetentionSweep(deps, 'runtime')

    expect(first.compressed).toBe(1)
    expect(second).toMatchObject({ compressed: 0, deletedByAge: 0, deletedBySize: 0, removedTmp: 0 })
    expect(await namesOf()).toEqual(['runtime-20260920T000000Z.jsonl.gz'])
  })

  it('目录不可写（ensureDir 失败）：跳过本轮、计数、不抛', async () => {
    await writeShard('runtime-20260920T000000Z.jsonl', 'x\n', 24 * 60 * 60 * 1000)
    const { deps } = createRealDeps({ ensureDirFails: true })
    const errors: string[] = []
    const original = console.error
    console.error = ((message: string) => errors.push(String(message))) as typeof console.error
    try {
      const result = await runRetentionSweep(deps, 'runtime')
      expect(result.failed).toBe(1)
      expect(result.compressed).toBe(0)
    } finally {
      console.error = original
    }
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('巡检跳过本轮')
    expect(await namesOf()).toEqual(['runtime-20260920T000000Z.jsonl'])
  })

  it('只处理本类别：另一个类别的目录不动', async () => {
    await mkdir(dirOf('operation'), { recursive: true })
    await writeFile(join(dirOf('operation'), 'operation-20260101T000000Z.jsonl'), 'x\n')
    const { deps } = createRealDeps()

    await runRetentionSweep(deps, 'runtime')

    expect(await namesOf('operation')).toEqual(['operation-20260101T000000Z.jsonl'])
  })

  it('非本模块形态的普通文件同样受窗口约束：超龄即删（不在窗口外永久累积）', async () => {
    const expired = (RUNTIME_POLICY.retentionDays + 1) * 24 * 60 * 60 * 1000
    await writeShard('notes.txt', '手工放进来的文件', expired)
    await writeShard('operation-202608Z.jsonl.gz', '未来版本可能写出的合并块', expired)
    await writeShard('sshd.log', 'sshd 的日志（放错目录）', expired)
    const { deps } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.deletedByAge).toBe(3)
    expect(result.failed).toBe(0)
    expect(await namesOf()).toEqual([])
  })

  it('非本模块形态的普通文件计入统计口径（文件数、字节、最旧覆盖下界取 mtime）', async () => {
    await writeShard('notes.txt', '12345', 24 * 60 * 60 * 1000)
    const { deps } = createRealDeps()

    const stats = await collectStorageStats(
      deps,
      { droppedRecords: 0, failedWrites: 0 },
      { lastSweepAt: null, trimmedBySize: false },
    )

    expect(stats).toMatchObject({ runtimeBytes: 5, totalBytes: 5, fileCount: 1 })
    expect(stats.oldestAt).toBe(new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString())
  })

  it('符号链接与子目录同样进口径：计入字节、受窗口约束，删的是条目本身而不是链接目标', async () => {
    await mkdir(dirOf(), { recursive: true })
    const outsideDir = join(root, 'outside')
    await mkdir(outsideDir, { recursive: true })
    const outsideFile = join(outsideDir, 'data.bin')
    await writeFile(outsideFile, 'x'.repeat(4096))
    // 目录里的符号链接：指向目录外的文件；目录：装 2048 字节内容。
    await symlink(outsideFile, join(dirOf(), 'notes-link.bin'))
    const innerDir = join(dirOf(), 'attachments')
    await mkdir(innerDir, { recursive: true })
    await writeFile(join(innerDir, 'a.bin'), 'y'.repeat(2048))
    const expired = (RUNTIME_POLICY.retentionDays + 1) * 24 * 60 * 60 * 1000
    const old = new Date(NOW.getTime() - expired)
    // 链接的 mtime 要用 lutimes 设（utimes 会跟随链接、改到目标文件上），
    // 这也正是保留口径看的那一份：lstat 的 mtime，不是目标的。
    await lutimes(join(dirOf(), 'notes-link.bin'), old, old)
    await utimes(join(dirOf(), 'attachments'), old, old)
    const { deps } = createRealDeps()

    const stats = await collectStorageStats(
      deps,
      { droppedRecords: 0, failedWrites: 0 },
      { lastSweepAt: null, trimmedBySize: false },
    )
    // 链接计自身 lstat 大小（不是目标的 4096），目录计递归和 2048。
    expect(stats.fileCount).toBe(2)
    expect(stats.runtimeBytes).toBe(2048 + (await lstat(join(dirOf(), 'notes-link.bin'))).size)

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result.deletedByAge).toBe(2)
    expect(await namesOf()).toEqual([])
    // 链接目标与目录外的文件都不受影响（删的是条目本身，从不跟随链接）。
    expect(await readFile(outsideFile, 'utf8')).toHaveLength(4096)
    expect((await readdir(outsideDir)).sort()).toEqual(['data.bin'])
  })

  it('新来的符号链接与子目录受静默窗口保护（不会在刚出现时就被删）', async () => {
    await mkdir(dirOf(), { recursive: true })
    const outsideFile = join(root, 'fresh-target.bin')
    await writeFile(outsideFile, 'x')
    await symlink(outsideFile, join(dirOf(), 'fresh-link.bin'))
    await mkdir(join(dirOf(), 'fresh-dir'), { recursive: true })
    // 两者 mtime 都是「刚刚」：远超窗口但不足 60 秒静默，本轮不动。
    const { deps } = createRealDeps()

    const result = await runRetentionSweep(deps, 'runtime')

    expect(result).toMatchObject({ deletedByAge: 0, deletedBySize: 0, failed: 0 })
    expect(await namesOf()).toEqual(['fresh-dir', 'fresh-link.bin'])
  })
})

describe('存储统计聚合', () => {
  it('两类的字节与文件数、最旧分片时刻、计数器与巡检状态', async () => {
    await writeShard('runtime-20260920T000000Z.jsonl', '12345\n', 24 * 60 * 60 * 1000)
    await mkdir(dirOf('operation'), { recursive: true })
    await writeFile(join(dirOf('operation'), 'operation-20260910T000000Z.jsonl.gz'), '1234')
    const { deps } = createRealDeps()

    const stats = await collectStorageStats(
      deps,
      { droppedRecords: 3, failedWrites: 2 },
      { lastSweepAt: '2026-09-23T11:00:00.000Z', trimmedBySize: true },
    )

    expect(stats).toEqual({
      totalBytes: 10,
      runtimeBytes: 6,
      operationBytes: 4,
      fileCount: 2,
      oldestAt: '2026-09-10T00:00:00Z',
      lastSweepAt: '2026-09-23T11:00:00.000Z',
      trimmedBySize: true,
      droppedRecords: 3,
      failedWrites: 2,
    })
  })

  it('空目录：零字节、零文件、oldestAt 为 null', async () => {
    const { deps } = createRealDeps()

    const stats = await collectStorageStats(
      deps,
      { droppedRecords: 0, failedWrites: 0 },
      { lastSweepAt: null, trimmedBySize: false },
    )

    expect(stats).toMatchObject({ totalBytes: 0, runtimeBytes: 0, operationBytes: 0, fileCount: 0, oldestAt: null })
  })

  it('统计口径排除 .tmp，但保留分片与外来普通文件', async () => {
    await writeShard('runtime-20260920T000000Z.jsonl.gz.tmp', '残留', 24 * 60 * 60 * 1000)
    await writeShard('runtime-20260919T000000Z.jsonl', 'x\n', 24 * 60 * 60 * 1000)
    await writeShard('notes.txt', 'y', 24 * 60 * 60 * 1000)
    const { deps } = createRealDeps()

    const stats = await collectStorageStats(
      deps,
      { droppedRecords: 0, failedWrites: 0 },
      { lastSweepAt: null, trimmedBySize: false },
    )

    expect(stats).toMatchObject({ fileCount: 2, oldestAt: '2026-09-19T00:00:00Z' })
    expect(stats.runtimeBytes).toBe(3) // 'x\n' + 'y'
  })
})
