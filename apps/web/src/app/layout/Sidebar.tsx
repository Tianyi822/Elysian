import { NavLink } from 'react-router'
import { Moon, Sun } from 'lucide-react'
import { NAV_ITEMS } from '../navigation'
import { useTheme } from '../theme/ThemeProvider'

/** 桌面侧边栏与窄屏抽屉共用同一份导航与主题切换。 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const { theme, toggleTheme } = useTheme()

  return (
    <div className="flex h-full flex-col">
      <nav aria-label="主导航" className="flex flex-1 flex-col gap-0.5 p-2">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              [
                'flex items-center gap-2 rounded px-2 py-1.5 text-sm no-underline transition-colors',
                isActive
                  ? 'bg-surface-raised font-medium text-fg'
                  : 'text-fg-muted hover:bg-surface-raised hover:text-fg',
              ].join(' ')
            }
          >
            <item.icon aria-hidden size={16} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="border-t border-line p-2">
        <button
          type="button"
          onClick={toggleTheme}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-muted hover:bg-surface-raised hover:text-fg"
        >
          {theme === 'dark' ? <Sun aria-hidden size={16} /> : <Moon aria-hidden size={16} />}
          {theme === 'dark' ? '浅色模式' : '深色模式'}
        </button>
      </div>
    </div>
  )
}
