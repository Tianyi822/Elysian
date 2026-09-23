import { LOG_ENTRY_FETCH_LIMIT, type PlatformLogCategory } from '@elysian/contracts'
import { compareLogShards, parseLogShardName, type ParsedLogShardName } from './logsPaths.ts'

/*
 * 平台日志的读取器：把分片按时间顺序拼回一条流。
 *
 * 三条性质同时成立（见文档第五节）：
 * 1. 顺序由 `(at, seq)` 决定——先按 (解析出的 at, 文件名) 给文件排序，再从最新往旧读；
 * 2. 截断永远从最旧一侧切——文件内用滚动缓冲保留最新的 cap 条，acc 用**前插 + 头丢**
 *    （丢弃端必须与插入端相反；尾插 + 尾丢会在「旧文件很大 + 新文件很小」时丢错端、产生空洞）；
 * 3. 内存有硬上限——acc 与文件内缓冲都不超过 LOG_READ_MAX_RECORDS，更旧的文件整份不读。
 *
 * 「目录不存在 → 零个文件」「只读普通文件」「读失败逐文件跳过」是 deps 侧的口径
 * （listFiles / readLines 的契约写在类型注释里，真实接线在 logsHostDeps）。
 */

/** 单次读取在内存里保留的记录条数硬上限（= 20 × LOG_ENTRY_FETCH_LIMIT）。 */
export const LOG_READ_MAX_RECORDS = 20 * LOG_ENTRY_FETCH_LIMIT

/** 单次读取累计磁盘字节的次要闸（按压缩后的字节计；真正托底的是条数上限）。 */
export const LOG_READ_MAX_BYTES = 64 * 1024 * 1024

export type LogFileRef = {
  path: string
  name: string
  sizeBytes: number
}

export type LogReaderDeps<Record> = {
  /**
   * 目录不存在（ENOENT）→ []，其它错误也归一为 []：读取侧永不因目录状态失败。
   * **只返回 lstat 为普通文件的项**：符号链接与子目录一律跳过（不跟随链接读外部文件）。
   */
  listFiles(category: PlatformLogCategory): Promise<readonly LogFileRef[]>
  /**
   * 逐行读一个文件到 EOF；实现内部对 .gz 自动接 createGunzip，并自行关闭流与 readline。
   * 没有「中途停止」的契约：读侧要的是文件的尾部（最新记录），中途停下只会丢掉尾部。
   * 文件级错误（ENOENT/EACCES/Z_DATA_ERROR）由调用方逐文件 try/catch 吸收，本函数可以抛。
   */
  readLines(path: string, onLine: (line: string) => void): Promise<void>
  /** 逐行解析：坏行返回 null（计入 skippedLines）。service 按类别传 parseRuntimeLogLine / parseOperationLogLine。 */
  parseLine(line: string): Record | null
}

export type LogReadResult<Record> = {
  /** 时间升序（旧 → 新）的记录，最多 limit 条。 */
  records: readonly Record[]
  /** 因条数上限或读取字节预算未读全（更旧的内容还在磁盘上）。 */
  truncated: boolean
  /** 无法解析而被跳过的行数。 */
  skippedLines: number
  /** 读取失败而被整份跳过的文件数。 */
  skippedFiles: number
}

/**
 * 逐文件滚动缓冲：只在内存里保留该文件最新的 cap 条记录（环形数组，容量恒定）。
 * 溢出过即 overflowed()，调用方据此置 truncated——文件内早于窗口的行直接丢。
 */
function createRollingBuffer<Record>(capacity: number): {
  push(record: Record): void
  items(): Record[]
  overflowed(): boolean
} {
  const size = Math.max(1, Math.floor(capacity))
  const slots: (Record | undefined)[] = new Array<Record | undefined>(size)
  let count = 0
  let overflowed = false
  return {
    push(record) {
      if (count >= size) overflowed = true
      slots[count % size] = record
      count += 1
    },
    items() {
      const kept: Record[] = []
      const start = count > size ? count % size : 0
      const total = Math.min(count, size)
      for (let index = 0; index < total; index += 1) {
        const record = slots[(start + index) % size]
        if (record !== undefined) kept.push(record)
      }
      return kept
    },
    overflowed() {
      return overflowed
    },
  }
}

