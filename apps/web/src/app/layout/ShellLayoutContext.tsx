import { createContext, useContext, type ReactNode } from 'react'

export type ShellLayout = {
  flushMain: boolean
  /** 页面使用窄屏固定主导航按钮，业务内容须给这条 64px 导航带让位。 */
  fixedMobileNavigation: boolean
  isAgentChat: boolean
  sidebarCollapsed: boolean
  setSidebarCollapsed(collapsed: boolean): void
  navigationOpen: boolean
  setNavigationOpen(open: boolean): void
  openNavigation(): void
  closeNavigation(): void
  conversationDrawerOpen: boolean
  setConversationDrawerOpen(open: boolean): void
  openConversationDrawer(): void
  closeConversationDrawer(): void
}

const noop = () => {}

export const ShellLayoutContext = createContext<ShellLayout>({
  flushMain: false,
  fixedMobileNavigation: false,
  isAgentChat: false,
  sidebarCollapsed: true,
  setSidebarCollapsed: noop,
  navigationOpen: false,
  setNavigationOpen: noop,
  openNavigation: noop,
  closeNavigation: noop,
  conversationDrawerOpen: false,
  setConversationDrawerOpen: noop,
  openConversationDrawer: noop,
  closeConversationDrawer: noop,
})

export const useShellLayout = () => useContext(ShellLayoutContext)

/** 全屏业务页的状态卡仍遵循普通页面间距；业务内容本身保留全高布局。 */
export function ShellPageFallback({ children }: { children: ReactNode }) {
  const { flushMain, fixedMobileNavigation } = useShellLayout()
  if (!flushMain) return <>{children}</>
  return <div className={`min-h-0 flex-1 overflow-y-auto p-4 md:p-6 ${fixedMobileNavigation ? 'pt-[calc(var(--shell-header-height)+1rem)] md:pt-6' : ''}`}>
    {children}
  </div>
}
