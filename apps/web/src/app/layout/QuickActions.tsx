import { useState } from 'react'
import type { ReactNode } from 'react'
import { LogOut, Monitor, Moon, Sun } from '../../components/icons'
import type { IconComponent } from '../../components/icons'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { useSessionStore } from '../../stores/sessionStore'
import { useTheme } from '../theme/ThemeProvider'

function ActionItem({
  label,
  icon: Icon,
  onClick,
  collapsed = false,
  trailing = undefined,
}: {
  label: string
  icon: IconComponent
  onClick: () => void
  collapsed?: boolean
  /** 行尾附加控件；折叠态改为竖排，保持侧边栏 2.5rem 的宽度节奏。 */
  trailing?: ReactNode
}) {
  return (
    /* 按钮外壳放在行容器上：主操作与行尾图标视觉上同属一枚控件，点击区域各自独立。 */
    <div
      className={[
        'flex min-h-10 items-center gap-1 rounded-lg text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg',
        collapsed ? 'w-10 flex-col px-1 py-1.5' : 'w-full py-2 pl-3 pr-1.5',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onClick}
        className={
          collapsed
            ? 'flex w-full flex-col items-center'
            : 'flex min-w-0 flex-1 items-center gap-3 text-left'
        }
      >
        <span className="inline-flex size-6 shrink-0 items-center justify-center">
          <Icon aria-hidden size={17} />
        </span>
        <span className={collapsed ? 'sr-only' : 'min-w-0 truncate text-sm font-medium'}>{label}</span>
      </button>
      {trailing}
    </div>
  )
}

/** 与主题行同一套行高、图标槽与字号，放在切换主题下方。身份本身不是按钮，登出挂在行尾。 */
function OperatorRow({ collapsed = false, trailing }: { collapsed?: boolean; trailing?: ReactNode }) {
  return (
    <div
      className={[
        'flex min-h-10 items-center text-fg-muted',
        collapsed ? 'w-10 flex-col justify-center px-1 py-1.5' : 'w-full gap-3 py-2 pl-3 pr-1.5',
      ].join(' ')}
    >
      <span
        aria-hidden
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-accent/20 text-xs font-medium text-accent"
      >
        运
      </span>
      <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate text-sm font-medium'}>运维人员</span>
      {trailing}
    </div>
  )
}

/** 侧边栏底部：主题切换，以及其下的当前操作者。真实会话时登出挂在操作者行尾。桌面侧边栏与窄屏抽屉共用。 */
export function QuickActions({ collapsed = false }: { collapsed?: boolean }) {
  const { theme, followsSystem, toggleTheme, followSystemTheme } = useTheme()
  const gateway = useGateway()
  const sessionMode = useSessionStore((state) => state.mode)
  const logout = useSessionStore((state) => state.logout)
  const [loggingOut, setLoggingOut] = useState(false)

  return (
    <section aria-label="快捷操作">
      <div className="flex flex-col gap-1">
        {/* 主题变化本身就是可见反馈，不再发通知。 */}
        <ActionItem
          label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          icon={theme === 'dark' ? Sun : Moon}
          collapsed={collapsed}
          onClick={() => toggleTheme()}
          trailing={
            /* 存过手动偏好才出现行内图标：点它把主题决定权交回系统，不另占一条动作。 */
            !followsSystem ? (
              <IconButton
                label="跟随系统主题"
                variant="ghost"
                onPress={() => followSystemTheme()}
              >
                <Monitor aria-hidden size={15} />
              </IconButton>
            ) : undefined
          }
        />
        <OperatorRow
          collapsed={collapsed}
          trailing={
            sessionMode === 'real' ? (
              <IconButton
                label="退出登录"
                variant="ghost"
                disabled={loggingOut}
                onPress={() => {
                  setLoggingOut(true)
                  // 登出置 anonymous 后 RequireSession 自动 Navigate 到 /login。
                  void logout(gateway)
                }}
              >
                <LogOut aria-hidden size={15} />
              </IconButton>
            ) : undefined
          }
        />
      </div>
    </section>
  )
}
