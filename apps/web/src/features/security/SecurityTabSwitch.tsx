import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useRef } from 'react'
import { HeaderTabs } from '../../app/layout/HeaderTabs'
import { useHeaderAccessoryWidth, useIntrinsicWidth } from '../../app/layout/headerAccessoryWidth'
import { Check, ChevronDown } from '../../components/icons'
import { SECURITY_TABS, useSecurityStore } from '../../stores/securityStore'
import type { SecurityTab } from '../../stores/securityStore'

/**
 * 安全区页签切换。经路由 handle 挂进顶栏，占据原本的标题位（该页经 handle 声明藏掉可视标题），
 * 选中态与页内共用 security store。摊开形态由 app/layout/HeaderTabs.tsx 提供。
 *
 * 形态按顶栏留给它的宽度决定：摆得下就三项摊开，摆不下就只显当前项、其余收进浮层菜单
 * （宽度由外壳量出，见 app/layout/headerAccessoryWidth.ts）。不用视口断点——同一视口宽度下，
 * 侧边栏收展、内存数值位数都会改变可用宽度。摊开所需宽度由隐藏探针量出，探针与可见形态共用同一段渲染。
 *
 * 两种形态都常驻 DOM、只切显示，测量与查询因此都不受当前形态影响。
 * 菜单由本文件自绘，不用原生 select，因此不会呼出操作系统的下拉控件，键盘与取值都留在界面内。
 * 浮层不锁页面滚动：默认的模态锁会按滚动条宽度给 body 加 margin，窄屏上会把整页挤窄。
 */
export function SecurityTabSwitch() {
  const tab = useSecurityStore((s) => s.tab)
  const setTab = useSecurityStore((s) => s.setTab)
  const probeRef = useRef<HTMLDivElement>(null)
  const availableWidth = useHeaderAccessoryWidth()
  const flatWidth = useIntrinsicWidth(probeRef)

  // 摊开宽度一时量不出来（首帧、测试环境）按 0 算，先摊开，量到后再收。
  const expanded = flatWidth <= availableWidth

  return (
    <>
      {/* 固有宽度探针：脱离布局，量出三项摊开需要多宽。 */}
      <div
        aria-hidden
        className="pointer-events-none invisible absolute top-0 left-0 overflow-hidden"
      >
        <div ref={probeRef} className="flex w-max">
          <HeaderTabs items={SECURITY_TABS} value={tab} onSelect={setTab} groupLabel="安全页签" />
        </div>
      </div>

      <div className={expanded ? 'flex' : 'hidden'}>
        <HeaderTabs items={SECURITY_TABS} value={tab} onSelect={setTab} groupLabel="安全页签" />
      </div>

      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={`${
              expanded ? 'hidden' : 'inline-flex'
            } shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg`}
          >
            <span className="sr-only">安全页签：</span>
            <span className="font-medium text-fg">{labelOf(tab)}</span>
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
              value={tab}
              // Radix 以 string 回传值，取值集合由本文件的选项决定，在这里收窄回页签联合类型。
              onValueChange={(value) => setTab(value as SecurityTab)}
            >
              {SECURITY_TABS.map(({ value, label }) => (
                <DropdownMenu.RadioItem
                  key={value}
                  value={value}
                  className="flex cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none text-fg-muted data-[highlighted]:bg-surface-raised data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg"
                >
                  {tab === value ? <Check aria-hidden size={13} /> : <span aria-hidden className="w-[13px]" />}
                  {label}
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </>
  )
}

function labelOf(tab: SecurityTab): string {
  return SECURITY_TABS.find(({ value }) => value === tab)?.label ?? tab
}
