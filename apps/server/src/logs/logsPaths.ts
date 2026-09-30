import { join } from 'node:path'
import type { PlatformLogCategory } from '@elysian/contracts'

/** 分片目录名。login 与运行/操作共用写入器，但不是 PlatformLogCategory。 */
export type LogShardCategory = PlatformLogCategory | 'login'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'

/*
 * 平台日志的目录与文件名规则（纯计算，不碰文件系统）。
 *
 * 分片：`<category>-<YYYYMMDDTHHMMSSZ>.jsonl`，时刻是**片首条日志的写入时刻（UTC）**，
 * 固定宽度基本格式 → 文件名字典序 = 时间序；压缩产物同基名加 `.gz`。
 * 同名冲突（同秒内第二次分片，正常不可能发生）追加 `_2`、`_3`：
 * 分隔符用 `_`(0x5F) 而不是 `-`(0x2D) 是有理由的——`.` 的码位是 0x2E，
 * 用 `-2` 会让冲突片在字典序里排到基名之前，破坏「字典序 = 时间序」；
 * `_2` 排在基名之后。读侧另用「解析出的 at + 文件名」双键排序（见 logReader），
 * 不把正确性单独押在文件名上。
 *
 * 目录一律经 shared/elysianPaths 的出口解析：默认根是 ELYSIAN_PATHS.platformLogsDir，
 * 测试与其它形态用参数注入临时根，任何调用方都不硬编码 home 目录。
 */

/** 平台日志根目录的默认落点（唯一出口：shared/elysianPaths）。 */
export const DEFAULT_PLATFORM_LOGS_DIR = ELYSIAN_PATHS.platformLogsDir

/** 分片扩展名与压缩分片扩展名。 */
const SHARD_EXTENSION = '.jsonl'
const COMPRESSED_SHARD_EXTENSION = '.jsonl.gz'

export type ParsedLogShardName = {
  category: LogShardCategory
  /** 片首条日志的时刻（ISO 8601、秒精度、Z 结尾），即文件名里那段时刻。 */
  at: string
  compressed: boolean
}

/** 类别目录：`<平台日志根>/<类别>`。 */
export function logCategoryDir(
  category: LogShardCategory,
  rootDir: string = DEFAULT_PLATFORM_LOGS_DIR,
): string {
  return join(rootDir, category)
}

/**
 * 分片文件名。`duplicateIndex` 省略或为 1 时是基本形态；≥ 2 时在扩展名前插
 * `_<n>`（同名冲突，见文件头）。`compressed` 为真时加 `.gz`。
 */
export function logShardName(
  category: LogShardCategory,
  at: Date,
  compressed: boolean,
  duplicateIndex = 1,
): string {
  const iso = at.toISOString()
  const stamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  const suffix = duplicateIndex >= 2 ? `_${duplicateIndex}` : ''
  const extension = compressed ? COMPRESSED_SHARD_EXTENSION : SHARD_EXTENSION
  return `${category}-${stamp}${suffix}${extension}`
}

const SHARD_NAME_PATTERN = /^(runtime|operation|login)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(?:_(\d+))?\.jsonl(\.gz)?$/

/**
 * 解析文件名；不是本模块形态时返回 null（sshd.log、临时文件、外部文件都落到 null）。
 * 秒精度以下的毫秒不入名（片名只到秒），冲突由 `_2` 后缀承担。
 */
export function parseLogShardName(name: string): ParsedLogShardName | null {
  const match = SHARD_NAME_PATTERN.exec(name)
  if (match === null) return null
  const category = match[1] as LogShardCategory
  // `_1` 不是本模块产生的形态（基本形态不带后缀），一律落到 null。
  if (match[8] !== undefined && Number(match[8]) < 2) return null
  const at = `${match[2]}-${match[3]}-${match[4]}T${match[5]}:${match[6]}:${match[7]}Z`
  if (!isRealUtcSecond(at)) return null
  return { category, at, compressed: match[9] === '.gz' }
}

/**
 * 逐段形状对但日期不存在的时刻（2026-13-01、2026-02-30）不作数：`Date.parse` 会把
 * 越界日**滚动**到下个月而不是返回 NaN，因此用「格式化回来必须相同」复核。
 */
function isRealUtcSecond(at: string): boolean {
  const parsed = Date.parse(at)
  if (Number.isNaN(parsed)) return false
  // 与形如 'YYYY-MM-DDTHH:mm:ssZ' 的定宽形状比前 19 位（末尾 Z 不参与比较）。
  return new Date(parsed).toISOString().slice(0, 19) === at.slice(0, 19)
}

/** 活动片判定用的 UTC 日键，如 '2026-09-23'（与文件名同口径）。 */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/** 片名里的 UTC 日键，如 '2026-09-23'。 */
export function utcDayKeyOfShard(name: ParsedLogShardName): string {
  return name.at.slice(0, 10)
}

/**
 * 分片排序：按 `(解析出的 at, 文件名)` **升序**。`at` 是定宽 ISO，字典序即时间序，
 * 文件名只作同一时刻（同名同秒）的稳定次序——不把正确性单独押在文件名比较上。
 */
export function compareLogShards(
  a: { name: string; parsed: ParsedLogShardName },
  b: { name: string; parsed: ParsedLogShardName },
): number {
  if (a.parsed.at !== b.parsed.at) return a.parsed.at < b.parsed.at ? -1 : 1
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}
