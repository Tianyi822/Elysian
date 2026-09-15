import * as Dialog from '@radix-ui/react-dialog'
import { Monitor, Moon, RefreshCw, Sun, Zap } from '../../components/icons'
import type { IconComponent } from '../../components/icons'
import type { ReactNode } from 'react'
import { useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { IconButton } from '../../components/IconButton'
import { useDashboardStore } from '../../stores/dashboardStore'
import { useEventStreamStore } from '../../stores/eventStreamStore'
import { useNotificationStore } from '../../stores/notificationStore'
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
        <Icon aria-hidden size={17} className="shrink-0" />
        <span className={collapsed ? 'sr-only' : 'min-w-0 truncate text-sm font-medium'}>{label}</span>
      </button>
      {trailing}
    </div>
  )
}

/** 侧边栏底部的快捷操作，桌面侧边栏与窄屏抽屉共用；反馈就地显示在动作列表上方。 */
export function QuickActions({ collapsed = false }: { collapsed?: boolean }) {
  const gateway = useGateway()
  const { theme, followsSystem, toggleTheme, followSystemTheme } = useTheme()
  const load = useDashboardStore((state) => state.load)
  const refresh = useDashboardStore((state) => state.refresh)
  const notify = useNotificationStore((state) => state.notify)

  const [confirmOpen, setConfirmOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [resetError, setResetError] = useState<string | undefined>(undefined)

  const handleReset = async () => {
    setResetting(true)
    setResetError(undefined)
    try {
      await gateway.reset()
      await load(gateway)
      setConfirmOpen(false)
      notify({ tone: 'success', message: '演示数据已重置回种子状态。' })
    } catch (error) {
      // 重置失败留在对话框里：弹窗打开期间外部通知对读屏是隐藏的。
      setResetError(error instanceof Error ? error.message : '重置演示数据失败')
    } finally {
      setResetting(false)
    }
  }

  return (
    <section aria-label="快捷操作">
      <div className="flex flex-col gap-1">
        <ActionItem
          label={theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'}
          icon={theme === 'dark' ? Sun : Moon}
          collapsed={collapsed}
          onClick={() => {
            toggleTheme()
            notify({
              tone: 'success',
              message: theme === 'dark' ? '已切换到浅色主题。' : '已切换到深色主题。',
            })
          }}
          trailing={
            /* 存过手动偏好才出现行内图标：点它把主题决定权交回系统，不另占一条动作。 */
            !followsSystem ? (
              <IconButton
                label="跟随系统主题"
                variant="ghost"
                onPress={() => {
                  followSystemTheme()
                  notify({ tone: 'success', message: '已改为跟随系统主题。' })
                }}
              >
                <Monitor aria-hidden size={15} />
              </IconButton>
            ) : undefined
          }
        />
        <ActionItem
          label="重置演示数据"
          icon={RefreshCw}
          collapsed={collapsed}
          onClick={() => setConfirmOpen(true)}
        />
        <ActionItem
          label="重新连接事件源"
          icon={Zap}
          collapsed={collapsed}
          onClick={() => {
            useEventStreamStore.getState().connect(gateway.events)
            notify({ tone: 'info', message: '已尝试重新连接事件源，状态见页头标识。' })
          }}
        />
        <ActionItem
          label="刷新仪表盘"
          icon={RefreshCw}
          collapsed={collapsed}
          onClick={() => {
            void refresh(gateway)
          }}
        />
      </div>

      <Dialog.Root
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open)
          if (!open) setResetError(undefined)
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 w-[min(28rem,92vw)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-4"
          >
            <Dialog.Title className="mb-1.5 text-sm font-semibold">确认重置演示数据？</Dialog.Title>
            <p className="mb-2 text-xs text-fg-muted">
              审批状态、技能启停等本地改动都会回到初始种子状态。这一步不会影响任何真实系统。
            </p>
            {resetError ? (
              <p
                role="alert"
                className="mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger"
              >
                重置演示数据失败：{resetError}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-line px-2 py-1 text-xs text-fg-muted"
                >
                  取消
                </button>
              </Dialog.Close>
              <button
                type="button"
                disabled={resetting}
                onClick={() => void handleReset()}
                className="rounded-lg border border-danger/50 px-2 py-1 text-xs text-danger disabled:opacity-50"
              >
                确认重置
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  )
}
