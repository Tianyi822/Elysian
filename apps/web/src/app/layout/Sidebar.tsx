import { NavLink } from 'react-router'
import { NAV_ITEMS } from '../navigation'
import { QuickActions } from './QuickActions'

/** 桌面侧边栏与窄屏抽屉共用同一份导航与底部快捷操作。 */
export function Sidebar({
  onNavigate,
  collapsed = false,
}: {
  onNavigate?: () => void
  collapsed?: boolean
}) {
  return (
    <div className="flex h-full flex-col">
      <nav aria-label="主导航" className={`flex flex-1 flex-col gap-1 p-3 ${collapsed ? 'items-center' : ''}`}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={onNavigate}
            className={({ isActive }) =>
              [
                'flex min-h-10 items-center gap-3 rounded-lg px-3 py-2 text-sm no-underline transition-colors',
                collapsed ? 'w-10 justify-center px-0' : 'w-full',
                isActive
                  ? 'bg-surface-raised font-medium text-fg'
                  : 'text-fg-muted hover:bg-surface-raised hover:text-fg',
              ].join(' ')
            }
          >
            <item.icon aria-hidden size={17} />
            <span className={collapsed ? 'sr-only' : undefined}>{item.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className={`border-t border-line p-3 ${collapsed ? 'items-center' : ''}`}>
        <QuickActions collapsed={collapsed} />
      </div>
    </div>
  )
}
