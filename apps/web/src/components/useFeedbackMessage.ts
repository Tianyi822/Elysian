import { useEffect, useRef } from 'react'
import { useMessageStore } from '../stores/messageStore'
import type { MessageTone } from '../stores/messageStore'

/** 同一反馈持续展示时只通知一次，清空后再次出现仍会通知。 */
export function useFeedbackMessage(
  message: string | null | undefined,
  tone: MessageTone = 'danger',
  options?: { replace?: boolean },
) {
  const notify = useMessageStore((state) => state.notify)
  const previous = useRef<{ id: string; message: string; tone: MessageTone } | undefined>(undefined)
  const replace = options?.replace ?? false

  useEffect(() => {
    if (!message) {
      previous.current = undefined
      return
    }
    if (previous.current?.message === message && previous.current.tone === tone) return

    const state = useMessageStore.getState()
    const existing = replace && previous.current && state.messages.some(item => item.id === previous.current?.id)
    const id = existing ? previous.current!.id : notify({ message, tone })
    if (existing) state.update(id, { message, tone })
    previous.current = { id, message, tone }
  }, [message, tone, notify, replace])
}
