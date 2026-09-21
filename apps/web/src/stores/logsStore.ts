import { create } from 'zustand'
import { resolveViewTab, writeStoredViewTab } from '../app/theme/themePreferences'

/** 日志区页签取值。 */
export type LogsTab = 'runtime' | 'login'

/** 页签表：顶栏切换与页内内容共用，值保持英文标识符，中文文案只在这里维护。 */
export const LOGS_TABS: readonly { value: LogsTab; label: string }[] = [
  { value: 'runtime', label: '运行日志' },
  { value: 'login', label: '登录日志' },
]

const LOGS_TAB_VALUES = LOGS_TABS.map(({ value }) => value)

/** 日志区页签状态：视图状态不进 URL，选中写入界面偏好，刷新后仍停在上次页签。 */
export const useLogsStore = create<{
  tab: LogsTab
  setTab: (tab: LogsTab) => void
}>((set) => ({
  tab: resolveViewTab(window.localStorage, 'logs', LOGS_TAB_VALUES, 'runtime'),
  setTab: (tab) => {
    writeStoredViewTab(window.localStorage, 'logs', tab)
    set({ tab })
  },
}))
