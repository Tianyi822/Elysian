import { create } from 'zustand'

/** 安全区页签取值。 */
export type SecurityTab = 'firewall' | 'ssh' | 'users'

/** 页签表：顶栏切换与页内内容共用，值保持英文标识符，中文文案只在这里维护。 */
export const SECURITY_TABS: readonly { value: SecurityTab; label: string }[] = [
  { value: 'firewall', label: '系统防火墙' },
  { value: 'ssh', label: 'SSH 管理' },
  { value: 'users', label: '用户管理' },
]

/** 安全区页签状态：视图状态不进 URL、不写界面偏好——store 是模块单例，页面未关闭时记住上次页签，重新打开面板回到第一个。 */
export const useSecurityStore = create<{
  tab: SecurityTab
  setTab: (tab: SecurityTab) => void
}>((set) => ({
  tab: 'firewall',
  setTab: (tab) => set({ tab }),
}))
