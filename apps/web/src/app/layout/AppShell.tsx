import { useEffect } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Menu, Moon, Sun, X } from 'lucide-react'
import { useState } from 'react'
import { Outlet } from 'react-router'
import { useGateway } from '../../adapters/GatewayProvider'
import { EventStreamBadge } from '../../components/EventStreamBadge'
import { IconButton } from '../../components/IconButton'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { useTheme } from '../theme/ThemeProvider'
import { MockDataBadge } from './MockDataBadge'
import { Sidebar } from './Sidebar'

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { theme, toggleTheme } = useTheme()
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
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-surface px-3 py-2">
        <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
          <Dialog.Trigger asChild>
            <button
              type="button"
              aria-label="打开主导航"
              className="inline-flex size-7 items-center justify-center rounded border border-line bg-surface-raised text-fg-muted md:hidden"
            >
              <Menu aria-hidden size={16} />
            </button>
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
                  <button
                    type="button"
                    aria-label="关闭主导航"
                    className="inline-flex size-7 items-center justify-center rounded text-fg-muted"
                  >
                    <X aria-hidden size={16} />
                  </button>
                </Dialog.Close>
              </div>
              <Sidebar onNavigate={() => setDrawerOpen(false)} />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        <span className="text-sm font-semibold tracking-tight">Elysian</span>
        <span className="hidden text-xs text-fg-subtle sm:inline">运维工作台</span>

        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <EventStreamBadge />
          <MockDataBadge />
          <IconButton
            label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
            onPress={toggleTheme}
          >
            {theme === 'dark' ? <Sun aria-hidden size={15} /> : <Moon aria-hidden size={15} />}
          </IconButton>
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
