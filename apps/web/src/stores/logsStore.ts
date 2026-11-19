import { createTabMemoryStore } from './tabMemoryStore'

/** 日志区页签取值。三类日志各占一页；容器内都读服务端落盘的真实日志，宿主机本地开发仍是演示。 */
export type LogsTab = 'runtime' | 'login' | 'operation'

/** 页签表：顶栏切换与页内内容共用，值保持英文标识符，中文文案只在这里维护。 */
export const LOGS_TABS: readonly { value: LogsTab; label: string }[] = [
  { value: 'runtime', label: '运行日志' },
  { value: 'login', label: '登录日志' },
  { value: 'operation', label: '操作日志' },
]

export const useLogsStore = createTabMemoryStore<LogsTab>('runtime')
