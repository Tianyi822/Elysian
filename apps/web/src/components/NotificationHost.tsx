import { CircleCheck, Info, TriangleAlert, X } from './icons'
import type { IconComponent } from './icons'
import { useEffect } from 'react'
import type { AppNotification, NotificationTone } from '../stores/notificationStore'
import { useNotificationStore } from '../stores/notificationStore'
import { IconButton } from './IconButton'

/** 通知停留时长；失败类留久一点，够读完一句原因。 */
const DISMISS_AFTER_MS: Record<NotificationTone, number> = {
  success: 5000,
  info: 5000,
  danger: 8000,
}

type ToneStyle = { border: string; icon: IconComponent; iconColor: string }

const TONE_STYLE: Record<NotificationTone, ToneStyle> = {
  success: { border: 'border-success/40', icon: CircleCheck, iconColor: 'text-success' },
  info: { border: 'border-accent/40', icon: Info, iconColor: 'text-accent' },
  danger: { border: 'border-danger/40', icon: TriangleAlert, iconColor: 'text-danger' },
}

function NotificationItem({ notification }: { notification: AppNotification }) {
  const dismiss = useNotificationStore((state) => state.dismiss)
  const style = TONE_STYLE[notification.tone]
  const Icon = style.icon

  useEffect(() => {
    const timer = setTimeout(
      () => dismiss(notification.id),
      DISMISS_AFTER_MS[notification.tone],
    )
    return () => clearTimeout(timer)
  }, [dismiss, notification.id, notification.tone])

  return (
    <li className="pointer-events-auto">
      <div
        // 成功与提示用 status（礼貌播报），失败用 alert（立即打断）；
        // 角色放在内层，外层 li 保留列表语义。
        role={notification.tone === 'danger' ? 'alert' : 'status'}
        className={[
          'relative flex items-center gap-2 rounded-lg border bg-surface p-2.5 pr-9 shadow-lg',
          style.border,
        ].join(' ')}
      >
        <Icon aria-hidden size={15} className={['shrink-0', style.iconColor].join(' ')} />
        <span className="min-w-0 flex-1 text-xs text-fg">{notification.message}</span>
        {/* 关闭按钮钉死在卡片右上角，脱离 flex 流：内容把卡片撑高也不移动。 */}
        <span className="absolute right-1.5 top-1.5">
          <IconButton variant="ghost" label="关闭通知" onPress={() => dismiss(notification.id)}>
            <X aria-hidden size={12} />
          </IconButton>
        </span>
      </div>
    </li>
  )
}

/**
 * 页面右上角的通知区，由外壳挂在内容行上，因此顶部偏移自动跟随顶栏高度。
 * 容器本身不接收点击，避免盖住下面内容的操作。
 */
export function NotificationHost() {
  const notifications = useNotificationStore((state) => state.notifications)

  if (notifications.length === 0) return null

  return (
    <section
      aria-label="通知"
      className="pointer-events-none absolute right-4 top-4 z-[60] w-[min(22rem,calc(100vw-2rem))]"
    >
      <ol className="flex flex-col gap-2">
        {notifications.map((notification) => (
          <NotificationItem key={notification.id} notification={notification} />
        ))}
      </ol>
    </section>
  )
}
