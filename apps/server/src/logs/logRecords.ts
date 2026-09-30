import {
  LOGIN_LOG_STATUSES,
  OPERATION_LOG_CATEGORIES,
  OPERATION_LOG_OUTCOMES,
  PLATFORM_LOG_LEVELS,
  type LoginLogEntry,
  type LoginLogStatus,
  type OperationLogCategory,
  type OperationLogEntry,
  type OperationLogOutcome,
  type PlatformLogLevel,
  type RuntimeLogEntry,
} from '@elysian/contracts'

/*
 * 平台日志的记录形状、净化与逐行解析（全纯函数；导入分片与读回共用同一套判据）。
 *
 * 净化面是**整行**：运行日志的 source/message 与操作日志的 action/target/summary/method/path
 * 在写入前全部过 normalizeSingleLine，不是只洗 message。理由有两面：
 * ① c.req.path 是百分号解码过的，路径参数会流进 target/summary；
 * ② 任何一条含 U+2028 的正文都会让读侧把它切成两行、两段都解析失败。
 *
 * null 分支只出现在 parse*LogLine：坏行与形状不合法返回 null，读取侧计入 skippedLines。
 */

/** message 上限（字符）：先截断，再走 64 KiB 硬闸。 */
export const LOG_MESSAGE_MAX_LENGTH = 4096
/** source / action / target 上限（字符）。 */
export const LOG_SOURCE_MAX_LENGTH = 64
export const LOG_ACTION_MAX_LENGTH = 64
export const LOG_TARGET_MAX_LENGTH = 64
/** summary 上限（字符）。 */
export const LOG_SUMMARY_MAX_LENGTH = 200
/**
 * method / path 上限（字符）：净化面同在上面那张清单里，这两个字段的宽度由本文件钉住
 * （HTTP 方法名与请求路径都是短串，2048 与常见服务器请求行上限同一量级）。
 */
export const LOG_METHOD_MAX_LENGTH = 16
export const LOG_PATH_MAX_LENGTH = 2048
/** 登录来源地址上限（IPv6 文本远短于它）。 */
export const LOG_IP_MAX_LENGTH = 64
/** 归属地上限：真实记录只有「本机 / 内网 / 未知」。 */
export const LOG_LOCATION_MAX_LENGTH = 32
/** User-Agent 上限：超长截断，表格本身也只展示截断后的整串。 */
export const LOG_USER_AGENT_MAX_LENGTH = 512
/** 单条记录的字节上限：超限的记录直接丢弃，保证一条记录永远塞得进一个分片。 */
export const LOG_RECORD_MAX_BYTES = 64 * 1024
/** 截断标记：正文超长时追加在末尾，且计入上限。 */
export const LOG_TRUNCATION_MARKER = '…（已截断）'

export type RuntimeLogRecord = {
  at: string
  seq: number
  level: PlatformLogLevel
  source: string
  message: string
}

export type LoginLogRecord = {
  at: string
  seq: number
  ip: string
  location: string
  userAgent: string
  status: LoginLogStatus
}

export type OperationLogRecord = {
  at: string
  seq: number
  category: OperationLogCategory
  action: string
  target: string | null
  result: OperationLogOutcome
  httpStatus: number | null
  method: string | null
  path: string | null
  summary: string
}

/**
 * C0（U+0000–U+001F，含 \n \r \t）、DEL（U+007F）、C1（U+0080–U+009F，含 U+0085 NEL）、
 * U+2028（LINE SEPARATOR）、U+2029（PARAGRAPH SEPARATOR）。
 * U+2028/U+2029 必须在列表里：JSON.stringify 不转义它们，而 readline 把两者当行分隔符
 * ——漏掉会让一条日志在文件里是一行、读侧被切碎后两段都解析失败，记录静默消失。
 */
const LINE_BREAKING_OR_CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/**
 * 单行化：把控制字符与行分隔符码位**换成空格**（不是删除——删掉会把本该分开的两段
 * 粘成一个词），连续空白压成一个空格后 trim，再按 maxLength 截断。
 * 截断时保留的正文长度 = maxLength − 标记长度，末尾追加 `…（已截断）`，
 * 因此返回值长度恒 ≤ maxLength；maxLength 小到装不下标记时退化为纯截断。
 */
export function normalizeSingleLine(text: string, maxLength: number): string {
  const normalized = text.replace(LINE_BREAKING_OR_CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  if (maxLength <= LOG_TRUNCATION_MARKER.length) return normalized.slice(0, Math.max(0, maxLength))
  return `${normalized.slice(0, maxLength - LOG_TRUNCATION_MARKER.length)}${LOG_TRUNCATION_MARKER}`
}

/** 单行文本的 UTF-8 字节数（硬闸的度量口径）。 */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** 单行是否超过单条记录上限（超限丢弃并计数，不抛错）。 */
export function isRecordOversize(line: string): boolean {
  return utf8ByteLength(line) > LOG_RECORD_MAX_BYTES
}

/** 解析出的 JSON 对象（非对象与坏 JSON 都返回 null）。 */
function asJsonObject(line: string): Record<string, unknown> | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value))
}

