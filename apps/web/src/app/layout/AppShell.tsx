import { useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Menu, X } from 'lucide-react'
import { useState } from 'react'
import { Outlet } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { EventStreamBadge } from '../../components/EventStreamBadge'
import { IconButton } from '../../components/IconButton'
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
    <div className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-30 border-b border-line bg-surface">
        <div className="flex items-center gap-3 px-3 py-2">
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
                className="fixed inset-y-0 left-0 z-50 w-60 border-r border-line bg-surface"
              >
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <Dialog.Title className="text-sm font-medium">主导航</Dialog.Title>
                  <Dialog.Close asChild>
                    <span>
                      <IconButton label="关闭主导航">
                        <X aria-hidden size={16} />
                      </IconButton>
                    </span>
                  </Dialog.Close>
                </div>
                <Sidebar onNavigate={() => setDrawerOpen(false)} />
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>

          <span className="text-sm font-semibold tracking-tight">Elysian</span>
          <span aria-hidden className="h-4 w-px bg-line" />

          <div className="min-w-0">
            <h1 className="text-sm font-semibold leading-tight">仪表盘</h1>
            <p className="text-xs leading-tight text-fg-subtle">运维态势概览</p>
          </div>

          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <EventStreamBadge />
            <MockDataBadge />
            <UserChip />
          </div>
        </div>
      </header>

      <div className="flex">
        <aside className="hidden w-56 shrink-0 border-r border-line bg-surface md:block">
          <Sidebar />
        </aside>
        <main className="min-w-0 flex-1 p-3 md:p-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
