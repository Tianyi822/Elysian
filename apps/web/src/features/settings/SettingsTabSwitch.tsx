import { useRef } from 'react'
import { HeaderTabs } from '../../app/layout/HeaderTabs'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { useNarrowViewport } from '../../app/layout/narrowViewport'
import { SelectDropdown } from '../../components/SelectDropdown'
import { CTL_SELECT } from '../../components/formControl'
import { SETTINGS_TABS, useSettingsTab } from './settingsTabs'

/**
 * 设置区页签切换。窄屏（<768px）一律收进浮层菜单，宽屏按顶栏留给它的宽度决定摊开与否，
 * 与安全、日志等页签同一套机制（见 app/layout/narrowViewport.ts 与 headerAccessoryWidth.ts）。
 */
export function SettingsTabSwitch() {
  const { tab, setTab } = useSettingsTab()
  const probeRef = useRef<HTMLDivElement>(null)
  const narrow = useNarrowViewport()
  const flatWidth = useIntrinsicWidth(probeRef)
  const availableWidth = useHeaderAccessoryWidth()
  const expanded = !narrow && flatWidth <= availableWidth
  return <>
    <div aria-hidden className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden">
      <div ref={probeRef} className="flex w-max"><HeaderTabs items={SETTINGS_TABS} value={tab} onSelect={setTab} groupLabel="设置页签" /></div>
    </div>
    <div className={expanded ? 'flex' : 'hidden'}><HeaderTabs items={SETTINGS_TABS} value={tab} onSelect={setTab} groupLabel="设置页签" /></div>
    <SelectDropdown ariaLabel="设置页签" align="end" items={SETTINGS_TABS} value={tab} onSelect={setTab} valueClassName="font-medium text-fg"
      triggerClassName={`${CTL_SELECT} ${expanded ? 'hidden' : 'inline-flex'}`} contentClassName="select-menu" />
  </>
}
