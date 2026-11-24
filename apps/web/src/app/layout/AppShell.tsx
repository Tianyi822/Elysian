import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Outlet, useLocation, useMatches } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'
import { MessageCenter } from '../../components/MessageCenter'
import { PanelUpdateMonitor } from './PanelUpdateMonitor'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { useContainersStore } from '../../stores/containersStore'
import { NAV_ITEMS } from '../navigation'
import type { RouteHandle } from '../router'
import {
  HeaderAccessoryWidthContext,
  useHeaderAccessoryWidthMeasurement,
} from './headerAccessoryWidth'
import { Sidebar } from './Sidebar'
import { ShellPageFallback, ShellLayoutContext, type ShellLayout } from './ShellLayoutContext'
import { LoadingState } from '../../components/states/StateViews'
import './headerControls.css'
import { Sidebar as EasyUISidebar, SidebarDrawer, SidebarTrigger, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from '../../components/easyui/Sidebar'
import { mediaQuery, observeMediaQuery } from '../../utils/mediaQuery'
import { browserPreferenceStorage } from '../theme/themePreferences'

const SIDEBAR_WIDTH_KEY = 'elysian.sidebar-width.v1'

function readSidebarWidth() {
  const width = Number(browserPreferenceStorage.getItem(SIDEBAR_WIDTH_KEY))
  return Number.isInteger(width) && width >= SIDEBAR_MIN_WIDTH && width <= SIDEBAR_MAX_WIDTH ? width : SIDEBAR_MIN_WIDTH
}

export function AppShell() {
  const [openDrawer, setOpenDrawer] = useState<'navigation' | 'conversation' | null>(null)
  const openDrawerRef = useRef(openDrawer)
  openDrawerRef.current = openDrawer
  const [globalSidebarCollapsed, setGlobalSidebarCollapsed] = useState(false)
  const [expandedSidebarWidth, setExpandedSidebarWidth] = useState(readSidebarWidth)
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
  const saveSidebarWidth = useCallback((width: number) => {
    if (width === expandedSidebarWidth) return
    setExpandedSidebarWidth(width)
    browserPreferenceStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
  }, [expandedSidebarWidth])
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
  useEffect(() => {
    const wide = mediaQuery('(min-width: 768px)')
    return observeMediaQuery(wide, () => { if (wide?.matches) closeNavigation() })
  }, [closeNavigation])

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
    connectEventStream(gateway.events, useContainersStore.getState().setLiveStatus)
    return () => {
      useEventStreamStore.getState().disconnect()
    }
  }), [gateway, connectEventStream])

  return (
    <ShellLayoutContext.Provider value={layout}>
      <Dialog.Root open={layout.navigationOpen} onOpenChange={setNavigationOpen}>
        <PanelUpdateMonitor />
        <div className="app-canvas flex h-dvh overflow-hidden text-fg">
          <EasyUISidebar collapsed={sidebarCollapsed} expandedWidth={expandedSidebarWidth} onExpandedWidthChange={saveSidebarWidth}>
            <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />
          </EasyUISidebar>

          <div className="flex min-w-0 flex-1 flex-col">
            {hideHeader && (
              <Dialog.Trigger asChild>
                <span ref={headerActionsRef} className="nav-float-trigger fixed left-3 top-0 z-30 flex h-[var(--shell-header-height)] items-center md:hidden">
                  <SidebarTrigger />
                </span>
              </Dialog.Trigger>
            )}

            <SidebarDrawer open={layout.navigationOpen} onClose={closeNavigation}
              onCloseAutoFocus={event => {
                event.preventDefault()
                if (openDrawerRef.current) return
                if (mediaQuery('(min-width: 768px)')?.matches) {
                  document.querySelector<HTMLElement>('[data-easyui="sidebar"] [aria-current="page"]')?.focus()
                } else headerActionsRef.current?.querySelector('button')?.focus()
              }}>
              <Sidebar drawer onNavigate={closeNavigation} />
            </SidebarDrawer>

            <MessageCenter />
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
                    className={`shell-header-actions mb-4 flex min-w-0 items-center gap-3 ${HeaderAccessory ? '' : 'md:hidden'} ${headerClassName ?? ''}`}
                  >
                    <Dialog.Trigger asChild>
                      <span ref={headerActionsRef} className="shrink-0 md:hidden">
                        <SidebarTrigger />
                      </span>
                    </Dialog.Trigger>
                    <HeaderAccessoryWidthContext.Provider value={accessoryWidth}>
                      {HeaderAccessory ? <HeaderAccessory /> : null}
                    </HeaderAccessoryWidthContext.Provider>
                  </div>
                )}
                <Suspense fallback={<ShellPageFallback><LoadingState label="正在加载页面…" /></ShellPageFallback>}>
                  <Outlet />
                </Suspense>
              </main>
            </div>
          </div>
        </div>
      </Dialog.Root>
    </ShellLayoutContext.Provider>
  )
}
