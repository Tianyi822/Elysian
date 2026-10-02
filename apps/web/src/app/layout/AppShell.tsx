import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Menu, PanelLeftClose, PanelLeftOpen } from '../../components/icons'
import { Outlet, useLocation, useMatches } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { SystemLoadBadge } from '../../components/SystemLoadBadge'
import { IconButton } from '../../components/IconButton'
import { NotificationHost } from '../../components/NotificationHost'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { NAV_ITEMS } from '../navigation'
import type { RouteHandle } from '../router'
import {
  HeaderAccessoryWidthContext,
  useHeaderAccessoryWidthMeasurement,
} from './headerAccessoryWidth'
import { Sidebar } from './Sidebar'

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const headerRowRef = useRef<HTMLDivElement>(null)
  const headerTitleRef = useRef<HTMLHeadingElement>(null)
  const headerActionsRef = useRef<HTMLDivElement>(null)
  const gateway = useGateway()
  const location = useLocation()
  const matches = useMatches()
  const connectEventStream = useEventStreamStore((state) => state.connect)

  // 顶栏标题跟随当前导航项；未匹配路由沿用仪表盘缺省，由未找到页面给出自己的标题。
  // 页签式标题的页面（安全、Docker、数据库）经路由 handle 声明藏掉可视标题，页签占据标题位。
  // 全屏型页面（终端）经 handle 声明整条顶栏都不渲染。
  const hideHeader = matches.some((match) => (match.handle as RouteHandle | undefined)?.hideHeader)
  const flushMain = matches.some((match) => (match.handle as RouteHandle | undefined)?.flushMain)
  const hideHeaderTitle = matches.some(
    (match) => (match.handle as RouteHandle | undefined)?.hideHeaderTitle,
  )
  const pageTitle =
    NAV_ITEMS.find((item) =>
      item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
    )?.label ?? '仪表盘'

  const HeaderAccessory = matches
    .map((match) => (match.handle as RouteHandle | undefined)?.headerAccessory)
    .find((accessory) => accessory !== undefined)

  const accessoryWidth = useHeaderAccessoryWidthMeasurement({
    row: headerRowRef,
    title: headerTitleRef,
    actions: headerActionsRef,
    titleText: pageTitle,
  })

  // 整个应用只订阅一次事件流，避免每个页面各开一条连接。
  useEffect(() => {
    connectEventStream(gateway.events)
    return () => {
      useEventStreamStore.getState().disconnect()
    }
  }, [gateway, connectEventStream])

  return (
    <div className="flex h-dvh bg-bg text-fg">
      <aside
        className={`hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200 md:flex ${
          sidebarCollapsed ? 'w-16' : 'w-64'
        }`}
      >
        {/* 与顶栏同构：边框挂父级、内容行 min-h-14 在内层，总高一致不错位。 */}
        <div className="border-b border-line">
          <div className="flex min-h-14 items-center justify-between px-3">
            <span className={sidebarCollapsed ? 'sr-only' : 'text-base font-semibold tracking-tight'}>
              Elysian
            </span>
            <button
              type="button"
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
              aria-label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              title={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
              className="ml-auto inline-flex size-9 items-center justify-center rounded-lg text-fg-muted hover:bg-surface-raised hover:text-fg"
            >
              {sidebarCollapsed ? <PanelLeftOpen aria-hidden size={17} /> : <PanelLeftClose aria-hidden size={17} />}
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <Sidebar collapsed={sidebarCollapsed} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          {/* 全屏型页面（终端）整条顶栏都不渲染；窄屏下仍需一条回到主导航的路，
              抽屉触发器因此浮在左上角，等终端界面自带导航后再随设计收敛。 */}
          {hideHeader ? (
            <Dialog.Trigger asChild>
              <span className="fixed left-3 top-3 z-30 md:hidden">
                <IconButton label="打开主导航">
                  <Menu aria-hidden size={16} />
                </IconButton>
              </span>
            </Dialog.Trigger>
          ) : (
            <header className="shrink-0 border-b border-line bg-surface">
              <div ref={headerRowRef} className="flex min-h-14 items-center gap-4 px-4 py-3 md:px-6">
                <Dialog.Trigger asChild>
                  <span className="md:hidden">
                    <IconButton label="打开主导航">
                      <Menu aria-hidden size={16} />
                    </IconButton>
                  </span>
                </Dialog.Trigger>

                {hideHeaderTitle ? null : (
                  <div className="min-w-0">
                    <h1 ref={headerTitleRef} className="truncate text-base font-semibold leading-tight">
                      {pageTitle}
                    </h1>
                  </div>
                )}

                <HeaderAccessoryWidthContext.Provider value={accessoryWidth}>
                  {HeaderAccessory ? <HeaderAccessory /> : null}
                </HeaderAccessoryWidthContext.Provider>

                <div
                  ref={headerActionsRef}
                  className="ml-auto flex shrink-0 flex-nowrap items-center justify-end gap-2"
                >
                  <SystemLoadBadge />
                </div>
              </div>
            </header>
          )}

          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 motion-reduce:animate-none data-[state=open]:animate-drawer-overlay-in data-[state=closed]:animate-drawer-overlay-out" />
            <Dialog.Content
              aria-describedby={undefined}
              className="fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-line bg-surface shadow-xl will-change-transform motion-reduce:animate-none data-[state=open]:animate-drawer-panel-in data-[state=closed]:animate-drawer-panel-out"
            >
              {/* 与顶栏同构：边框挂父级、内容行 min-h-14 在内层。 */}
              <div className="border-b border-line">
                <div className="flex min-h-14 items-center justify-between px-3">
                  <Dialog.Title className="text-base font-medium">主导航</Dialog.Title>
                  <Dialog.Close asChild>
                    <span>
                      {/* 标题「主导航」已在旁边，悬停提示反而跟随焦点常驻，视觉提示关掉。 */}
                      <IconButton label="关闭主导航" tooltip={false}>
                        {/* 抽屉向左收起，用面板折叠图标比 X 更贴合动作语义。 */}
                        <PanelLeftClose aria-hidden size={16} />
                      </IconButton>
                    </span>
                  </Dialog.Close>
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <Sidebar onNavigate={() => setDrawerOpen(false)} />
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <div className="relative flex min-h-0 flex-1">
          <main
            className={
              flushMain
                ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
                : 'min-w-0 flex-1 overflow-y-auto p-4 md:p-6'
            }
          >
            <Outlet />
          </main>
          <NotificationHost />
        </div>
      </div>
    </div>
  )
}
