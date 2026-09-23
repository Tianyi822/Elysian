import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { createReadStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLogsHostDeps } from './logsHostDeps'

/*
 * 真实接线的冒烟测试：装配 → 一次 append → 一次读取 → 一次压缩 → 一次清空，
 * 跑在 mkdtemp 目录上（不碰开发者真实的 ~/.Elysian，不执行任何系统命令）。
 * 这里覆盖的是读行器（readline + createGunzip）、appender（O_NOFOLLOW）、
 * gzipFile（流式压缩 + mtime 搬运）与 listFiles（lstat 过滤）这四个真实实现。
 */

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'elysian-logs-host-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function runtimeDir(): string {
  return join(root, 'runtime')
}

async function namesOf(category = 'runtime'): Promise<string[]> {
  return (await readdir(join(root, category)).catch(() => [])).sort()
}

/** 有界等待（只用于「fire-and-forget 的上报最终会发生」这类活性断言，不做时间值断言）。 */
async function until(condition: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('等待超时')
}

async function gunzipLines(path: string): Promise<string[]> {
  const reader = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity })
  const lines: string[] = []
  for await (const line of reader) lines.push(line)
  return lines
}

describe('装配 → 写入 → 读取', () => {
  it('装配期零副作用：不建目录、不起定时器（不写就没有 platform 目录）', async () => {
    createLogsHostDeps({ platformLogsDir: join(root, 'platform') })
    await expect(lstat(join(root, 'platform'))).rejects.toThrow()
  })

  it('一次 append 之后目录与文件就位，读取回到同一条记录', async () => {
    const { service } = createLogsHostDeps({ platformLogsDir: root })

    await service.log('info', 'server.lifecycle', 'Elysian 服务已启动：http://127.0.0.1:48101')

    expect(await namesOf()).toHaveLength(1)
    expect((await lstat(runtimeDir())).mode & 0o777).toBe(0o700)
    const report = await service.runtimeLog()
    const written = report.entries.filter((entry) => entry.source === 'server.lifecycle')
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({
      level: 'info',
      source: 'server.lifecycle',
      message: 'Elysian 服务已启动：http://127.0.0.1:48101',
    })
    expect(report.storage.runtimeBytes).toBeGreaterThan(0)
  })

  it('first-write 的巡检上报是 fire-and-forget：写回请求不等它，但最终会留下巡检留痕', async () => {
    const { service } = createLogsHostDeps({ platformLogsDir: root })

    await service.log('info', 'logs.test', '触发第一次写入')

    // 上报是 fire-and-forget，但确实会跑到：等到巡检那行留痕出现。
    await until(async () =>
      (await service.runtimeLog()).entries.some((entry) => entry.source === 'logs.retention'),
    )
    const report = await service.runtimeLog()
    expect(report.storage.lastSweepAt).not.toBeNull()
  })

  it('操作日志走同一套接线，读取是倒序', async () => {
    const { service } = createLogsHostDeps({ platformLogsDir: root })

    await service.recordOperation({ category: 'security', action: '修改 SSH 监听端口', result: 'success', httpStatus: 200 })
    await service.recordOperation({ category: 'logs', action: '清空运行日志', result: 'success', httpStatus: 200 })

    const report = await service.operationLog()
    expect(report.entries.map((entry) => entry.action)).toEqual(['清空运行日志', '修改 SSH 监听端口'])
    expect(await namesOf('operation')).toHaveLength(1)
  })
})