/** 排序口径：`(at, seq)` 升序；完全相同的一对保持到达次序（稳定排序）。 */
function compareRecordsByTime(a: { at: string; seq: number }, b: { at: string; seq: number }): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  return a.seq - b.seq
}

/**
 * 读一个类别的日志：从最新往旧逐文件读，内存有硬上限，返回最近 limit 条（时间升序）。
 * 单个文件读失败只计入 skippedFiles，绝不向上抛；坏行计入 skippedLines。
 */
export async function readLogRecords<Record extends { at: string; seq: number }>(
  deps: LogReaderDeps<Record>,
  category: PlatformLogCategory,
  limit: number,
): Promise<LogReadResult<Record>> {
  const listed = await deps.listFiles(category)
  const files = listed
    .map((ref) => ({ ref, parsed: parseLogShardName(ref.name) }))
    .filter(
      (entry): entry is { ref: LogFileRef; parsed: ParsedLogShardName } =>
        entry.parsed !== null && entry.parsed.category === category,
    )
    .map((entry) => ({ name: entry.ref.name, parsed: entry.parsed, ref: entry.ref }))
    .sort(compareLogShards)

  let acc: Record[] = []
  let truncated = false
  let skippedLines = 0
  let skippedFiles = 0
  let diskBytes = 0

  // 从最新往旧逐文件读：acc 始终按时间升序，且只保留到目前为止见到的最新 cap 条。
  for (let index = files.length - 1; index >= 0; index -= 1) {
    const entry = files[index]
    if (entry === undefined) continue
    if (acc.length >= LOG_READ_MAX_RECORDS || diskBytes >= LOG_READ_MAX_BYTES) {
      // ③ 停止读更旧的文件：剩下的整份不读，更旧的内容还在磁盘上。
      truncated = true
      break
    }
    diskBytes += entry.ref.sizeBytes
    // 每个文件都整份读完：要拿到一个文件的「最新记录」就必须读到它的末尾。
    const buffer = createRollingBuffer<Record>(LOG_READ_MAX_RECORDS)
    try {
      await deps.readLines(entry.ref.path, (line) => {
        const record = deps.parseLine(line)
        if (record === null) {
          skippedLines += 1
          return
        }
        buffer.push(record)
      })
    } catch {
      // 单个文件读失败（ENOENT 竞态、EACCES、.gz 被改坏、流提前关闭）：跳过继续读下一个。
      skippedFiles += 1
      continue
    }
    if (buffer.overflowed()) truncated = true // ① 文件内滚动缓冲丢掉了更早的行
    const fileRecords = buffer.items()
    if (fileRecords.length === 0) continue
    // 前插：该文件整体比 acc 里所有记录都更旧。
    acc = [...fileRecords, ...acc]
    if (acc.length > LOG_READ_MAX_RECORDS) {
      // ② 从头部丢弃：丢掉的才是全局最旧的那批（前插就从头丢）。
      acc = acc.slice(acc.length - LOG_READ_MAX_RECORDS)
      truncated = true
    }
  }

  // 防御性稳定排序：外部植入或旧版本写出的文件内部可能乱序。
  const sorted = [...acc].sort(compareRecordsByTime)
  // 按 id（`<at>#<seq>`）去重，丢掉后出现的重复项：吸收「压缩 rename 后 unlink 前」的并存窗口。
  const seen = new Set<string>()
  const unique: Record[] = []
  for (const record of sorted) {
    const id = `${record.at}#${record.seq}`
    if (seen.has(id)) continue
    seen.add(id)
    unique.push(record)
  }

  // 截断只在排序之后取最后 limit 条：界面显示的永远是「最近 N 条」。
  const wanted = Math.max(0, Math.floor(limit))
  const records = unique.length > wanted ? unique.slice(unique.length - wanted) : unique
  if (unique.length > wanted) truncated = true
  return { records, truncated, skippedLines, skippedFiles }
}
