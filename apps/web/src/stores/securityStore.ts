import { create } from 'zustand'

/** 安全区页签取值。 */
export type SecurityTab = 'firewall' | 'ssh'

/** 页签表：顶栏切换与页内内容共用，值保持英文标识符，中文文案只在这里维护。 */
export const SECURITY_TABS: readonly { value: SecurityTab; label: string }[] = [
  { value: 'firewall', label: '系统防火墙' },
  { value: 'ssh', label: 'SSH 管理' },
]

/** 安全区页签状态：视图状态不进 URL，与容器/数据库切换同一约定。 */
export const useSecurityStore = create<{
  tab: SecurityTab
  setTab: (tab: SecurityTab) => void
}>((set) => ({
  tab: 'firewall',
  setTab: (tab) => set({ tab }),
}))
