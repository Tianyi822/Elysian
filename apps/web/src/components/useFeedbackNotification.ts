import { useEffect, useRef } from 'react'
import { useNotificationStore } from '../stores/notificationStore'
import type { NotificationTone } from '../stores/notificationStore'

/** 同一反馈持续展示时只通知一次，清空后再次出现仍会通知。 */
export function useFeedbackNotification(
  message: string | null | undefined,
  tone: NotificationTone = 'danger',
  options?: { replace?: boolean },
) {
  const notify = useNotificationStore((state) => state.notify)
  const previous = useRef<{ id: string; message: string; tone: NotificationTone } | undefined>(undefined)
  const replace = options?.replace ?? false

  useEffect(() => {
    if (!message) {
      previous.current = undefined
      return
    }
    if (previous.current?.message === message && previous.current.tone === tone) return

    const state = useNotificationStore.getState()
    const existing = replace && previous.current && state.notifications.some(item => item.id === previous.current?.id)
    const id = existing ? previous.current!.id : notify({ message, tone })
    if (existing) state.update(id, { message, tone })
    previous.current = { id, message, tone }
  }, [message, tone, notify, replace])
}
