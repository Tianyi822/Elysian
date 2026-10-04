import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Menu, PanelLeftClose, PanelLeftOpen } from '../../components/icons'
import { Outlet, useLocation, useMatches } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
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
  const headerActionsRef = useRef<HTMLSpanElement>(null)
  const gateway = useGateway()
  const location = useLocation()
  const matches = useMatches()
  const connectEventStream = useEventStreamStore((state) => state.connect)

  // 页面名称由导航呈现，读屏仍保留一级标题；业务页签与路径放在页面内容区。
  // 全屏终端只保留窄屏导航触发器。
  const hideHeader = matches.some((match) => (match.handle as RouteHandle | undefined)?.hideHeader)
  const flushMain = matches.some((match) => (match.handle as RouteHandle | undefined)?.flushMain)
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
    <div className="app-canvas flex h-dvh overflow-hidden text-fg">
      <aside
        aria-label="桌面主导航"
        className={`glass-navigation hidden shrink-0 flex-col transition-[width] duration-200 motion-reduce:transition-none md:flex ${
          sidebarCollapsed ? 'w-16' : 'w-60'
        }`}
      >
        {/* 品牌区与收展入口固定在导航顶部；导航与内容之间不再画分割线。
            字标左缘取 24px，与下方图标（导航 p-3 + 链接 px-3）对齐；收起后字标不显，改回等距。 */}
        <div className={`flex h-[var(--shell-header-height)] items-center justify-between pr-3 ${sidebarCollapsed ? 'pl-3' : 'pl-6'}`}>
          <span className={sidebarCollapsed ? 'sr-only' : 'brand-wordmark'}>
            Elysian
          </span>
          <IconButton
            onPress={() => setSidebarCollapsed((collapsed) => !collapsed)}
            label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
            variant="ghost"
            className="ml-auto size-9 rounded-lg text-nav-muted hover:bg-nav-hover hover:text-nav-fg"
          >
            {sidebarCollapsed ? <PanelLeftOpen aria-hidden size={17} /> : <PanelLeftClose aria-hidden size={17} />}
          </IconButton>
        </div>
        <div className="min-h-0 flex-1">
          <Sidebar collapsed={sidebarCollapsed} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          {hideHeader && (
            <Dialog.Trigger asChild>
              <span ref={headerActionsRef} className="fixed left-3 top-3 z-30 md:hidden">
                <IconButton label="打开主导航">
                  <Menu aria-hidden size={16} />
                </IconButton>
              </span>
            </Dialog.Trigger>
          )}

          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 z-40 bg-overlay motion-reduce:animate-none data-[state=open]:animate-drawer-overlay-in data-[state=closed]:animate-drawer-overlay-out" />
            <Dialog.Content
              aria-describedby={undefined}
              onCloseAutoFocus={(event) => {
                // Trigger 的包裹元素用于宽度测量，焦点归还给里面真正可操作的按钮。
                event.preventDefault()
                headerActionsRef.current?.querySelector('button')?.focus()
              }}
              className="glass-navigation fixed inset-y-0 left-0 z-50 flex w-[min(18rem,calc(100vw-2rem))] flex-col shadow-xl will-change-transform motion-reduce:animate-none data-[state=open]:animate-drawer-panel-in data-[state=closed]:animate-drawer-panel-out"
            >
              {/* 抽屉与桌面导航共用品牌区高度，标题左缘同样对齐下方图标。 */}
              <div className="flex h-[var(--shell-header-height)] items-center justify-between pl-6 pr-3">
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
              <div className="min-h-0 flex-1">
                <Sidebar onNavigate={() => setDrawerOpen(false)} />
              </div>
            </Dialog.Content>
          </Dialog.Portal>

          <div className="relative flex min-h-0 flex-1">
            <main
              className={
                flushMain
                  ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
                  : 'min-w-0 flex-1 overflow-y-auto p-4 md:p-6'
              }
            >
              <h1 className="sr-only">{pageTitle}</h1>
              {!hideHeader && (
                <div
                  ref={headerRowRef}
                  className={`mb-4 flex min-w-0 items-center gap-3 ${HeaderAccessory ? '' : 'md:hidden'}`}
                >
                  <Dialog.Trigger asChild>
                    <span ref={headerActionsRef} className="shrink-0 md:hidden">
                      <IconButton label="打开主导航" className="size-10">
                        <Menu aria-hidden size={18} />
                      </IconButton>
                    </span>
                  </Dialog.Trigger>
                  <HeaderAccessoryWidthContext.Provider value={accessoryWidth}>
                    {HeaderAccessory ? <HeaderAccessory /> : null}
                  </HeaderAccessoryWidthContext.Provider>
                </div>
              )}
              <Outlet />
            </main>
            <NotificationHost />
          </div>
        </Dialog.Root>
      </div>
    </div>
  )
}
