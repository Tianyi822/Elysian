/*
 * 数据库域类型与词典。数据库由本机容器承载，因此实例只记来源容器的 id，
 * 容器名、镜像与运行时长由容器数据集提供；凭证只作演示，真实凭证不下发到浏览器。
 */

export type DatabaseEngine = 'MariaDB' | 'MongoDB' | 'MySQL' | 'PgSQL' | 'Redis' | 'SQLite'

export const DATABASE_ENGINES = [
  'MariaDB',
  'MongoDB',
  'MySQL',
  'PgSQL',
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
  /** 承载这个数据库的容器；卡片上的容器名、镜像与运行时长都按它现取。 */
  containerId: string
  /** 演示凭证：界面不显示值，只提供一键复制。 */
  credentials: DemoCredentials
  storage: { usedGb: number; totalGb: number }
  memory: { usedGb: number; totalGb: number }
  connections: { active: number; max: number }
  updatedAt: string
}