describe('真实压缩与读取', () => {
  it('巡检把已封盘分片压成 .gz，内容经 createGunzip 读回一致，mtime 未变', async () => {
    let clock = new Date('2026-09-20T10:00:00.000Z')
    const { service } = createLogsHostDeps({ platformLogsDir: root, now: () => clock })

    await service.log('info', 'logs.test', '待压缩的一条')
    expect(await namesOf()).toEqual(['runtime-20260920T100000Z.jsonl'])
    // first-write 的自动巡检会把它的留痕行追加进这个活动片（也就刷新它的 mtime）：
    // 先等它落定，再拨 mtime，拨过的值才不会被后到的写入覆盖。
    await until(async () =>
      (await service.runtimeLog()).entries.some((entry) => entry.source === 'logs.retention'),
    )

    // 把 mtime 拨到窗口内、静默窗口外。此刻它还是活动片——活动片永不压缩，
    // 因此这一步不会被任何并发的自动巡检抢先压掉。
    const shard = join(runtimeDir(), 'runtime-20260920T100000Z.jsonl')
    const shardMtime = new Date(clock.getTime() - 2 * 24 * 60 * 60 * 1000)
    await utimes(shard, shardMtime, shardMtime)
    expect(Math.round((await lstat(shard)).mtimeMs)).toBe(Math.round(shardMtime.getTime()))

    // 跨 UTC 自然日的下一次写入把旧片封盘（新片接管写入），after-roll 会自动巡检。
    clock = new Date('2026-09-21T10:00:00.000Z')
    await service.log('info', 'logs.test', '新一天的一条')
    expect(await namesOf()).toContain('runtime-20260920T100000Z.jsonl')

    // 自动巡检是 fire-and-forget：等产物出现（再补一次手动巡检让等待有界）。
    await service.runSweep('runtime', 'manual')
    await until(async () => (await namesOf()).includes('runtime-20260920T100000Z.jsonl.gz'))

    const product = join(runtimeDir(), 'runtime-20260920T100000Z.jsonl.gz')
    // 产物 mtime = 源片 mtime（保留窗口不重新起算），且内容逐行可读回（首行是业务日志，末行是巡检留痕）。
    expect(Math.round((await lstat(product)).mtimeMs)).toBe(Math.round(shardMtime.getTime()))
    const lines = await gunzipLines(product)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('待压缩的一条')
    // 压缩后源片消失，读侧仍能读到这条记录。
    expect(await namesOf()).not.toContain('runtime-20260920T100000Z.jsonl')
    const report = await service.runtimeLog()
    const written = report.entries.filter((entry) => entry.source === 'logs.test')
    expect(written.map((entry) => entry.message)).toEqual(['新一天的一条', '待压缩的一条'])
    expect(report.skippedFiles).toBe(0)
  })

  it('读侧跳过坏文件：被改坏的 .gz 计入 skippedFiles，其余分片照读', async () => {
    const { service } = createLogsHostDeps({ platformLogsDir: root })
    await service.log('info', 'logs.test', '好文件里的那条')
    await writeFile(join(runtimeDir(), 'runtime-20260920T000000Z.jsonl.gz'), '这不是 gzip')

    const report = await service.runtimeLog()

    expect(report.skippedFiles).toBe(1)
    expect(report.entries.filter((entry) => entry.source === 'logs.test').map((entry) => entry.message)).toEqual([
      '好文件里的那条',
    ])
  })

  it('分片名被符号链接占位：写入顺延到 `_2` 片，不丢行、failedWrites 保持 0、链接目标不被写穿', async () => {
    const clock = new Date('2026-09-23T03:15:00.000Z')
    const { service } = createLogsHostDeps({ platformLogsDir: root, now: () => clock })
    await mkdir(runtimeDir(), { recursive: true })
    const target = join(root, 'victim.jsonl')
    await writeFile(target, '')
    const squatted = join(runtimeDir(), 'runtime-20260923T031500Z.jsonl')
    await symlink(target, squatted)

    await service.log('info', 'logs.test', '第一条')
    await service.log('info', 'logs.test', '第二条')

    // 修复前：采用分支把符号链接当成当日活动片，两次 append 都 ELOOP，failedWrites = 2 且该类别当天全丢。
    const report = await service.runtimeLog()
    expect(report.entries.filter((entry) => entry.source === 'logs.test').map((entry) => entry.message)).toEqual([
      '第二条',
      '第一条',
    ])
    expect(report.storage.failedWrites).toBe(0)
    expect(await namesOf()).toContain('runtime-20260923T031500Z_2.jsonl')
    expect(await readFile(target, 'utf8')).toBe('')
    expect((await lstat(squatted)).isSymbolicLink()).toBe(true)
  })

  it('子目录与符号链接进口径：子目录按递归和计字节，清空删条目而不动链接目标与目录外文件', async () => {
    const { service } = createLogsHostDeps({ platformLogsDir: root })
    await service.log('info', 'logs.test', '一条')
    // first-write 的自动巡检随后会把它的留痕行写进这个活动片：等它落定再量字节，
    // 否则测到的分片大小会在断言之前又被改一次。
    await until(async () =>
      (await service.runtimeLog()).entries.some((entry) => entry.source === 'logs.retention'),
    )
    const shardName = (await namesOf()).find((name) => name.endsWith('.jsonl'))!
    const shardBytes = (await lstat(join(runtimeDir(), shardName))).size

    const outsideDir = join(root, 'outside')
    await mkdir(outsideDir, { recursive: true })
    const outsideFile = join(outsideDir, 'data.bin')
    await writeFile(outsideFile, 'z'.repeat(500))
    await symlink(outsideFile, join(runtimeDir(), 'link.bin'))
    await symlink(outsideDir, join(runtimeDir(), 'dir-link'))
    const innerDir = join(runtimeDir(), 'attachments')
    await mkdir(innerDir, { recursive: true })
    await writeFile(join(innerDir, 'a.bin'), 'y'.repeat(300))

    const storage = (await service.runtimeLog()).storage
    const linkBytes = (await lstat(join(runtimeDir(), 'link.bin'))).size
    const dirLinkBytes = (await lstat(join(runtimeDir(), 'dir-link'))).size
    // 四个条目：分片、两个链接、子目录；链接计自身大小、子目录计递归和（300），都不是目标的大小。
    expect(storage.fileCount).toBe(4)
    expect(storage.runtimeBytes).toBe(shardBytes + linkBytes + dirLinkBytes + 300)

    const report = await service.clear('runtime')

    expect(report.fileCount).toBe(4)
    // 目录里只剩清空留下的一条留痕；链接目标与目录外的文件都不受影响。
    expect((await namesOf()).length).toBe(1)
    expect(await readFile(outsideFile, 'utf8')).toHaveLength(500)
    expect((await readdir(outsideDir)).sort()).toEqual(['data.bin'])
  })

  it('读侧只读普通文件：分片名的符号链接与子目录一律跳过', async () => {
    const { service } = createLogsHostDeps({ platformLogsDir: root })
    await service.log('info', 'logs.test', '真身')
    const outside = join(root, 'outside.jsonl')
    await writeFile(outside, '{"at":"2026-09-23T00:00:00.000Z","seq":1,"level":"info","source":"x","message":"外部"}\n')
    await symlink(outside, join(runtimeDir(), 'runtime-20260919T000000Z.jsonl'))
    await mkdir(join(runtimeDir(), 'runtime-20260918T000000Z.jsonl'))

    const report = await service.runtimeLog()

    expect(report.entries.filter((entry) => entry.source === 'logs.test').map((entry) => entry.message)).toEqual([
      '真身',
    ])
    expect(report.skippedFiles).toBe(0)
    // 符号链接与子目录都还在原位（读取侧不动它们）。
    expect(await namesOf()).toHaveLength(3)
  })

  it('清空删掉全部日志文件并留下一条留痕（真实接线端到端）', async () => {
    const { service } = createLogsHostDeps({ platformLogsDir: root })
    await service.log('info', 'logs.test', '历史一')
    await service.log('info', 'logs.test', '历史二')

    const report = await service.clear('runtime')

    expect(report.fileCount).toBe(1)
    expect(await namesOf()).toHaveLength(1)
    const after = await service.runtimeLog()
    expect(after.entries).toHaveLength(1)
    expect(after.entries[0]?.source).toBe('logs.clear')
  })
})
