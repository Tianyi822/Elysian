import { useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import * as Tooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'
import { LogOut, Monitor, Moon, Sun, UserRound } from '../../components/icons'
import type { IconComponent } from '../../components/icons'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { useSessionStore } from '../../stores/sessionStore'
import { useTheme } from '../theme/ThemeProvider'

/** 展开态的一行动作：文字常驻，所以不再叠一层悬停提示。 */
function ActionItem({
  label,
  icon: Icon,
  onClick,
  trailing = undefined,
}: {
  label: string
  icon: IconComponent
  onClick: () => void
  /** 行尾附加控件，与主操作同属一行容器。 */
  trailing?: ReactNode
}) {
  return (
    /* 按钮外壳放在行容器上：主操作与行尾图标视觉上同属一枚控件，点击区域各自独立。 */
    <div className="flex min-h-10 w-full items-center gap-1 rounded-lg py-2 pl-3 pr-1.5 text-nav-muted transition-colors hover:bg-nav-hover hover:text-nav-fg">
      <button
        type="button"
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span className="inline-flex size-6 shrink-0 items-center justify-center">
          <Icon aria-hidden size={17} />
        </span>
        <span className="min-w-0 truncate text-sm font-medium">{label}</span>
      </button>
      {trailing}
    </div>
  )
}

/** 操作者头像：圆形底加人像图标，替代原先借「运」字占位的写法。 */
function OperatorMark() {
  return (
    <span
      aria-hidden
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-nav-selected text-nav-fg"
    >
      <UserRound size={14} />
    </span>
  )
}

/** 与主题行同一套行高、图标槽与字号，放在切换主题下方。身份本身不是按钮，登出挂在行尾。 */
function OperatorRow({ trailing }: { trailing?: ReactNode }) {
  return (
    <div className="flex min-h-10 w-full items-center gap-3 py-2 pl-3 pr-1.5 text-nav-muted">
      <OperatorMark />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">运维人员</span>
      {trailing}
    </div>
  )
}

type MenuAction = { icon: IconComponent; label: string; onSelect: () => void }

/**
 * 折叠态的图标触发器：40px 宽里摆不下一行文字，所以一个位置只留一枚图标，
 * 悬停出文字提示，点开才列出带文字的按钮。没有按钮可列时它退回纯指示，不做空浮层。
 */
function CollapsedTrigger({
  label,
  actions,
  children,
}: {
  label: string
  /** 为空即没有可执行动作：只保留悬停文字提示，不弹空窗。 */
  actions: readonly MenuAction[]
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const trigger = (
    <button
      type="button"
      aria-label={label}
      className="flex min-h-10 w-10 items-center justify-center rounded-lg text-nav-muted transition-colors hover:bg-nav-hover hover:text-nav-fg"
    >
      {children}
    </button>
  )

  if (actions.length === 0) {
    return (
      <Tooltip.Root>
        <Tooltip.Trigger asChild>{trigger}</Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="right" sideOffset={10} className="z-[80] rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs text-fg shadow-lg">{label}</Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    )
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Popover.Trigger asChild>{trigger}</Popover.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content side="right" sideOffset={10} className="z-[80] rounded-lg border border-control-line bg-surface-raised px-3 py-1.5 text-xs text-fg shadow-lg">{label}</Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
      <Popover.Portal>
        <Popover.Content
          side="right"
          align="end"
          sideOffset={10}
          collisionPadding={8}
          aria-label={label}
          className="panel-surface z-[70] w-48 p-1.5 shadow-lg"
        >
          <div className="flex flex-col gap-0.5">
            {actions.map((action) => (
              <button
                key={action.label}
                type="button"
                onClick={() => {
                  setOpen(false)
                  action.onSelect()
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-nav-fg transition-colors hover:bg-nav-hover"
              >
                <action.icon aria-hidden size={15} className="shrink-0" />
                <span className="min-w-0 truncate">{action.label}</span>
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

/** 侧边栏底部：主题切换，以及其下的当前操作者。真实会话时登出挂在操作者行尾。 */
export function QuickActions({ collapsed = false }: { collapsed?: boolean }) {
  const { theme, followsSystem, toggleTheme, followSystemTheme } = useTheme()
  const gateway = useGateway()
  const sessionMode = useSessionStore((state) => state.mode)
  const logout = useSessionStore((state) => state.logout)
  const [loggingOut, setLoggingOut] = useState(false)
  const toggleLabel = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'
  const doLogout = () => {
    setLoggingOut(true)
    // 登出置 anonymous 后 RequireSession 自动 Navigate 到 /login。
    void logout(gateway)
  }
  /** 存过手动偏好才有「交回系统」这件事可做，没得可交时不摆空按钮。 */
  const themeActions: MenuAction[] = [
    { icon: theme === 'dark' ? Sun : Moon, label: toggleLabel, onSelect: () => toggleTheme() },
  ]
  if (!followsSystem) themeActions.push({ icon: Monitor, label: '跟随系统主题', onSelect: () => followSystemTheme() })

  return (
    <section aria-label="快捷操作">
      {collapsed ? (
        /* 折叠态一个位置只留一枚图标：主题与身份各成一次点击，动作在浮层里带文字列出。 */
        <div className="flex flex-col gap-1">
          <CollapsedTrigger label="主题设置" actions={themeActions}>
            {theme === 'dark' ? <Sun aria-hidden size={17} /> : <Moon aria-hidden size={17} />}
          </CollapsedTrigger>
          <CollapsedTrigger
            label="运维人员"
            actions={sessionMode === 'real' ? [{ icon: LogOut, label: '退出登录', onSelect: doLogout }] : []}
          >
            <OperatorMark />
          </CollapsedTrigger>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {/* 主题变化本身就是可见反馈，不再发通知。 */}
          <ActionItem
            label={toggleLabel}
            icon={theme === 'dark' ? Sun : Moon}
            onClick={() => toggleTheme()}
            trailing={
              /* 存过手动偏好才出现行内图标：点它把主题决定权交回系统，不另占一条动作。 */
              !followsSystem ? (
                <IconButton
                  label="跟随系统主题"
                  variant="ghost"
                  className="text-nav-muted hover:bg-nav-hover hover:text-nav-fg"
                  onPress={() => followSystemTheme()}
                >
                  <Monitor aria-hidden size={15} />
                </IconButton>
              ) : undefined
            }
          />
          <OperatorRow
            trailing={
              sessionMode === 'real' ? (
                <IconButton
                  label="退出登录"
                  variant="ghost"
                  className="text-nav-muted hover:bg-nav-hover hover:text-nav-fg"
                  disabled={loggingOut}
                  onPress={doLogout}
                >
                  <LogOut aria-hidden size={15} />
                </IconButton>
              ) : undefined
            }
          />
        </div>
      )}
    </section>
  )
}
