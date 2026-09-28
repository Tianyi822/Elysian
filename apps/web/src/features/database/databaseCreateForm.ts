import type { DatabaseInstance } from '@elysian/contracts'
import type { DatabaseCreateFileInput } from '../../contracts/adapters'

/**
 * 添加 SQLite 数据库表单的草稿与校验：纯函数、无 React 依赖。
 *
 * 文件型（SQLite）：数据库就是一个 .db 文件，没有容器也没有账号，
 * 来源二选一——拖拽/选择上传既有文件、或直接新建空库；
 * 文件路径与大小由服务端决定，客户端只收集名称与来源。
 */

/** SQLite 库文件的扩展名。 */
export const SQLITE_FILE_SUFFIX = '.db'

/**
 * 文件来源：
 * - `upload`：拖拽或选择本地文件，二者对表单等价，都是得到一个既有文件；
 * - `create`：直接新建一个空库，只填名称。
 */
export type SqliteFileSource = 'upload' | 'create'

export const SQLITE_FILE_SOURCES = ['upload', 'create'] as const satisfies readonly SqliteFileSource[]

export const SQLITE_FILE_SOURCE_LABELS: Record<SqliteFileSource, string> = {
  upload: '拖拽或选择本地文件',
  create: '直接新建空库',
}

export type DatabaseCreateDraft = {
  name: string
  /** 文件型：来源。 */
  fileSource: SqliteFileSource
  /** 文件型：上传/选择的文件名（含扩展名）。 */
  fileName: string
  /** 文件型：上传/选择的文件大小（MB），仅用于表单展示。 */
  fileSizeMb?: number
}

export function emptyDraft(): DatabaseCreateDraft {
  return {
    name: '',
    fileSource: 'upload',
    fileName: '',
    fileSizeMb: undefined,
  }
}

/** 字段级错误：undefined 表示无错；首次提交前不展示。 */
export type DatabaseCreateFormErrors = {
  name?: string
  file?: string
}

const FILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/** 文件名去掉扩展名后就是数据库名（卡片与列表用它标识这个库）。 */
export function databaseNameFromFile(fileName: string): string {
  return fileName.replace(/\.(?:db|sqlite|sqlite3)$/i, '')
}

export function validateDatabaseCreateDraft(
  draft: DatabaseCreateDraft,
  existing: readonly DatabaseInstance[],
): DatabaseCreateFormErrors {
  const errors: DatabaseCreateFormErrors = {}

  const name = draft.name.trim()
  if (!name) errors.name = '请填写数据库名'
  else if (!FILE_NAME_PATTERN.test(name))
    errors.name = '文件名只能包含字母、数字、下划线、连字符与点，且以字母或数字开头'
  else if (existing.some((item) => item.engine === 'SQLite' && item.name === name))
    errors.name = '该引擎下已有同名数据库'

  if (draft.fileSource === 'upload' && !draft.fileName)
    errors.file = '请拖入或选择一个 .db 文件'

  return errors
}

export function hasDatabaseCreateErrors(errors: DatabaseCreateFormErrors): boolean {
  return Object.values(errors).some(Boolean)
}

export function toDatabaseCreateInput(draft: DatabaseCreateDraft): DatabaseCreateFileInput {
  return {
    kind: 'file',
    engine: 'SQLite',
    name: draft.name.trim(),
    origin: draft.fileSource === 'upload' ? 'uploaded' : 'created',
  }
}

/** 字节换 MB，保留一位小数（与卡片其余数值口径一致）。 */
export function bytesToMb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10
}

/** 演示密码生成：16 位大小写字母与数字，仅用于表单快捷填充（用户触发，不进确定性数据集）。 */
export function generateDemoPassword(length = 16): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
  let password = ''
  for (let i = 0; i < length; i += 1) {
    password += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return password
}
