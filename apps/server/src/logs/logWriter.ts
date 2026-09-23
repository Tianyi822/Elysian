import { join } from 'node:path'
import { LOG_SHARD_MAX_BYTES, type PlatformLogCategory } from '@elysian/contracts'
import {
  isRecordOversize,
  serializeOperationLogRecord,
  serializeRuntimeLogRecord,
  type OperationLogRecord,
  type RuntimeLogRecord,
} from './logRecords.ts'
import {
  compareLogShards,
  logCategoryDir,
  logShardName,
  parseLogShardName,
  utcDayKey,
  utcDayKeyOfShard,
  type ParsedLogShardName,
} from './logsPaths.ts'

/*
 * 平台日志的写入器：活动片管理、串行队列、判分片与封盘、崩溃恢复、计数器。
 *
 * 并发纪律（与清空、巡检的分工见 logsService）：
 * - 所有 append 走同一条串行队列，队列内只做「判分片 / 封盘 / 追加一行」；
 * - 每次 append 都 open(O_APPEND|O_CREAT|O_WRONLY|O_NOFOLLOW, 0600) + 写一行 + close，
 *   不持有长生命周期 fd：一行一次 write，进程被 SIGKILL 也不会写出交错行，
 *   也不会出现「文件被删后继续写进已 unlink inode」的黑洞；
 * - 写失败（磁盘满、权限、符号链接）只计数 + console.error，日志写失败绝不让业务请求失败；
 * - 首次写入才建目录、才上报巡检（装配期零副作用）；requestSweep 是 fire-and-forget，
 *   巡检多慢都不阻塞 append 的返回。
 */

export type LogWriterDeps = {
  /** 平台日志根（生产取 ELYSIAN_PATHS.platformLogsDir，测试注入临时根）。 */
  platformLogsDir: string
  now(): Date
  /** recursive + 0700，幂等。 */
  ensureDir(dir: string): Promise<void>
  /** 目录不存在（ENOENT）或其它错误都归一为 []。 */
  listNames(dir: string): Promise<readonly string[]>
  /** 不存在 → null（跟随符号链接，只用于已确认是普通文件的路径）。 */
  sizeOf(path: string): Promise<number | null>
  /**
   * 路径是否为普通文件（**lstat 判定，不跟随符号链接**）：不存在、符号链接、目录都返回 false。
   * 采用当日片与判定「活动片是否还在」都必须用它——`sizeOf` 会顺着符号链接看到链接目标，
   * 把别人放在分片名上的链接当成可写文件，随后每次 append 都因 O_NOFOLLOW 返回 ELOOP，
   * 该类别当天的日志会静默全丢。
   */
  isRegularFile(path: string): Promise<boolean>
  /** O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW, 0600，写一行（含结尾 \n）。 */
  appendLine(path: string, line: string): Promise<void>
  /**
   * 请求一次巡检（**fire-and-forget，不 await、不阻塞本次 append**）：写侧只上报「该扫了」，
   * 定时器、类别维护锁与执行都在 service 侧。writer 因此不持有定时器。
   */
  requestSweep(reason: 'first-write' | 'after-roll'): void
}

export type LogWriter = {
  append(record: RuntimeLogRecord | OperationLogRecord): Promise<void>
  currentPath(): string | null
  /** 封盘并忘掉当前片：此后 append 会重新采用当日片或新建（活动片已过期、清空两条路径用）。 */
  seal(): Promise<void>
  /**
   * 封盘并**在同一个队列槽里**执行任务（清空用）：这是「清空期间的 append 在队列里等、
   * 落地时写进新建的分片」的落点——任务与 append 互不插入，任务里的文件操作不会被
   * 穿插进来的 append 写进刚要删掉的文件。
   */
  sealAndRun<T>(task: () => Promise<T>): Promise<T>
  counters(): { droppedRecords: number; failedWrites: number }
}

