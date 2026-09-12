import { NavLink } from 'react-router'
import { NAV_ITEMS } from '../navigation'

/** 抽屉与桌面侧边栏共用同一份导航，避免两处各写一套。 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="主导航" className="flex flex-col gap-0.5 p-2">
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
  )
}
