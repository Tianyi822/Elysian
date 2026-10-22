import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router'
import { useSettingsTabStore } from '../../stores/settingsTabStore'

export const SETTINGS_TABS = [
  { value: 'maintenance', label: '面板维护' },
  { value: 'account', label: '账号安全' },
  { value: 'models', label: '模型配置' },
  { value: 'mcp', label: 'MCP 配置' },
  { value: 'skills', label: 'Skill 配置' },
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]['value']

/**
 * 设置页选中页签：默认第一个，页面未关闭时记住上次选择。
 * `?tab=` 只作为一次性深链入口（旧模型配置入口的跳转等）：落地后记进会话记忆并从地址摘除，
 * 刷新与再次进入都回落记忆，无记忆时回到第一个页签。
 */
export function useSettingsTab() {
  const [params, setParams] = useSearchParams()
  const tab = useSettingsTabStore((state) => state.tab)
  const setTab = useSettingsTabStore((state) => state.setTab)
  const consumedMaintenanceEntry = useRef(false)

  useEffect(() => {
    const selected = params.get('tab')
    if (!SETTINGS_TABS.some((item) => item.value === selected)) return
    useSettingsTabStore.getState().setTab(selected as SettingsTab)
    setParams((current) => {
      if (!current.has('tab')) return current
      const updated = new URLSearchParams(current)
      updated.delete('tab')
      return updated
    }, { replace: true })
  }, [params, setParams])

  useEffect(() => {
    // 维护回跳只在落地那一刻指一次面板维护；之后用户切走的页签不被它反复拉回。
    if (consumedMaintenanceEntry.current) return
    consumedMaintenanceEntry.current = true
    if (params.has('maintenanceTask')) useSettingsTabStore.getState().setTab('maintenance')
  }, [params])

  return { tab, setTab }
}
