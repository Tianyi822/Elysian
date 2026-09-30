import {
  LOG_RETENTION_POLICIES,
  type LogRetentionPolicy,
  type LogStorageStats,
} from '@elysian/contracts'
import { logCategoryDir, parseLogShardName, type LogShardCategory, type ParsedLogShardName } from './logsPaths.ts'
import type { LogWriter } from './logWriter.ts'

/*
 * 保留策略：巡检四步（清临时残留 → 压缩 → 删时间 → 删预算）与存储统计聚合。
 *
 * 四级动作里的前两级（封盘分片、封盘即压缩）在写入器与巡检里，后两级（按窗口删、
 * 按总量删）在本文件。形态由**封盘**驱动、留存由**窗口 + 总量上限**驱动：
 * 压缩不看时间档（封盘后首个巡检就压），删除看 mtime。
 *
 * 过期判定的覆盖上界只用文件系统已有的元数据，不读文件内容：
 * - `.jsonl` 片：mtime（= 该片最后一次被写的时刻）→ 片内任何一条日志的实际保留时长 ≥ 窗口；
 * - `.jsonl.gz` 片：同样是 mtime，**前提是压缩已把源片的 mtime 搬到产物上**（gzipFile 的契约）。
 *
 * 保留口径（与统计口径同一份，见 RetentionEntry）：类别目录里**一切普通文件**都受窗口与预算
 * 约束，`.tmp` 由第一步无条件清掉；符号链接与子目录不是普通文件、一律不碰。「不允许日志
 * 无限增长」这条硬约束因此没有出口——不认得的名字不会落在窗口与预算之外。
 *
 * 跨进程兜底：压缩与两种删除都要求 mtime 早于 now − LOG_FILE_QUIET_MS，刚被写过的文件
 * 不会被另一个进程动。同进程内 clear 与巡检由 logsService 的类别维护锁互斥。
 */

/** 静默窗口：mtime 距今不足它的文件不动（刚写过的片可能仍在被另一个进程写）。 */
export const LOG_FILE_QUIET_MS = 60_000

/**
 * 登录日志的保留：30 天、16 MiB。行很短，窗口与操作日志对齐；
 * 不进运行/操作的「日志大小」合计，也不能从界面清空。
 */
export const LOGIN_LOG_RETENTION_POLICY: LogRetentionPolicy = {
  retentionDays: 30,
  maxTotalBytes: 16 * 1024 * 1024,
}

export function retentionPolicyOf(category: LogShardCategory): LogRetentionPolicy {
  return category === 'login' ? LOGIN_LOG_RETENTION_POLICY : LOG_RETENTION_POLICIES[category]
}

const DAY_MS = 24 * 60 * 60 * 1000

export type LogFileStat = {
  path: string
  name: string
  /**
   * 普通文件与符号链接：各自的 lstat 大小；子目录：内容的**递归字节和**（不跟随符号链接，
   * 链接按自身 lstat 大小计）——这样「日志大小」显示的就是这个目录真实占的那份量，
   * 预算与窗口也就覆盖得到目录里的内容。
   */
  sizeBytes: number
  mtimeMs: number
  kind: 'file' | 'directory' | 'symlink'
}

export type LogRetentionDeps = {
  /** 平台日志根（生产取 ELYSIAN_PATHS.platformLogsDir，测试注入临时根）。 */
  platformLogsDir: string
  now(): Date
  /** 每轮巡检开头做一次，目录被外部删掉时自愈；recursive + 0700，幂等。 */
  ensureDir(dir: string): Promise<void>
  /** { path, name, sizeBytes, mtimeMs, kind }；目录不存在 → []（不做名字过滤，由本模块判定形态）。 */
  listFiles(category: LogShardCategory): Promise<LogFileStat[]>
  /**
   * 把 src 压缩写到 dest：内部先写 `dest.tmp` 再 rename（原子发布），并把 src 的 mtime
   * 搬到产物上；**不删 src**（删源由调用方在成功后做，崩溃窗口里源片始终完好）。
   */
  gzipFile(src: string, dest: string): Promise<void>
  /**
   * 幂等（不存在即成功）。普通文件与符号链接都只摘自身（**绝不跟随链接**），
   * 子目录递归删除（递归同样不跟随其中的符号链接）。
   */
  removeFile(path: string): Promise<void>
  writer: Pick<LogWriter, 'currentPath' | 'seal'>
}

