/*
 * 平台日志的类型与词典：运行日志（平台自身的运行输出）与操作日志（系统级操作与
 * 经界面按钮间接触发的动作）。两类都由服务端真实写入部署机器的
 * ~/.Elysian/logs/platform/ 下，界面读同一份文件；登录日志本期仍是 mock，
 * 形状留在 ./logs.ts，不属于本模块。
 *
 * 本模块只放类型、枚举、纯常量表与纯函数——契约包不得引入运行时依赖。
 * 存储统计与列表/清空报告也在这里：它们是两端之间的传输形状，与落盘无关。
 */

/** 平台日志类别。登录日志不在其中：它本期不落盘。 */
export type PlatformLogCategory = 'runtime' | 'operation'

export const PLATFORM_LOG_CATEGORIES = [
  'runtime',
  'operation',
] as const satisfies readonly PlatformLogCategory[]

export const PLATFORM_LOG_CATEGORY_LABELS: Record<PlatformLogCategory, string> = {
  runtime: '运行日志',
  operation: '操作日志',
}

export type PlatformLogLevel = 'debug' | 'info' | 'warning' | 'error'

export const PLATFORM_LOG_LEVELS = [
  'debug',
  'info',
  'warning',
  'error',
] as const satisfies readonly PlatformLogLevel[]

export const PLATFORM_LOG_LEVEL_LABELS: Record<PlatformLogLevel, string> = {
  debug: '调试',
  info: '信息',
  warning: '警告',
  error: '错误',
}

export const PLATFORM_LOG_LEVEL_RANK: Record<PlatformLogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
}

/** 运行日志条目（界面形状）。 */
export type RuntimeLogEntry = {
  /** 稳定 id：`<at>#<seq>`。 */
  id: string
  at: string
  level: PlatformLogLevel
  /** 产生日志的组件标识（英文点分，如 server.lifecycle）。 */
  source: string
  message: string
}

/** 操作日志：操作分类。安全区按面板分区、数据库按「按钮间接操作数据库」的语义单列。 */
export type OperationLogCategory =
  | 'security'
  | 'files'
  | 'database'
  | 'terminals'
  | 'logs'
  | 'containers'

export const OPERATION_LOG_CATEGORIES = [
  'security',
  'files',
  'database',
  'terminals',
  'logs',
  'containers',
] as const satisfies readonly OperationLogCategory[]

export const OPERATION_LOG_CATEGORY_LABELS: Record<OperationLogCategory, string> = {
  security: '安全设置',
  files: '文件管理',
  database: '数据库',
  terminals: '终端会话',
  logs: '日志管理',
  containers: '容器管理',
}

export type OperationLogOutcome = 'success' | 'failure'

export const OPERATION_LOG_OUTCOMES = [
  'success',
  'failure',
] as const satisfies readonly OperationLogOutcome[]

export const OPERATION_LOG_OUTCOME_LABELS: Record<OperationLogOutcome, string> = {
  success: '成功',
  failure: '失败',
}

/** 操作日志条目（界面形状）。 */
export type OperationLogEntry = {
  id: string
  at: string
  category: OperationLogCategory
  /** 动作短语，如「修改 SSH 监听端口」。 */
  action: string
  /** 动作对象，如「sshd」「账号 wangwu」；没有对象时为 null。 */
  target: string | null
  /** 参数摘要，如「端口 2222」；没有参数时为空串。 */
  summary: string
  result: OperationLogOutcome
  actor: string
  method: string | null
  path: string | null
  httpStatus: number | null
}

/** 单类别的保留策略。 */
export type LogRetentionPolicy = {
  /** 保留窗口（天）。 */
  retentionDays: number
  /** 该类别日志文件的字节总量上限。 */
  maxTotalBytes: number
}

export const LOG_RETENTION_POLICIES: Record<PlatformLogCategory, LogRetentionPolicy> = {
  runtime: { retentionDays: 7, maxTotalBytes: 256 * 1024 * 1024 },
  operation: { retentionDays: 30, maxTotalBytes: 64 * 1024 * 1024 },
}

/** 单个日志文件的字节上限：达到即滚动到新分片（界面在清空确认里说明）。 */
export const LOG_SHARD_MAX_BYTES = 8 * 1024 * 1024

/** 单次读取最多返回的条目数（取最近的）；超出部分留在服务器磁盘上。 */
export const LOG_ENTRY_FETCH_LIMIT = 1000

/** 允许从界面清空的类别。不在表内的类别只能由保留策略清理。 */
export const LOG_CLEARABLE_CATEGORIES = [
  'runtime',
  'operation',
] as const satisfies readonly PlatformLogCategory[]

