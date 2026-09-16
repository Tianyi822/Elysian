import type { Container, ContainerImage, DatabaseEngine, DatabaseInstance } from '@elysian/contracts'
import type { DatabaseCreateInput } from '../../contracts/adapters'

/**
 * 添加数据库表单的草稿与校验：纯函数、无 React 依赖。
 *
 * 表单按引擎分岔：
 * - 服务型（MariaDB、MySQL、Redis）：名称与字符集、账号密码、访问权限、承载容器；
 * - 文件型（SQLite）：数据库就是一个 .db 文件，没有容器也没有账号，
 *   来源三选一——拖拽上传、选择本地文件（两者都是拿到一个既有文件）、直接在本机新建。
 */

export type DatabaseAccessScope = 'localhost' | 'container-network' | 'any-host'

export const DATABASE_ACCESS_SCOPES = [
  'localhost',
  'container-network',
  'any-host',
] as const satisfies readonly DatabaseAccessScope[]

export const DATABASE_ACCESS_SCOPE_LABELS: Record<DatabaseAccessScope, string> = {
  localhost: '仅本机',
  'container-network': '容器网络内',
  'any-host': '任意主机',
}

/** 字符集候选；只对 SQL 引擎展示，其余引擎不收集该字段。 */
export const DATABASE_CHARSET_OPTIONS = ['utf8mb4', 'utf8mb3', 'latin1', 'ascii'] as const

/** 文件型数据库的落点目录（演示值；真实实现由服务端决定）。 */
export const SQLITE_DATA_DIR = '/srv/elysian/data/sqlite'

/** SQLite 库文件的扩展名。 */
export const SQLITE_FILE_SUFFIX = '.db'

/**
 * 文件来源：
 * - `upload`：拖拽或选择本地文件，二者对表单等价，都是得到一个既有文件；
 * - `create`：直接在本机新建一个空库，填写目录与文件名。
 */
export type SqliteFileSource = 'upload' | 'create'

export const SQLITE_FILE_SOURCES = ['upload', 'create'] as const satisfies readonly SqliteFileSource[]

export const SQLITE_FILE_SOURCE_LABELS: Record<SqliteFileSource, string> = {
  upload: '拖拽或选择本地文件',
  create: '直接在本机新建',
}

export type DatabaseCreateDraft = {
  name: string
  charset: string
  username: string
  password: string
  accessScope: DatabaseAccessScope
  containerId: string
  /** 文件型：来源。 */
  fileSource: SqliteFileSource
  /** 文件型：上传/选择的文件名（含扩展名）。 */
  fileName: string
  /** 文件型：上传/选择的文件大小（MB）。 */
  fileSizeMb?: number
  /** 文件型：直接新建时的落点目录。 */
  directory: string
}

export function emptyDraft(engine: DatabaseEngine): DatabaseCreateDraft {
  const isSql = engine === 'MariaDB' || engine === 'MySQL'
  return {
    name: '',
    charset: isSql ? 'utf8mb4' : '',
    username: '',
    password: '',
    accessScope: 'localhost',
    containerId: '',
    fileSource: 'upload',
    fileName: '',
    fileSizeMb: undefined,
    directory: SQLITE_DATA_DIR,
  }
}

/** 字段级错误：undefined 表示无错；首次提交前不展示。 */
export type DatabaseCreateFormErrors = {
  name?: string
  username?: string
  password?: string
  containerId?: string
  file?: string
  directory?: string
}

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/
const FILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

/** 文件型数据库的落点路径：新建时文件名取自数据库名，上传时取所选文件名。 */
export function sqliteFilePath(draft: DatabaseCreateDraft): string {
  const raw = (draft.fileSource === 'create' ? draft.name.trim() : draft.fileName).trim()
  const fileName = raw.endsWith(SQLITE_FILE_SUFFIX) ? raw : `${raw}${SQLITE_FILE_SUFFIX}`
  return `${draft.directory.replace(/\/+$/, '')}/${fileName}`
}

/** 文件名去掉扩展名后就是数据库名（卡片与列表用它标识这个库）。 */
export function databaseNameFromFile(fileName: string): string {
  return fileName.replace(/\.db$/i, '')
}

export function validateDatabaseCreateDraft(
  draft: DatabaseCreateDraft,
  existing: readonly DatabaseInstance[],
  engine: DatabaseEngine,
): DatabaseCreateFormErrors {
  const errors: DatabaseCreateFormErrors = {}

  const name = draft.name.trim()
  if (!name) errors.name = '请填写数据库名'
  else if (engine === 'SQLite' && !FILE_NAME_PATTERN.test(name))
    errors.name = '文件名只能包含字母、数字、下划线、连字符与点，且以字母或数字开头'
  else if (engine !== 'SQLite' && !NAME_PATTERN.test(name))
    errors.name = '只能包含字母、数字、下划线与连字符，且以字母或数字开头'
  else if (existing.some((item) => item.engine === engine && item.name === name))
    errors.name = '该引擎下已有同名数据库'

  if (engine === 'SQLite') {
    if (draft.fileSource === 'upload') {
      if (!draft.fileName) errors.file = '请拖入或选择一个 .db 文件'
    } else {
      if (!draft.directory.trim()) errors.directory = '请填写落点目录'
      else if (!draft.directory.trim().startsWith('/'))
        errors.directory = '请填写绝对路径（以 / 开头）'
    }
    return errors
  }

  if (!draft.username.trim()) errors.username = '请填写用户名'
  if (!draft.password) errors.password = '请填写密码'
  if (!draft.containerId) errors.containerId = '请选择承载容器'

  return errors
}

export function hasDatabaseCreateErrors(errors: DatabaseCreateFormErrors): boolean {
  return Object.values(errors).some(Boolean)
}

export function toDatabaseCreateInput(
  draft: DatabaseCreateDraft,
  engine: DatabaseEngine,
): DatabaseCreateInput {
  if (engine === 'SQLite') {
    const source = draft.fileSource === 'upload' ? 'uploaded' : 'created'
    return {
      kind: 'file',
      engine,
      name: draft.name.trim(),
      filePath: sqliteFilePath(draft),
      // 上传的文件用真实大小；新建的空库是 0 字节（SQLite 建表前就是空文件）。
      fileSizeMb: draft.fileSource === 'upload' ? (draft.fileSizeMb ?? 0) : 0,
      origin: source,
    }
  }

  return {
    kind: 'container',
    engine,
    name: draft.name.trim(),
    charset: engine === 'MariaDB' || engine === 'MySQL' ? draft.charset : undefined,
    username: draft.username.trim(),
    password: draft.password,
    accessScope: draft.accessScope,
    containerId: draft.containerId,
  }
}

/** 引擎与镜像名的对应关系：只把运行中、且镜像名匹配该引擎家族的容器列为承载候选。 */
const ENGINE_IMAGE_PREFIX: Partial<Record<DatabaseEngine, string>> = {
  MariaDB: 'mariadb',
  MySQL: 'mysql',
  Redis: 'redis',
}

export function containersForEngine(
  engine: DatabaseEngine,
  containers: readonly Container[],
  images: readonly ContainerImage[],
): Container[] {
  const prefix = ENGINE_IMAGE_PREFIX[engine]
  if (!prefix) return []
  const imageNameById = new Map(images.map((image) => [image.id, image.name]))
  return containers.filter(
    (container) =>
      container.status === 'running' && imageNameById.get(container.imageId)?.startsWith(prefix),
  )
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