export type SweepResult = {
  /** 清掉的压缩残留数。 */
  removedTmp: number
  /** 新压出的分片数。 */
  compressed: number
  /** 按时间窗口删掉的文件数。 */
  deletedByAge: number
  /** 按总量预算删掉的文件数。 */
  deletedBySize: number
  /** 本次释放的字节数（临时残留 + 按时间删 + 按预算删；压缩换形态的删源不计）。 */
  freedBytes: number
  /** 巡检结束时该类别的保留口径字节总量（不含临时残留）。 */
  totalBytes: number
  /** 本次是否因总量超预算执行过删除。 */
  trimmedBySize: boolean
  /**
   * 逐文件失败次数（ENOENT 竞态、EACCES、Z_DATA_ERROR 等）：巡检绝不让异常逃出，
   * 失败只计数——计数到这里的理由见文档「巡检逐文件 try/catch」。
   */
  failed: number
  at: string
}

/** 压缩残留的后缀：巡检第一步无条件清掉，不进保留口径。 */
export const LOG_TMP_SUFFIX = '.tmp'

/**
 * 保留/统计口径下的一个条目：类别目录里的**一切条目**，`.tmp` 除外——它在巡检第一步被无条件清掉。
 * 普通文件、符号链接、子目录都在内：目录是面板私有的 0700 目录，任何落在里面的东西都得受同一套
 * 窗口与预算约束，否则「不允许日志无限增长」就有一个开口（一个子目录可以装下任意多的字节，
 * 且完全不进「日志大小」）。
 *
 * 为什么不按 `parseLogShardName` 把外来名字排除在外：口径只认分片名，会让任何非本模块形态的
 * 东西（历史遗留、未来版本的合并块、手工放进来的文件或目录）落在时间窗口与总量预算**之外**
 * 永久累积。分片形态因此只用来决定「片名时刻 = 覆盖下界」与「能不能压缩」，不决定「要不要管」。
 */
export type RetentionEntry = {
  file: LogFileStat
  /** 名字是本模块分片时给解析结果；其它名字为 null（它们同样受窗口与预算约束）。 */
  shard: ParsedLogShardName | null
  /** 覆盖下界：分片取片名时刻，其它条目取自己的 mtime（它最后一次被改动的时刻）。 */
  at: string
}

/** 列目录结果 → 保留口径的条目（`.tmp` 除外，按覆盖下界升序）。 */
export function retentionEntries(
  files: readonly LogFileStat[],
  category: LogShardCategory,
): RetentionEntry[] {
  const entries: RetentionEntry[] = []
  for (const file of files) {
    if (file.name.endsWith(LOG_TMP_SUFFIX)) continue
    const parsed = parseLogShardName(file.name)
    const shard = parsed !== null && parsed.category === category ? parsed : null
    entries.push({ file, shard, at: shard?.at ?? new Date(file.mtimeMs).toISOString() })
  }
  return entries.sort(compareRetentionEntries)
}

/** 覆盖下界升序；同一时刻用文件名定序（与分片排序同一个判据）。 */
export function compareRetentionEntries(a: RetentionEntry, b: RetentionEntry): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  if (a.file.name === b.file.name) return 0
  return a.file.name < b.file.name ? -1 : 1
}

/**
 * 预算删除的候选顺序：**非分片条目（外来文件、符号链接、子目录）先让路**，其后才是分片按
 * 覆盖下界从旧到新。理由：分片是面板自己的日志，用户可能正要看；外来条目的「年龄」本来
 * 只能拿 mtime 近似，若把它排在日志片之后，一个被放进目录的大文件会把仍在保留窗口内的
 * 日志挤掉（实测：64 MiB 预算下，60 MiB 外来文件 + 3×8 MiB 窗口内日志片，日志片会被全删）。
 * 先清外来条目只会**减少**分片被删的条数（总量目标不变），因此对日志留存是弱占优的。
 */
