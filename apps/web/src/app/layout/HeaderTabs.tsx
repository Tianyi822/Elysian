import { PillNavigation } from '../../components/easyui/PillNavigation'

export type HeaderTabItem<T extends string> = { value: T; label: string }

/** 顶栏页签共用 EasyUI 胶囊导航，原受控值与窄屏收纳由各页面持有。 */
export function HeaderTabs<T extends string>({ items, value, onSelect, groupLabel }: {
  items: readonly HeaderTabItem<T>[]
  value: T
  onSelect: (value: T) => void
  groupLabel: string
}) {
  return <PillNavigation
    items={items.map(item => ({ id: item.value, label: item.label }))}
    value={value}
    onChange={id => { const item = items.find(candidate => candidate.value === id); if (item) onSelect(item.value) }}
    ariaLabel={groupLabel}
    className="header-tabs max-w-full"
  />
}
