import { useSearchParams } from 'react-router'

export const SETTINGS_TABS = [
  { value: 'maintenance', label: '面板维护' },
  { value: 'account', label: '账号安全' },
  { value: 'models', label: '模型配置' },
] as const
export type SettingsTab = (typeof SETTINGS_TABS)[number]['value']

export function useSettingsTab() {
  const [params, setParams] = useSearchParams()
  const selected = params.get('tab')
  const tab: SettingsTab = SETTINGS_TABS.some((item) => item.value === selected)
    ? selected as SettingsTab : params.has('maintenanceTask') ? 'maintenance' : 'models'
  const setTab = (next: SettingsTab) => setParams((current) => {
    const updated = new URLSearchParams(current)
    updated.set('tab', next)
    return updated
  }, { replace: true })
  return { tab, setTab }
}
