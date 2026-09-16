import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRef } from 'react'
import { DATABASE_ENGINES } from '@elysian/contracts'
import type { DatabaseEngine } from '@elysian/contracts'
import { HeaderTabs } from '../../app/layout/HeaderTabs'
import type { HeaderTabItem } from '../../app/layout/HeaderTabs'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { Check, ChevronDown } from '../../components/icons'
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
 * 四项摊开较宽，因此形态按顶栏留给它的宽度决定：摆得下就四项摊开，摆不下就只显当前项、
 * 其余收进浮层菜单（宽度由外壳量出，见 app/layout/headerAccessoryWidth.ts）。不用视口断点——
 * 同一视口宽度下，侧边栏收展、内存数值位数都会改变可用宽度。摊开所需宽度由隐藏探针量出，
 * 探针与可见形态共用同一段渲染。
 *
 * 两种形态都常驻 DOM、只切显示，测量与查询因此都不受当前形态影响。
 * 菜单由本文件自绘，不用原生 select，因此不会呼出操作系统的下拉控件，键盘与取值都留在界面内。
 */
export function DatabaseEngineSwitch() {
  const engine = useDatabaseStore((s) => s.engine)
  const setEngine = useDatabaseStore((s) => s.setEngine)
  const probeRef = useRef<HTMLDivElement>(null)
  const availableWidth = useHeaderAccessoryWidth()
  const flatWidth = useIntrinsicWidth(probeRef)

  // 摊开宽度一时量不出来（首帧、测试环境）按 0 算，先摊开，量到后再收。
  const expanded = flatWidth <= availableWidth

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

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={`${
              expanded ? 'hidden' : 'inline-flex'
            } shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg`}
          >
            <span className="sr-only">数据库类型：</span>
            <span className="font-medium text-fg">{engine}</span>
            <ChevronDown aria-hidden size={13} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-32 rounded-lg border border-line bg-surface p-1 text-xs shadow-lg"
          >
            <DropdownMenu.RadioGroup
              value={engine}
              // Radix 以 string 回传值，取值集合由本文件的选项决定，在这里收窄回引擎联合类型。
              onValueChange={(value) => setEngine(value as DatabaseEngine)}
            >
              {DATABASE_ENGINES.map((item) => (
                <DropdownMenu.RadioItem
                  key={item}
                  value={item}
                  className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none text-fg-muted data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                >
                  {engine === item ? <Check aria-hidden size={13} /> : <span aria-hidden className="w-[13px]" />}
                  {item}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  )
}
