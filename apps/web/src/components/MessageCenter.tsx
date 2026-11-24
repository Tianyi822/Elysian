import { TOOLTIP_CONTENT_CLASS } from './tooltipStyles'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useMessageStore } from '../stores/messageStore'
import type { FeedbackMessage, MessageTone } from '../contracts/messages'
import { formatLoginTime } from './format'
import { NotificationBell } from './easyui/NotificationBell'
import { Alert, AlertDescription, AlertTitle } from './easyui/Alert'
import './messageCenter.css'
import { Button } from './Button'
import { IconButton } from './IconButton'
import { X } from './icons'

const UNEXPECTED_ERROR = '页面操作发生异常，请重试；若仍失败，请刷新页面。'
const TONE_LABELS: Record<MessageTone, string> = {
  success: '成功',
  info: '提示',
  warning: '警告',
  danger: '失败',
}

export function visibleMessageIds(list: HTMLElement): string[] {
  const viewport = list.getBoundingClientRect()
  const top = Math.max(0, viewport.top)
  const bottom = Math.min(window.innerHeight, viewport.bottom)
  const left = Math.max(0, viewport.left)
  const right = Math.min(window.innerWidth, viewport.right)
  return [...list.querySelectorAll<HTMLElement>('[data-message-id]')]
    .filter(element => { const rect = element.getBoundingClientRect(); return rect.bottom > top && rect.top < bottom && rect.right > left && rect.left < right })
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
    .map(element => element.dataset.messageId!)
}

function MessageItem({ message, unsaved, delay }: { message: FeedbackMessage; unsaved: boolean; delay?: number }) {
  return <li data-message-id={message.id} className="message-item" data-clearing={delay !== undefined || undefined}
    style={delay !== undefined ? { '--message-delay': `${delay}ms` } as CSSProperties : undefined}>
    <Alert tone={message.tone} role="none">
      <AlertTitle className="whitespace-pre-line [overflow-wrap:anywhere]"><span className="sr-only">{TONE_LABELS[message.tone]}：</span>{message.message}</AlertTitle>
      <AlertDescription className="flex flex-wrap gap-x-2 text-xs leading-5">
        <time dateTime={message.occurredAt} className="tabular-nums">{formatLoginTime(message.occurredAt)}</time>
        {unsaved && <span className="text-warning">仅当前页面可用</span>}
      </AlertDescription>
    </Alert>
  </li>
}