export function compareBudgetCandidates(a: RetentionEntry, b: RetentionEntry): number {
  const aForeign = a.shard === null ? 0 : 1
  const bForeign = b.shard === null ? 0 : 1
  if (aForeign !== bForeign) return aForeign - bForeign
  return compareRetentionEntries(a, b)
}

function sumBytes(entries: readonly RetentionEntry[]): number {
  return entries.reduce((total, entry) => total + entry.file.sizeBytes, 0)
}

async function listEntries(deps: LogRetentionDeps, category: LogShardCategory): Promise<RetentionEntry[]> {
  return retentionEntries(await deps.listFiles(category), category)
}

/** 移除一个文件并记账；失败只计数，绝不向上抛。压缩换形态的删源不计 `freedBytes`（同基名的 `.gz` 取代了它，计入会虚报）。 */
async function removeTracked(
  path: string,
  sizeBytes: number,
  state: { freedBytes: number; failed: number },
  deps: LogRetentionDeps,
  countFreed = true,
): Promise<boolean> {
  try {
    await deps.removeFile(path)
    if (countFreed) state.freedBytes += sizeBytes
    return true
  } catch {
    state.failed += 1
    return false
  }
}

/**
 * 一次巡检：清临时残留 → 压缩 → 删（时间）→ 删（预算）。
 * 先压缩让删除看到最终形态，先把过期的删掉，预算删除才不必替过期数据买单。
 * 本函数**不抛异常**：任何单文件失败都只计数（未处理的 promise rejection 在 Bun 下会打印甚至终止进程）。
 */