function isLogLevel(value: unknown): value is PlatformLogLevel {
  return typeof value === 'string' && (PLATFORM_LOG_LEVELS as readonly string[]).includes(value)
}

function isOperationCategory(value: unknown): value is OperationLogCategory {
  return typeof value === 'string' && (OPERATION_LOG_CATEGORIES as readonly string[]).includes(value)
}

function isLoginStatus(value: unknown): value is LoginLogStatus {
  return typeof value === 'string' && (LOGIN_LOG_STATUSES as readonly string[]).includes(value)
}

function isOperationOutcome(value: unknown): value is OperationLogOutcome {
  return typeof value === 'string' && (OPERATION_LOG_OUTCOMES as readonly string[]).includes(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/** 解析运行日志的一行；坏行与形状不合法返回 null。 */
export function parseRuntimeLogLine(line: string): RuntimeLogRecord | null {
  const value = asJsonObject(line)
  if (value === null) return null
  if (!isIsoTimestamp(value['at'])) return null
  if (!Number.isInteger(value['seq'])) return null
  if (!isLogLevel(value['level'])) return null
  if (typeof value['source'] !== 'string' || typeof value['message'] !== 'string') return null
  return {
    at: value['at'],
    seq: value['seq'] as number,
    level: value['level'],
    source: value['source'],
    message: value['message'],
  }
}

/** 解析登录日志的一行；坏行与形状不合法返回 null。 */
export function parseLoginLogLine(line: string): LoginLogRecord | null {
  const value = asJsonObject(line)
  if (value === null) return null
  if (!isIsoTimestamp(value['at'])) return null
  if (!Number.isInteger(value['seq'])) return null
  if (typeof value['ip'] !== 'string' || typeof value['location'] !== 'string') return null
  if (typeof value['userAgent'] !== 'string') return null
  if (!isLoginStatus(value['status'])) return null
  return {
    at: value['at'],
    seq: value['seq'] as number,
    ip: value['ip'],
    location: value['location'],
    userAgent: value['userAgent'],
    status: value['status'],
  }
}

/** 解析操作日志的一行；坏行与形状不合法返回 null。 */
export function parseOperationLogLine(line: string): OperationLogRecord | null {
  const value = asJsonObject(line)
  if (value === null) return null
  if (!isIsoTimestamp(value['at'])) return null
  if (!Number.isInteger(value['seq'])) return null
  if (!isOperationCategory(value['category'])) return null
  if (typeof value['action'] !== 'string') return null
  if (!isNullableString(value['target'])) return null
  if (!isOperationOutcome(value['result'])) return null
  if (value['httpStatus'] !== null && !Number.isInteger(value['httpStatus'])) return null
  if (!isNullableString(value['method'])) return null
  if (!isNullableString(value['path'])) return null
  if (typeof value['summary'] !== 'string') return null
  return {
    at: value['at'],
    seq: value['seq'] as number,
    category: value['category'],
    action: value['action'],
    target: value['target'],
    result: value['result'],
    httpStatus: value['httpStatus'] as number | null,
    method: value['method'],
    path: value['path'],
    summary: value['summary'],
  }
}

/** 记录 id：`<at>#<seq>`，同一响应内唯一。 */
export function logRecordId(at: string, seq: number): string {
  return `${at}#${seq}`
}

/** 已校验的记录 → 界面条目（只补 id）。全函数，不返回 null：形状由解析层负责。 */
export function toRuntimeLogEntry(record: RuntimeLogRecord): RuntimeLogEntry {
  return {
    id: logRecordId(record.at, record.seq),
    at: record.at,
    level: record.level,
    source: record.source,
    message: record.message,
  }
}

/** 已校验的记录 → 界面条目。time 取 at（界面字段名与运行/操作日志的 at 不同）。 */
export function toLoginLogEntry(record: LoginLogRecord): LoginLogEntry {
  return {
    id: logRecordId(record.at, record.seq),
    ip: record.ip,
    location: record.location,
    userAgent: record.userAgent,
    status: record.status,
    time: record.at,
  }
}

/** 已校验的记录 → 界面条目（只补 id）。全函数，不返回 null：形状由解析层负责。 */
export function toOperationLogEntry(record: OperationLogRecord): OperationLogEntry {
  return {
    id: logRecordId(record.at, record.seq),
    at: record.at,
    category: record.category,
    action: record.action,
    target: record.target,
    summary: record.summary,
    result: record.result,
    method: record.method,
    path: record.path,
    httpStatus: record.httpStatus,
  }
}
