import { Menu, Moon, Sun, X } from 'lucide-react'
import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Outlet } from 'react-router'
import { IconButton } from '../../components/IconButton'
import { useTheme } from '../theme/ThemeProvider'
import { MockDataBadge } from './MockDataBadge'
import { Sidebar } from './Sidebar'

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false)
  const { theme, toggleTheme } = useTheme()

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

        <div className="ml-auto flex items-center gap-2">
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