/** 日志存储统计：界面「日志大小」与清空确认共用。 */
export type LogStorageStats = {
  /** 运行 + 操作两类的字节总和：界面「日志大小」显示的就是它。 */
  totalBytes: number
  runtimeBytes: number
  operationBytes: number
  /** 条目数：分片、压缩片，以及目录里其它被纳入保留口径的条目（外来文件、符号链接、子目录）。 */
  fileCount: number
  /** 现存最旧日志的覆盖下界（分片取片名时刻，其它条目取 mtime）；没有日志时为 null。 */
  oldestAt: string | null
  /** 本进程内**该类别**最近一次保留巡检的时间（ISO）；还没跑过为 null。 */
  lastSweepAt: string | null
  /** **该类别**最近一次巡检是否因总量超预算执行过删除（界面据此提示旧日志被自动清理）。 */
  trimmedBySize: boolean
  /** 本进程内因超长被丢弃的记录数（正常为 0）。 */
  droppedRecords: number
  /** 本进程内写盘失败的记录数（正常为 0；操作日志面板据此提示审计缺口）。 */
  failedWrites: number
}

/** 运行日志列表响应。 */
export type RuntimeLogListReport = {
  /** 时间倒序（新 → 旧），与操作日志、登录日志同一口径：最新一条在最上。 */
  entries: readonly RuntimeLogEntry[]
  /** 因条数上限或读取字节预算未读全（更旧的内容还在磁盘上）。 */
  truncated: boolean
  /** 无法解析而被跳过的行数（正常为 0；非 0 时界面提示）。 */
  skippedLines: number
  /** 读取失败而被整份跳过的文件数（ENOENT 竞态、EACCES、.gz 损坏等；正常为 0）。 */
  skippedFiles: number
  storage: LogStorageStats
}

/** 操作日志列表响应。 */
export type OperationLogListReport = {
  /** 时间倒序（新 → 旧），与登录日志一致。 */
  entries: readonly OperationLogEntry[]
  truncated: boolean
  skippedLines: number
  skippedFiles: number
  storage: LogStorageStats
}

/** 清空结果：已删除的事实。 */
export type LogClearReport = {
  category: PlatformLogCategory
  fileCount: number
  totalBytes: number
  /** 被清掉的最旧日志的片名时刻（ISO）；本来就没有日志时为 null。 */
  oldestAt: string | null
  clearedAt: string
}

const BYTES_PER_KB = 1024
const BYTES_PER_MB = 1024 * 1024
const BYTES_PER_GB = 1024 * 1024 * 1024

type LogByteUnit = 'KB' | 'MB' | 'GB'

function logByteUnit(scale: 0 | 1 | 2): LogByteUnit {
  if (scale === 0) return 'KB'
  if (scale === 1) return 'MB'
  return 'GB'
}

function logByteDivisor(scale: 0 | 1 | 2): number {
  if (scale === 0) return BYTES_PER_KB
  if (scale === 1) return BYTES_PER_MB
  return BYTES_PER_GB
}

/**
 * 日志体积的中文文案：**日志体积显示的唯一函数**（工具栏「日志大小」、清空确认、
 * 保留说明三处共用）。规则可判定，实现不得自行取整：
 *   先按量级选单位（bytes < 1 MiB → KB；< 1 GiB → MB；否则 GB），数值一律 toFixed(2)；
 *   若显示值 ≥ 1024.00 则逐级进位（KB → MB → GB），直到 < 1024.00 或已是 GB。
 *   0 → '0.00 KB'；1023 → '1.00 KB'；1048000 → '1023.44 KB'；1048575 → '1.00 MB'（1024.00 KB 进位）；
 *   1048576 → '1.00 MB'；13713 → '13.39 KB'；1073741823 → '1.00 GB'（1024.00 MB 进位）；
 *   1073741824 → '1.00 GB'；2147483648 → '2.00 GB'。
 */
export function formatLogBytes(bytes: number): string {
  // 非正数与非法数值（NaN）都归到 0：字节数在面板里不可能是负数。
  if (!(bytes > 0)) return `0.00 ${logByteUnit(0)}`
  let scale: 0 | 1 | 2 = bytes < BYTES_PER_MB ? 0 : bytes < BYTES_PER_GB ? 1 : 2
  let text = (bytes / logByteDivisor(scale)).toFixed(2)
  // 进位看的是**显示值**：1023.999 KB 显示成 1024.00 时也要进到 MB。
  while (Number(text) >= 1024 && scale < 2) {
    scale = (scale + 1) as 0 | 1 | 2
    text = (bytes / logByteDivisor(scale)).toFixed(2)
  }
  return `${text} ${logByteUnit(scale)}`
}

/** 保留策略的一行中文说明：`保留 7 天 · 总量上限 256.00 MB，超出后旧日志先压缩再自动删除`（数值一律走 formatLogBytes）。 */
export function logRetentionText(category: PlatformLogCategory): string {
  const policy = LOG_RETENTION_POLICIES[category]
  return `保留 ${policy.retentionDays} 天 · 总量上限 ${formatLogBytes(policy.maxTotalBytes)}，超出后旧日志先压缩再自动删除`
}