/** 消息入口属于应用框架，消息历史用独立弹层。 */
export function MessageCenter() {
  const state = useMessageStore()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'clearing'>('idle')
  const [snapshot, setSnapshot] = useState<{ messages: readonly FeedbackMessage[]; visible: string[]; height: number; listHeight: number; hasMore: boolean; errorMessage?: string } | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mounted = useRef(true)
  const interaction = useRef(0)
  const openRef = useRef(open)
  openRef.current = open
  const contentId = useId()
  const messages = useMemo(() => [...state.messages].sort((a, b) => {
    if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1
    return a.id === b.id ? 0 : a.id < b.id ? 1 : -1
  }), [state.messages])
  const displayed = snapshot?.messages ?? messages
  const displayError = snapshot ? snapshot.errorMessage : state.errorMessage
  const loading = state.status === 'loading'

  const changeOpen = (next: boolean) => {
    interaction.current += 1
    clearTimeout(timer.current)
    if (next) {
      setSnapshot(null)
      setPhase('idle')
      void useMessageStore.getState().load()
    }
    useMessageStore.getState().setViewing(next)
    setOpen(next)
  }

  useEffect(() => {
    mounted.current = true
    const unsubscribe = useMessageStore.getState().subscribe()
    const report = () => {
      const current = useMessageStore.getState()
      const last = current.messages.at(-1)
      if (last?.message === UNEXPECTED_ERROR && Date.now() - Date.parse(last.occurredAt) < 30_000) return
      current.notify({ tone: 'danger', message: UNEXPECTED_ERROR })
    }
    window.addEventListener('error', report)
    window.addEventListener('unhandledrejection', report)
    return () => {
      mounted.current = false
      unsubscribe()
      clearTimeout(timer.current)
      useMessageStore.getState().setViewing(false)
      window.removeEventListener('error', report)
      window.removeEventListener('unhandledrejection', report)
    }
  }, [])

  const clear = async () => {
    if (phase !== 'idle') return
    const startedAt = interaction.current
    const visible = list.current ? visibleMessageIds(list.current) : []
    setSnapshot({ messages, visible, height: panel.current?.getBoundingClientRect().height ?? 0,
      listHeight: list.current?.getBoundingClientRect().height ?? 0, hasMore: state.hasMore, errorMessage: state.errorMessage })
    setPhase('saving')
    const succeeded = await useMessageStore.getState().clear()
    if (!mounted.current || !openRef.current || startedAt !== interaction.current) return
    if (!succeeded) {
      setSnapshot(null)
      setPhase('idle')
      useMessageStore.getState().setViewing(true)
      return
    }
    const reduced = (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    if (reduced || !visible.length) {
      changeOpen(false)
      return
    }
    setPhase('clearing')
    const duration = 180 + Math.min(270, (visible.length - 1) * 45)
    timer.current = setTimeout(() => changeOpen(false), duration)
  }

  return <>
    <section className="message-center" data-message-center>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <NotificationBell ref={trigger} aria-label="消息" aria-haspopup="dialog"
          isOpen={open} onOpenChange={changeOpen} unread={state.unread} arrivalKey={state.announcement?.id}
          aria-controls={open ? contentId : undefined}
          className="message-trigger" />
      </Tooltip.Trigger>
      <Tooltip.Content side="bottom" sideOffset={6} className={TOOLTIP_CONTENT_CLASS}>消息<Tooltip.Arrow className="fill-surface-raised" /></Tooltip.Content>
    </Tooltip.Root>
    </section>
    <div className="sr-only" aria-live={state.announcement?.tone === 'danger' ? 'assertive' : 'polite'} aria-atomic="true">
      {state.announcement && <span key={state.announcement.id + state.announcement.occurredAt}>新消息：{state.announcement.message}</span>}
    </div>
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Content ref={panel} id={contentId} aria-describedby={undefined} className="message-panel"
          style={snapshot ? { height: snapshot.height || undefined } : undefined}
          onOpenAutoFocus={event => {
            event.preventDefault()
            panel.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={event => {
            event.preventDefault()
            trigger.current?.focus({ preventScroll: true })
          }}>
          <div className="message-heading">
            <Dialog.Title className="sr-only">消息</Dialog.Title>
            <Button variant="outline" type="button" className="message-clear" disabled={phase !== 'idle' || !displayed.length}
              onClick={() => { void clear() }}>清空全部消息</Button>
            <IconButton label="关闭消息" variant="ghost" onPress={() => changeOpen(false)}><X size={16} aria-hidden /></IconButton>
          </div>
          {displayError && <div role="alert" className="mx-3 mb-2 flex items-start gap-2 text-xs leading-5 text-danger">
            <span className="min-w-0 flex-1">{displayError}</span>
            <Button variant="link" type="button" className="shrink-0 rounded px-1 underline focus-visible:outline-2 focus-visible:outline-focus" disabled={phase !== 'idle'}
              onClick={() => { if (state.errorKind === 'clear') void clear(); else void state.retry() }}>重试</Button>
          </div>}
          <ol ref={list} aria-label="消息记录" className="message-list hover-scrollbar" data-frozen={phase !== 'idle' || undefined}
            style={snapshot ? { height: snapshot.listHeight || undefined, flex: 'none' } : undefined}
            onScroll={event => {
              const element = event.currentTarget
              if (phase === 'idle' && element.scrollHeight - element.scrollTop - element.clientHeight < 100) void state.loadMore()
            }}>
            {displayed.map(message => {
              const index = snapshot?.visible.indexOf(message.id) ?? -1
              const delay = phase === 'clearing' && index >= 0 ? Math.min(index * 45, 270) : undefined
              return <MessageItem key={message.id} message={message} unsaved={state.unsavedIds.includes(message.id)} delay={delay} />
            })}
          </ol>
          {!displayed.length && !loading && !displayError && <p className="message-empty text-center text-sm text-fg-subtle">暂无消息</p>}
          {loading && <p role="status" className="px-4 py-3 text-center text-xs text-fg-subtle">正在读取消息…</p>}
          {(snapshot ? snapshot.hasMore : state.hasMore) && !loading && <Button variant="outline" type="button" disabled={phase !== 'idle'} className="message-more" onClick={() => { void state.loadMore() }}>加载更多</Button>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}
