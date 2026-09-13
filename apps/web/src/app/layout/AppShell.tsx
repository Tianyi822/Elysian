import { useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { useState } from 'react'
import { Outlet } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { EventStreamBadge } from '../../components/EventStreamBadge'
import { MemoryMonitorBadge } from '../../components/MemoryMonitorBadge'
import { IconButton } from '../../components/IconButton'
import { NotificationHost } from '../../components/NotificationHost'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { MockDataBadge } from './MockDataBadge'
import { Sidebar } from './Sidebar'

function UserChip() {
  return (
    <span className="hidden items-center gap-1.5 sm:inline-flex">
      <span
        aria-hidden
        className="inline-flex size-6 items-center justify-center rounded-full bg-accent/20 text-xs font-medium text-accent"
      >
        运
      </span>
      <span className="text-xs text-fg-muted">运维人员</span>
    </span>
  )
}

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const gateway = useGateway()
  const connectEventStream = useEventStreamStore((state) => state.connect)

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
        {/* 固定 h-14：与右侧顶栏的 min-h-14 对齐，避免被折叠按钮撑高。 */}
        <div className="flex h-14 items-center justify-between border-b border-line px-3">
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
        <div className="min-h-0 flex-1">
          <Sidebar collapsed={sidebarCollapsed} />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="shrink-0 border-b border-line bg-surface">
          <div className="flex min-h-14 items-center gap-4 px-4 py-3 md:px-6">
            <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
              <Dialog.Trigger asChild>
                <span className="md:hidden">
                  <IconButton label="打开主导航">
                    <Menu aria-hidden size={16} />
                  </IconButton>
                </span>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
                <Dialog.Content
                  aria-describedby={undefined}
                  className="fixed inset-y-0 left-0 z-50 flex w-60 flex-col border-r border-line bg-surface"
                >
                  <div className="flex items-center justify-between border-b border-line px-3 py-2">
                    <Dialog.Title className="text-base font-medium">主导航</Dialog.Title>
                    <Dialog.Close asChild>
                      <span>
                        <IconButton label="关闭主导航">
                          <X aria-hidden size={16} />
                        </IconButton>
                      </span>
                    </Dialog.Close>
                  </div>
                  <div className="min-h-0 flex-1">
                    <Sidebar onNavigate={() => setDrawerOpen(false)} />
                  </div>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>

            <div className="min-w-0">
              <h1 className="text-base font-semibold leading-tight">仪表盘</h1>
            </div>

            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              <MemoryMonitorBadge />
              <EventStreamBadge />
              <MockDataBadge />
              <UserChip />
            </div>
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
            <Outlet />
          </main>
          <NotificationHost />
        </div>
      </div>
    </div>
  )
}
