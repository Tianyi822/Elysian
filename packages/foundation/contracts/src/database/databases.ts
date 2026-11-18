/*
 * 数据库域类型与词典。数据库页收敛为 Docker 容器管理后，数据分两类：
 * - 容器行（MariaDB、MySQL、Redis）：以 Docker 容器清单为事实源、按官方数据库镜像筛选，
 *   行主键就是容器 ID；连接地址、端口、网络与卷直接取 Docker inspect 事实，不补造；
 * - 文件行（SQLite）：就是一个本地数据库文件，没有容器、没有服务端账号与连接上限，
 *   实例记文件路径与大小。
 * 服务型数据库不再有逻辑库与 SQL 会话概念，容器操作只经 Docker Engine；
 * 面板创建容器时初始化的管理员凭据保存在服务端登记里，列表只带凭据状态，
 * 明文只在用户点击复制时经 reveal 端点按需读取；外部容器的凭据状态恒为未核验。
 * 引擎清单按需增长：暂未使用的引擎（MongoDB、PgSQL 等）等真正接入时再加回。
 */

import type { PortProtocol } from '../container/containers.ts'

export type DatabaseEngine = 'MariaDB' | 'MySQL' | 'Redis' | 'SQLite'

export const DATABASE_ENGINES = [
  'MariaDB',
  'MySQL',
  'Redis',
  'SQLite',
] as const satisfies readonly DatabaseEngine[]

/** 数据库容器行承载的三种服务引擎；SQLite 是文件行标记，不进容器页签。 */
export type DatabaseContainerEngine = Exclude<DatabaseEngine, 'SQLite'>

/** 容器页签词表：数据库页上部容器分区只按这三种引擎切换。 */
export const DATABASE_TAB_ENGINES = [
  'MariaDB',
  'MySQL',
  'Redis',
] as const satisfies readonly DatabaseContainerEngine[]

/**
 * SQLite 文件行的三值状态投影：非 active 行输出 warning。
 * 该词典只服务文件行。容器行使用 DatabaseContainerStatus。
 */
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

/** missing 表示容器已消失且面板仍有登记待清理。 */
export type DatabaseContainerStatus = 'running' | 'stopped' | 'missing'

export const DATABASE_CONTAINER_STATUSES = [
  'running',
  'stopped',
  'missing',
] as const satisfies readonly DatabaseContainerStatus[]

export const DATABASE_CONTAINER_STATUS_LABELS: Record<DatabaseContainerStatus, string> = {
  running: '运行中',
  stopped: '已停止',
  missing: '容器已不存在',
}

/** 面板推导的连接地址：面板网络 IPv4 + 引擎标准端口，any-host 呈现宿主直连地址。 */
export type DatabaseInstanceAddress = {
  host: string
  port: number
}

/**
 * 数据库容器行的端口映射：与容器域 PortMapping 同形，但宿主 IP 与宿主端口可缺省
 * （容器仅 EXPOSE 未发布时端口行没有宿主侧事实，界面不补造）。
 */
export type DatabasePortMapping = {
  containerPort: number
  hostPort?: number
  protocol: PortProtocol
  hostIp?: string
}

/**
 * 数据库容器行：以 Docker 容器为事实源的一行。
 * 字段声明序即响应 JSON 键序（冻结契约）：服务端 containerInstance 与本类型逐字对齐，
 * 双方都不得插键、改名或重排；memory 键位固定在 credentialsVerified 之后、needsAttention 之前。
 */
export type DatabaseContainerInstance = {
  /** 容器 ID：行主键。 */
  id: string
  engine: DatabaseContainerEngine
  /** 容器名。 */
  name: string
  /** 数据库版本（=versionTag）。 */
  version: string
  status: DatabaseContainerStatus
  /** 容器镜像的完整引用（Docker inspect 事实）。 */
  image: string
  /** 与 id 同值；保留以沿用页面既有 containerId 消费。 */
  containerId: string
  /** 登记来源；未登记容器缺省（含 Agent 容器工具创建的数据库镜像容器）。 */
  source?: 'managed' | 'adopted'
  /** 数据库版本标签；缺失时以 version 为准。 */
  versionTag?: string
  ports: readonly DatabasePortMapping[]
  /** 容器接入的网络名清单。 */
  networks: readonly string[]
  /** 面板创建容器时的专属持久卷；外部容器缺省。 */
  volumeName?: string
  /** 面板推导的连接地址；推导不出时缺省，界面不补造。 */
  address?: DatabaseInstanceAddress
  /** 登记聚合出的管理员用户名；未登记缺省。 */
  credentialUsername?: string
  /** 凭据是否来自面板登记；外部容器恒 false，界面标「未核验」。 */
  credentialsVerified: boolean
  /** 容器内存占用（Docker stats 事实）；读不到时缺省消隐，界面不补零。 */
  memory?: { usedGb: number; totalGb: number }
  /** 创建尚未核对完成（容器已产生、登记待核对）。 */
  needsAttention: boolean
  updatedAt: string
}

/**
 * SQLite 文件行：数据库就是一个本地 .db 文件，没有容器、没有账号、没有连接上限。
 * 状态沿用三值投影（非 active 行输出 warning）；指标采集失败保持空值，界面不得补造配额。
 */
export type DatabaseInstance = {
  id: string
  /** 'SQLite' 是文件行标记：与容器行构成按 engine 判别的联合。 */
  engine: 'SQLite'
  name: string
  version: string
  status: DatabaseStatus
  /** 文件的绝对路径。 */
  filePath?: string
  /** 文件大小（MB）。 */
  fileSizeMb?: number
  /** 文件里的表数量（worker probe 事实）。 */
  tableCount?: number
  /** 最近一次写入时间（ISO）。 */
  lastWrittenAt?: string
  updatedAt: string
  source?: 'managed' | 'adopted'
  metricsError?: string
  needsAttention?: boolean
}
