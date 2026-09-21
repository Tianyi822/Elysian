import { create } from 'zustand'
import { resolveViewTab, writeStoredViewTab } from '../app/theme/themePreferences'

/** 安全区页签取值。 */
export type SecurityTab = 'firewall' | 'ssh' | 'users'

/** 页签表：顶栏切换与页内内容共用，值保持英文标识符，中文文案只在这里维护。 */
export const SECURITY_TABS: readonly { value: SecurityTab; label: string }[] = [
  { value: 'firewall', label: '系统防火墙' },
  { value: 'ssh', label: 'SSH 管理' },
  { value: 'users', label: '用户管理' },
]

const SECURITY_TAB_VALUES = SECURITY_TABS.map(({ value }) => value)

/** 安全区页签状态：视图状态不进 URL，选中写入界面偏好，刷新后仍停在上次页签。 */
export const useSecurityStore = create<{
  tab: SecurityTab
  setTab: (tab: SecurityTab) => void
}>((set) => ({
  tab: resolveViewTab(window.localStorage, 'security', SECURITY_TAB_VALUES, 'firewall'),
  setTab: (tab) => {
    writeStoredViewTab(window.localStorage, 'security', tab)
    set({ tab })
  },
}))
