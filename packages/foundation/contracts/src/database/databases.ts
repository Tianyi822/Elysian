/*
 * 数据库域类型与词典。数据库分两类来源：
 * - 服务型（MariaDB、MySQL、Redis）：由本机容器承载，实例只记来源容器的 id，容器名与镜像由容器数据集提供；
 * - 文件型（SQLite）：就是一个本地数据库文件，没有容器、没有服务端账号与连接上限，实例记文件路径与大小。
 * Docker 运行时服务型与 SQLite 均有真实实现，本地开发保留演示适配层。真实凭证不随列表下发到浏览器。引擎清单按需增长：暂未使用的引擎（MongoDB、PgSQL 等）等真正接入时再加回。
 */

export type DatabaseEngine = 'MariaDB' | 'MySQL' | 'Redis' | 'SQLite'

export const DATABASE_ENGINES = [
  'MariaDB',
  'MySQL',
  'Redis',
  'SQLite',
] as const satisfies readonly DatabaseEngine[]

export type DatabaseStatus = 'running' | 'warning' | 'stopped'

export const DATABASE_STATUSES = [
  'running',
  'warning',
  'stopped',
] as const satisfies readonly DatabaseStatus[]

export const DATABASE_STATUS_LABELS: Record<DatabaseStatus, string> = {
  running: '运行中',
  warning: '连接偏高',
  stopped: '已停止',
}

/** 演示凭证：只存在于 mock 数据集与演示界面，真实凭证由服务端持有、不下发到浏览器。 */
export type DemoCredentials = {
  username: string
  password: string
}

export type DatabaseInstance = {
  id: string
  engine: DatabaseEngine
  name: string
  version: string
  status: DatabaseStatus
  /** 承载这个数据库的容器；文件型数据库（SQLite）没有容器，此处缺省。 */
  containerId?: string
  /** 文件型数据库的绝对路径；服务型数据库没有文件，此处缺省。 */
  filePath?: string
  /** 文件型数据库的大小（MB）。 */
  fileSizeMb?: number
  /** 文件里的表数量（SQLite 由 sqlite_master 计数得出）。 */
  tableCount?: number
  /** 最近一次写入时间（ISO）。 */
  lastWrittenAt?: string
  /** 演示凭证：界面不显示值，只提供一键复制；SQLite 没有账号体系，此处缺省。 */
  credentials?: DemoCredentials
  storage?: { usedGb: number; totalGb: number }
  memory?: { usedGb: number; totalGb: number }
  /** 连接使用情况；SQLite 是嵌入式数据库，没有服务端连接上限，此处缺省。 */
  connections?: { active: number; max: number }
  updatedAt: string
  /** 真实实例不在列表响应中携带密码；凭证只在用户点击复制时按需读取。 */
  credentialUsername?: string
  hasCredentials?: boolean
  source?: 'managed' | 'adopted' | 'demo'
  versionTag?: string
  accessScope?: 'localhost' | 'container-network' | 'any-host'
  /** 持久卷仅属于面板创建的服务容器。 */
  volumeName?: string
  /** 采集失败时保持空值，界面不得补造配额。 */
  metricsError?: string
  needsAttention?: boolean
  emptyContainer?: boolean
}

/** 文件型数据库（没有容器、没有账号、没有连接上限）。 */
export function isFileBacked(database: DatabaseInstance): boolean {
  return database.filePath !== undefined
}
