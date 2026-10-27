import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { PanelLeftClose, PanelLeftOpen } from '../../components/icons'
import { Outlet, useLocation, useMatches } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'
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
import { ShellLayoutContext, type ShellLayout } from './ShellLayoutContext'
import './headerControls.css'
import './sidebar.css'

export function AppShell() {
  const [openDrawer, setOpenDrawer] = useState<'navigation' | 'conversation' | null>(null)
  const openDrawerRef = useRef(openDrawer)
  openDrawerRef.current = openDrawer
  const [globalSidebarCollapsed, setGlobalSidebarCollapsed] = useState(false)
  // 聊天页的收展独立记账：进入时不折叠，继承当前全局状态；聊天内的改动不写回其他页面。
  const [agentSidebarCollapsed, setAgentSidebarCollapsed] = useState(false)
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
  const isAgentChat = location.pathname === '/agent' || location.pathname === '/agent/'
  const sidebarCollapsed = isAgentChat ? agentSidebarCollapsed : globalSidebarCollapsed
  const setSidebarCollapsed = useCallback((collapsed: boolean) => {
    if (isAgentChat) setAgentSidebarCollapsed(collapsed)
    else setGlobalSidebarCollapsed(collapsed)
  }, [isAgentChat])
  const setNavigationOpen = useCallback((open: boolean) => {
    setOpenDrawer(current => open ? 'navigation' : current === 'navigation' ? null : current)
  }, [])
  const setConversationDrawerOpen = useCallback((open: boolean) => {
    setOpenDrawer(current => open && isAgentChat ? 'conversation' : current === 'conversation' ? null : current)
  }, [isAgentChat])
  const openNavigation = useCallback(() => setNavigationOpen(true), [setNavigationOpen])
  const closeNavigation = useCallback(() => setNavigationOpen(false), [setNavigationOpen])
  const openConversationDrawer = useCallback(() => setConversationDrawerOpen(true), [setConversationDrawerOpen])
  const closeConversationDrawer = useCallback(() => setConversationDrawerOpen(false), [setConversationDrawerOpen])
  const layout = useMemo<ShellLayout>(() => ({
    flushMain, fixedMobileNavigation: hideHeader, isAgentChat,
    sidebarCollapsed, setSidebarCollapsed,
    navigationOpen: openDrawer === 'navigation', setNavigationOpen, openNavigation, closeNavigation,
    conversationDrawerOpen: isAgentChat && openDrawer === 'conversation',
    setConversationDrawerOpen, openConversationDrawer, closeConversationDrawer,
  }), [flushMain, hideHeader, isAgentChat, sidebarCollapsed, setSidebarCollapsed, openDrawer,
    setNavigationOpen, openNavigation, closeNavigation, setConversationDrawerOpen, openConversationDrawer, closeConversationDrawer])

  useEffect(() => {
    setOpenDrawer(null)
    // Agent 内的收展不改写其他页面的状态；进入聊天页继承当前收展，离开后回到默认展开。
    if (isAgentChat) setAgentSidebarCollapsed(globalSidebarCollapsed)
    else setAgentSidebarCollapsed(false)
  }, [location.pathname, isAgentChat, globalSidebarCollapsed])
  const pageTitle =
    NAV_ITEMS.find((item) =>
      item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
    )?.label ?? '仪表盘'

  const HeaderAccessory = matches
    .map((match) => (match.handle as RouteHandle | undefined)?.headerAccessory)
    .find((accessory) => accessory !== undefined)
  const headerClassName = matches
    .map((match) => (match.handle as RouteHandle | undefined)?.headerClassName)
    .find((className) => className !== undefined)

  const accessoryWidth = useHeaderAccessoryWidthMeasurement({
    row: headerRowRef,
    title: headerTitleRef,
    actions: headerActionsRef,
    titleText: pageTitle,
  })

  // 每个前台页面只订阅一次；后台页释放 SSE，给同源普通请求留出连接。
  useEffect(() => subscribeWhileVisible(() => {
    connectEventStream(gateway.events)
    return () => {
      useEventStreamStore.getState().disconnect()
    }
  }), [gateway, connectEventStream])

  return (
    <ShellLayoutContext.Provider value={layout}>
      <div className="app-canvas flex h-dvh overflow-hidden text-fg">
        <aside
          aria-label="桌面主导航"
          data-collapsed={sidebarCollapsed || undefined}
          className={`glass-navigation desktop-navigation hidden shrink-0 flex-col md:flex ${
            sidebarCollapsed ? 'w-16' : 'w-60'
          }`}
        >
          <div className="flex h-full min-h-0 w-60 shrink-0 flex-col">
            {/* 品牌区与收展入口固定在导航顶部；导航与内容之间不再画分割线。
                内部始终保持展开宽度，外层裁切；收展按钮以位移跟随边缘，字标只淡入淡出。 */}
            <div className="flex h-[var(--shell-header-height)] shrink-0 items-center justify-between pl-6 pr-3">
              <span className="brand-wordmark desktop-navigation-brand">
                Elysian
              </span>
              <IconButton
                onPress={() => setSidebarCollapsed(!sidebarCollapsed)}
                label={sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'}
                tooltip={false}
                variant="ghost"
                className="desktop-navigation-toggle ml-auto mr-1 size-7 shrink-0 rounded-lg text-nav-muted hover:bg-nav-hover hover:text-nav-fg"
              >
                {sidebarCollapsed ? <PanelLeftOpen aria-hidden size={17} /> : <PanelLeftClose aria-hidden size={17} />}
              </IconButton>
            </div>
            <div className="min-h-0 flex-1">
              <Sidebar collapsed={sidebarCollapsed} />
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <Dialog.Root open={layout.navigationOpen} onOpenChange={setNavigationOpen}>
            {hideHeader && (
              <Dialog.Trigger asChild>
                <span ref={headerActionsRef} className="nav-float-trigger fixed left-3 top-0 z-30 flex h-[var(--shell-header-height)] items-center md:hidden">
                  <IconButton label="打开主导航" tooltip={false}>
                    <PanelLeftOpen aria-hidden size={16} />
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
                  if (!openDrawerRef.current) headerActionsRef.current?.querySelector('button')?.focus()
                }}
                className="glass-navigation fixed inset-y-0 left-0 z-50 flex w-[min(18rem,calc(100vw-2rem))] flex-col shadow-xl will-change-transform motion-reduce:animate-none data-[state=open]:animate-drawer-panel-in data-[state=closed]:animate-drawer-panel-out"
              >
                {/* 抽屉与桌面导航共用品牌区高度，标题左缘同样对齐下方图标。 */}
                <div className="flex h-[var(--shell-header-height)] items-center justify-between pl-6 pr-3">
                  <Dialog.Title className="text-base font-medium">主导航</Dialog.Title>
                  <Dialog.Close asChild>
                    <span>
                      {/* 标题「主导航」已在旁边，悬停提示反而跟随焦点常驻，视觉提示关掉。 */}
                      <IconButton
                        label="关闭主导航"
                        tooltip={false}
                        variant="ghost"
                        className="size-7 text-nav-muted hover:bg-nav-hover hover:text-nav-fg"
                      >
                        {/* 抽屉向左收起，用面板折叠图标比 X 更贴合动作语义。 */}
                        <PanelLeftClose aria-hidden size={16} />
                      </IconButton>
                    </span>
                  </Dialog.Close>
                </div>
                <div className="min-h-0 flex-1">
                  <Sidebar onNavigate={closeNavigation} />
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
                    className={`mb-4 flex min-w-0 items-center gap-3 ${HeaderAccessory ? '' : 'md:hidden'} ${headerClassName ?? ''}`}
                  >
                    <Dialog.Trigger asChild>
                      <span ref={headerActionsRef} className="shrink-0 md:hidden">
                        <IconButton label="打开主导航" tooltip={false} className="size-10">
                          <PanelLeftOpen aria-hidden size={18} />
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
    </ShellLayoutContext.Provider>
  )
}
