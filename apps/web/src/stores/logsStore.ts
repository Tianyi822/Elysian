import { create } from 'zustand'

/** 日志区页签取值。 */
export type LogsTab = 'runtime' | 'login'

/** 页签表：顶栏切换与页内内容共用，值保持英文标识符，中文文案只在这里维护。 */
export const LOGS_TABS: readonly { value: LogsTab; label: string }[] = [
  { value: 'runtime', label: '平台运行日志' },
  { value: 'login', label: '平台登录日志' },
]

/** 日志区页签状态：视图状态不进 URL，与安全区页签同一约定。 */
export const useLogsStore = create<{
  tab: LogsTab
  setTab: (tab: LogsTab) => void
}>((set) => ({
  tab: 'runtime',
  setTab: (tab) => set({ tab }),
}))
