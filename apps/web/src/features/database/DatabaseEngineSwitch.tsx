import { useRef } from 'react'
import { DATABASE_ENGINES } from '@elysian/contracts'
import type { DatabaseEngine } from '@elysian/contracts'
import { HeaderTabs } from '../../app/layout/HeaderTabs'
import type { HeaderTabItem } from '../../app/layout/HeaderTabs'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { useNarrowViewport } from '../../app/layout/narrowViewport'
import { SelectDropdown } from '../../components/SelectDropdown'
import { CTL_SELECT } from '../../components/formControl'
import { useDatabaseStore } from '../../stores/databaseStore'

/** 引擎页签表：值取契约的引擎枚举，文案直接用引擎名。 */
const ENGINE_TABS: readonly HeaderTabItem<DatabaseEngine>[] = DATABASE_ENGINES.map((engine) => ({
  value: engine,
  label: engine,
}))

/**
 * 数据库类型切换。经路由 handle 挂进顶栏，占据原本的标题位（该页经 handle 声明藏掉可视标题），
 * 选中态与页内共用同一个 store。摊开形态由 app/layout/HeaderTabs.tsx 提供。
 *
 * 两条线决定形态：视口窄于 768px（见 app/layout/narrowViewport.ts）一律只显当前项、其余收进浮层菜单；
 * 宽屏下再看顶栏留给它的宽度——四项摆放得下就平铺，摆不下同样收起（宽度由外壳量出，
 * 见 app/layout/headerAccessoryWidth.ts，不看视口是因为同一视口宽度下侧边栏收展、内存数值位数
 * 都会改变可用宽度）。摊开所需宽度由隐藏探针量出，探针与可见形态共用同一段渲染。
 *
 * 两种形态都常驻 DOM、只切显示，测量与查询因此都不受当前形态影响。
 * 收起后的菜单用 SelectDropdown，不用原生 select。
 */
export function DatabaseEngineSwitch() {
  const engine = useDatabaseStore((s) => s.engine)
  const setEngine = useDatabaseStore((s) => s.setEngine)
  const probeRef = useRef<HTMLDivElement>(null)
  const availableWidth = useHeaderAccessoryWidth()
  const flatWidth = useIntrinsicWidth(probeRef)
  const narrow = useNarrowViewport()

  // 窄屏不量宽度，直接收起；宽屏下摊开宽度一时量不出来（首帧、测试环境）按 0 算，先摊开，量到后再收。
  const expanded = !narrow && flatWidth <= availableWidth

  return (
    <>
      {/* 固有宽度探针：脱离布局，量出四项摊开需要多宽。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max">
          <HeaderTabs items={ENGINE_TABS} value={engine} onSelect={setEngine} groupLabel="数据库类型" />
        </div>
      </div>

      <div className={expanded ? 'flex' : 'hidden'}>
        <HeaderTabs items={ENGINE_TABS} value={engine} onSelect={setEngine} groupLabel="数据库类型" />
      </div>

      <SelectDropdown
        ariaLabel="数据库类型"
        align="end"
        items={ENGINE_TABS}
        value={engine}
        onSelect={setEngine}
        valueClassName="font-medium text-fg"
        triggerClassName={`${CTL_SELECT} ${expanded ? 'hidden' : 'inline-flex'}`}
        contentClassName="header-select-menu"
      />
    </>
  )
}
