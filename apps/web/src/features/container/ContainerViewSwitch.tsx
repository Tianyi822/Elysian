import { HeaderTabs } from '../../app/layout/HeaderTabs'
import { useGateway } from '../../adapters/GatewayProvider'
import type { HeaderTabItem } from '../../app/layout/HeaderTabs'
import { useContainersStore } from '../../stores/containersStore'

/** 容器区视图页签：值与 containers store 的 view 取值一致。 */
const VIEW_TABS: readonly HeaderTabItem<'grid' | 'images'>[] = [
  { value: 'grid', label: '容器' },
  { value: 'images', label: '镜像' },
]

/**
 * 容器/镜像视图切换。经路由 handle 挂进顶栏，占据原本的标题位（该页经 handle 声明藏掉可视标题），
 * 与页内内容共用同一 store，视图状态不进 URL。两项足够窄，任何顶栏宽度都摊得开，不需要窄屏下拉。
 */
export function ContainerViewSwitch() {
  const gateway = useGateway()
  const view = useContainersStore((s) => s.view)
  const setView = useContainersStore((s) => s.setView)
  const refreshImages = useContainersStore((s) => s.refreshImages)

  return <HeaderTabs items={VIEW_TABS} value={view} onSelect={(next) => {
    setView(next)
    if (next === 'images' && useContainersStore.getState().status === 'ready') void refreshImages(gateway)
  }} groupLabel="视图切换" />
}