type ActiveShard = {
  path: string
  /** 片名时刻的 UTC 日键：跨天判定的唯一口径（与文件名同源）。 */
  dayKey: string
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createLogWriter(deps: LogWriterDeps, category: PlatformLogCategory): LogWriter {
  const dir = logCategoryDir(category, deps.platformLogsDir)

  let tail: Promise<unknown> = Promise.resolve()
  let current: ActiveShard | null = null
  let initialized = false
  let droppedRecords = 0
  let failedWrites = 0

  /** 串行队列：前一个任务无论成败都不影响后一个任务开跑（队列不因单次失败断裂）。 */
  function enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const result = tail.then(task, task)
    tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  function serialize(record: RuntimeLogRecord | OperationLogRecord): string {
    return category === 'runtime'
      ? serializeRuntimeLogRecord(record as RuntimeLogRecord)
      : serializeOperationLogRecord(record as OperationLogRecord)
  }

  /**
   * adoptOrCreate：崩溃恢复的判据。
   * 列目录取该类别**未压缩分片里名字最大的普通文件**；若它的日键等于今天的 UTC 日键 → 采用它
   * 继续写（避免重启制造碎片，并保证片内时间跨度仍 ≤ 1 天）；否则新建今天的片，旧片由此变成
   * 「已封盘片」，可被巡检压缩与回收。
   *
   * 「普通文件」这一条不能省：分片名上被预先放了符号链接或目录时，采用它等于把活动片指向
   * 一个写不进去的路径（O_NOFOLLOW 一律 ELOOP），该类别当天的日志会静默全丢，且巡检的
   * listFiles 只认普通文件、永远不会清掉它。忽略不可写占位后，新建分支会因为名字被占而
   * 顺延到 `_2`，写入照常。
   */
  async function adoptOrCreate(now: Date): Promise<ActiveShard> {
    const names = await deps.listNames(dir)
    const candidates: { name: string; parsed: ParsedLogShardName }[] = []
    for (const name of names) {
      const parsed = parseLogShardName(name)
      if (parsed === null || parsed.category !== category || parsed.compressed) continue
      if (!(await deps.isRegularFile(join(dir, name)))) continue
      candidates.push({ name, parsed })
    }
    candidates.sort(compareLogShards)
    const latest = candidates[candidates.length - 1]
    const today = utcDayKey(now)
    if (latest !== undefined && utcDayKeyOfShard(latest.parsed) === today) {
      return { path: join(dir, latest.name), dayKey: today }
    }
    return openNewShard(now)
  }

  /**
   * 新建分片：名字取本次写入的时刻；同名冲突（同秒内第二次分片、或该名字被占）按 `_2`、`_3`
   * 顺延（分隔符用 `_` 而不是 `-`，理由见 logsPaths）。占位者是符号链接或目录时同样顺延：
   * 我们绝不写穿它，也绝不替外部删它。
   */
  async function openNewShard(now: Date): Promise<ActiveShard> {
    // 幂等 ensureDir：目录被外部删掉时在这里自愈，下一次 append 就能重新落盘。
    await deps.ensureDir(dir)
    const names = new Set(await deps.listNames(dir))
    let duplicateIndex = 1
    while (names.has(logShardName(category, now, false, duplicateIndex))) duplicateIndex += 1
    return { path: join(dir, logShardName(category, now, false, duplicateIndex)), dayKey: utcDayKey(now) }
  }

  /**
   * 判定本次写入落在哪个分片（每次 append 之前跑，不是写入之后）：
   * 活动片不存在（或路径被换成符号链接/目录）就采用/新建；跨 UTC 自然日**或**
   * 当前片 + 本行 > 8 MiB 则封盘换新片。两个条件同时命中只封一次、只产生一个新片。
   */
  async function selectShard(now: Date, lineBytes: number): Promise<ActiveShard> {
    let shard = current
    if (shard !== null && !(await deps.isRegularFile(shard.path))) {
      // 文件已不在（清空之外的外部删除），或路径被换成符号链接/目录：重置后走 adoptOrCreate，
      // 绝不用旧时刻的名字原地重建，也绝不写穿链接。
      shard = null
    }
    if (shard === null) shard = await adoptOrCreate(now)
    const size = await deps.sizeOf(shard.path)
    if (size !== null && (utcDayKey(now) !== shard.dayKey || size + lineBytes > LOG_SHARD_MAX_BYTES)) {
      shard = await openNewShard(now)
      // 封盘后异步上报一次巡检：fire-and-forget，不阻塞本次 append 的返回。
      deps.requestSweep('after-roll')
    }
    current = shard
    return shard
  }

  async function writeOne(record: RuntimeLogRecord | OperationLogRecord): Promise<void> {
    const line = serialize(record)
    if (isRecordOversize(line)) {
      // 硬闸：保证一条记录永远塞得进一个分片（不会出现无法推进的死循环）。
      droppedRecords += 1
      return
    }
    try {
      if (!initialized) {
        await deps.ensureDir(dir)
        initialized = true
        deps.requestSweep('first-write')
      }
      const shard = await selectShard(deps.now(), Buffer.byteLength(line, 'utf8'))
      await deps.appendLine(shard.path, `${line}\n`)
    } catch (error) {
      failedWrites += 1
      // 面板自己写不进日志时，stderr 是运维唯一的线索（排查路径见文档：stderr → 目录权限 → 面板计数）。
      console.error(`Elysian 平台日志写入失败（${category}：${dir}）：${describeError(error)}`)
    }
  }

  return {
    append(record) {
      return enqueue(() => writeOne(record))
    },

    currentPath() {
      return current?.path ?? null
    },

    seal() {
      return enqueue(() => {
        current = null
      })
    },

    sealAndRun(task) {
      return enqueue(async () => {
        current = null
        return task()
      })
    },

    counters() {
      return { droppedRecords, failedWrites }
    },
  }
}
