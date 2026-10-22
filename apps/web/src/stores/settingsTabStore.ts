import { create } from 'zustand'
import type { SettingsTab } from '../features/settings/settingsTabs'

/**
 * 设置页选中页签的会话内记忆：模块单例 store，不进 URL、不落任何持久化。
 * 页面未关闭时在设置页与其他页面之间往返保持上次页签；刷新或重新打开面板回到第一个页签「面板维护」。
 */
export const useSettingsTabStore = create<{
  tab: SettingsTab
  setTab: (tab: SettingsTab) => void
}>((set) => ({
  tab: 'maintenance',
  setTab: (tab) => set({ tab }),
}))
