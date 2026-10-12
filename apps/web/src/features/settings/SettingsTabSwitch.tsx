import { useRef } from 'react'
import { HeaderTabs } from '../../app/layout/HeaderTabs'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { SelectDropdown } from '../../components/SelectDropdown'
import { SETTINGS_TABS, useSettingsTab } from './settingsTabs'

export function SettingsTabSwitch() {
  const { tab, setTab } = useSettingsTab()
  const probeRef = useRef<HTMLDivElement>(null)
  const expanded = useIntrinsicWidth(probeRef) <= useHeaderAccessoryWidth()
  return <>
    <div aria-hidden className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden">
      <div ref={probeRef} className="flex w-max"><HeaderTabs items={SETTINGS_TABS} value={tab} onSelect={setTab} groupLabel="设置页签" /></div>
    </div>
    <div className={expanded ? 'flex' : 'hidden'}><HeaderTabs items={SETTINGS_TABS} value={tab} onSelect={setTab} groupLabel="设置页签" /></div>
    <SelectDropdown ariaLabel="设置页签" align="end" items={SETTINGS_TABS} value={tab} onSelect={setTab} valueClassName="font-medium text-fg"
      triggerClassName={`${expanded ? 'hidden' : 'inline-flex'} shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg`} />
  </>
}
