import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRef } from 'react'
import { DATABASE_ENGINES } from '@elysian/contracts'
import type { DatabaseEngine } from '@elysian/contracts'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { Check, ChevronDown } from '../../components/icons'
import { useDatabaseStore } from '../../stores/databaseStore'

/**
 * 数据库类型切换。经路由 handle 挂进顶栏标题旁，与容器/镜像切换同一套分段控件形状，
 * 选中态与页内共用同一个 store。
 *
 * 六项平铺约 404px，因此形态按顶栏留给它的宽度决定：摆得下就六项摊开，
 * 摆不下就只显当前项、其余收进浮层菜单（宽度由外壳量出，见 app/layout/headerAccessoryWidth.ts）。
 * 不用视口断点——同一视口宽度下，侧边栏收展、标题长短、内存数值位数都会改变可用宽度。
 * 摊开所需宽度由隐藏探针量出，探针与可见形态共用同一段渲染。
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
      {/* 固有宽度探针：脱离布局，量出六项摊开需要多宽。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max">
          <EngineSegments engine={engine} onSelect={setEngine} />
        </div>
      </div>

      <div className={expanded ? 'flex' : 'hidden'}>
        <EngineSegments engine={engine} onSelect={setEngine} />
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

/** 六项平铺的分段控件。探针与可见形态都渲染它，探针量到的宽度即摊开所需宽度。 */
function EngineSegments({
  engine,
  onSelect,
}: {
  engine: DatabaseEngine
  onSelect: (engine: DatabaseEngine) => void
}) {
  return (
    <div
      role="group"
      aria-label="数据库类型"
      className="inline-flex overflow-hidden rounded-lg border border-line"
    >
      {DATABASE_ENGINES.map((item, index) => (
        <button
          key={item}
          type="button"
          aria-pressed={engine === item}
          onClick={() => onSelect(item)}
          className={`whitespace-nowrap px-2 py-1.5 text-xs transition-colors sm:px-3 ${
            index > 0 ? 'border-l border-line' : ''
          } ${
            engine === item
              ? 'bg-surface-raised font-medium text-fg'
              : 'text-fg-muted hover:bg-surface-raised hover:text-fg'
          }`}
        >
          {item}
        </button>
      ))}
    </div>
  )
}