export async function runRetentionSweep(
  deps: LogRetentionDeps,
  category: LogShardCategory,
): Promise<SweepResult> {
  const dir = logCategoryDir(category, deps.platformLogsDir)
  const policy = retentionPolicyOf(category)
  const nowMs = deps.now().getTime()
  const retentionMs = policy.retentionDays * DAY_MS
  const state = { freedBytes: 0, failed: 0 }
  const result: SweepResult = {
    removedTmp: 0,
    compressed: 0,
    deletedByAge: 0,
    deletedBySize: 0,
    freedBytes: 0,
    totalBytes: 0,
    trimmedBySize: false,
    failed: 0,
    at: new Date(nowMs).toISOString(),
  }

  /** 覆盖上界早于窗口起点（即已过期）。 */
  const expired = (entry: RetentionEntry): boolean => nowMs - entry.file.mtimeMs > retentionMs
  /** 静默足够久（跨进程兜底）。 */
  const quiet = (entry: RetentionEntry): boolean => nowMs - entry.file.mtimeMs > LOG_FILE_QUIET_MS

  try {
    await deps.ensureDir(dir)
  } catch (error) {
    // 目录不可写（权限被改）或重建失败：本轮跳过并只告警一次，不刷屏、不做更激进的动作。
    state.failed += 1
    console.error(
      `Elysian 日志巡检跳过本轮（${category}：${dir}）：${error instanceof Error ? error.message : String(error)}`,
    )
    result.failed = state.failed
    result.totalBytes = sumBytes(await listEntries(deps, category))
    return result
  }

  const firstListing = await deps.listFiles(category)

  // 动作零：清临时残留（.tmp 一律是上次崩溃的残留：gzip 与清空都在同一把维护锁下串行，此刻不可能有 in-flight 的 .tmp）。
  for (const file of firstListing) {
    if (!file.name.endsWith(LOG_TMP_SUFFIX)) continue
    if (await removeTracked(file.path, file.sizeBytes, state, deps)) result.removedTmp += 1
  }

  // 动作一：压缩（封盘即压，无额外时间档）：已封盘、静默足够久、且未过期的 .jsonl → .jsonl.gz。
  // 只压分片形态的**普通文件**（外来条目不是我们的日志片，压了也认不出来；目录更压不了）。
  const activePath = deps.writer.currentPath()
  for (const entry of retentionEntries(firstListing, category)) {
    if (entry.file.kind !== 'file') continue
    if (entry.shard === null || entry.shard.compressed) continue
    if (entry.file.path === activePath) continue // 活动片永不压缩（否则写入器会重建同名空片）
    if (!quiet(entry)) continue
    if (expired(entry)) continue // 已过期的片跳过压缩，交给下一步直接删
    try {
      await deps.gzipFile(entry.file.path, `${entry.file.path}.gz`)
    } catch {
      state.failed += 1
      continue
    }
    result.compressed += 1
    // rename 之后、unlink 之前的短暂窗口里 .jsonl 与 .jsonl.gz 并存：读侧按 id 去重吸收。
    await removeTracked(entry.file.path, entry.file.sizeBytes, state, deps, false)
  }

  // 动作二：删（时间窗口）。重新列目录：上一步把 .jsonl 换成了 .jsonl.gz。
  // 口径与统计一致：目录里的一切普通文件（含外来名字）都受窗口约束，没有东西能永久累积。
  for (const entry of await listEntries(deps, category)) {
    if (!quiet(entry)) continue
    if (!expired(entry)) continue
    if (entry.file.path === deps.writer.currentPath()) {
      // 活动片被判定过期时不直接删：先封盘降级，下一轮巡检再删（删除与写入器状态解耦）。
      try {
        await deps.writer.seal()
      } catch {
        state.failed += 1
      }
      continue
    }
    if (await removeTracked(entry.file.path, entry.file.sizeBytes, state, deps)) result.deletedByAge += 1
  }

  // 动作三：删（总量预算）。**外来条目（非分片）先让路，其后分片按覆盖下界从旧到新**，直到 ≤ 预算；
  // 活动片不参与（配置异常时也不删正在写的文件）。排序理由见 compareBudgetCandidates。
  let remaining = await listEntries(deps, category)
  let total = sumBytes(remaining)
  const activeNow = deps.writer.currentPath()
  for (const entry of [...remaining].sort(compareBudgetCandidates)) {
    if (total <= policy.maxTotalBytes) break
    if (entry.file.path === activeNow) continue
    if (!quiet(entry)) continue
    if (await removeTracked(entry.file.path, entry.file.sizeBytes, state, deps)) {
      result.deletedBySize += 1
      result.trimmedBySize = true
      total -= entry.file.sizeBytes
    }
  }

  // 收尾统计：以磁盘现状为准（不用推算值）。
  remaining = await listEntries(deps, category)
  result.freedBytes = state.freedBytes
  result.failed = state.failed
  result.totalBytes = sumBytes(remaining)
  return result
}

/**
 * 存储统计聚合：两类的字节与条目数、最旧条目的覆盖下界，加上该类别自己的巡检状态与进程内计数器。
 * 口径与巡检一致（目录里的一切条目、`.tmp` 除外，子目录按递归字节和计），所以「日志大小」
 * 显示的就是预算所约束的那份量。
 */
export async function collectStorageStats(
  deps: Pick<LogRetentionDeps, 'listFiles'>,
  counters: { droppedRecords: number; failedWrites: number },
  sweepState: { lastSweepAt: string | null; trimmedBySize: boolean },
): Promise<LogStorageStats> {
  const [runtimeFiles, operationFiles] = await Promise.all([
    deps.listFiles('runtime'),
    deps.listFiles('operation'),
  ])
  const runtime = retentionEntries(runtimeFiles, 'runtime')
  const operation = retentionEntries(operationFiles, 'operation')
  const runtimeBytes = sumBytes(runtime)
  const operationBytes = sumBytes(operation)
  const oldest = [...runtime, ...operation]
    .map((entry) => entry.at)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0]

  return {
    totalBytes: runtimeBytes + operationBytes,
    runtimeBytes,
    operationBytes,
    runtimeRowCount: runtime.length,
    operationRowCount: operation.length,
    rowCount: runtime.length + operation.length,
    oldestAt: oldest ?? null,
    lastSweepAt: sweepState.lastSweepAt,
    trimmedBySize: sweepState.trimmedBySize,
    droppedRecords: counters.droppedRecords,
    failedWrites: counters.failedWrites,
  }
}
