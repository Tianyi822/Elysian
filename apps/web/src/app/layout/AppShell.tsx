import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Outlet, useLocation, useMatches } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { subscribeWhileVisible } from '../../adapters/subscribeWhileVisible'
import { MessageCenter } from '../../components/MessageCenter'
import { PanelUpdateMonitor } from '../../features/settings/PanelUpdateMonitor'
import { useEventStreamStore } from '../../stores/eventStreamStore'
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
import { Sidebar as EasyUISidebar, SidebarDrawer, SidebarTrigger } from '../../components/easyui/Sidebar'
import { mediaQuery, observeMediaQuery } from '../../utils/mediaQuery'

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
  // The official shortcut shares the same state as the visible toggle. Text
  // editors and terminals retain their native Cmd/Ctrl+B key handling.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'b') return
      if (event.target instanceof Element && event.target.closest('input,textarea,[contenteditable="true"],[role="textbox"],.xterm,.terminal')) return
      event.preventDefault()
      if (mediaQuery('(min-width: 768px)')?.matches) setSidebarCollapsed(!sidebarCollapsed)
      else setNavigationOpen(openDrawerRef.current !== 'navigation')
    }
    window.addEventListener('keydown', onKey)
    const wide = mediaQuery('(min-width: 768px)')
    const stop = observeMediaQuery(wide, () => { if (wide?.matches) closeNavigation() })
    return () => { window.removeEventListener('keydown', onKey); stop() }
  }, [sidebarCollapsed, setSidebarCollapsed, setNavigationOpen, closeNavigation])

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
      <Dialog.Root open={layout.navigationOpen} onOpenChange={setNavigationOpen}>
        <PanelUpdateMonitor />
        <div className="app-canvas flex h-dvh overflow-hidden text-fg">
          <EasyUISidebar collapsed={sidebarCollapsed}>
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
              <MessageCenter />
            </div>
          </div>
        </div>
      </Dialog.Root>
    </ShellLayoutContext.Provider>
  )
}
