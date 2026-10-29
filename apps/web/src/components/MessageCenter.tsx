import * as Dialog from '@radix-ui/react-dialog'
import * as Tooltip from '@radix-ui/react-tooltip'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties } from 'react'
import { useMessageStore } from '../stores/messageStore'
import type { FeedbackMessage, MessageTone } from '../contracts/messages'
import { formatLoginTime } from './format'
import { Bell, CircleCheck, Info, TriangleAlert } from './icons'
import type { IconComponent } from './icons'
import './messageCenter.css'

const UNEXPECTED_ERROR = '页面操作发生异常，请重试；若仍失败，请刷新页面。'
const TONES: Record<MessageTone, { icon: IconComponent; color: string; label: string }> = {
  success: { icon: CircleCheck, color: 'text-success', label: '成功' },
  info: { icon: Info, color: 'text-accent-fg', label: '提示' },
  warning: { icon: TriangleAlert, color: 'text-warning', label: '警告' },
  danger: { icon: TriangleAlert, color: 'text-danger', label: '失败' },
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
  const { icon: Icon, color, label } = TONES[message.tone]
  return <li data-message-id={message.id} className="message-item panel-surface" data-clearing={delay !== undefined || undefined}
    style={delay !== undefined ? { '--message-delay': `${delay}ms` } as CSSProperties : undefined}>
    <Icon aria-hidden size={16} className={`mt-0.5 shrink-0 ${color}`} />
    <div className="min-w-0 flex-1">
      <p className="whitespace-pre-line text-sm leading-5 text-fg [overflow-wrap:anywhere]"><span className="sr-only">{label}：</span>{message.message}</p>
      <p className="mt-1 flex flex-wrap gap-x-2 text-xs leading-5 text-fg-subtle">
        <time dateTime={message.occurredAt} className="tabular-nums">{formatLoginTime(message.occurredAt)}</time>
        {unsaved && <span className="text-warning">仅当前页面可用</span>}
      </p>
    </div>
  </li>
}

/** 常驻辅助层：业务弹窗仍可保留表单，消息使用独立的上层焦点域。 */
export function MessageCenter() {
  const state = useMessageStore()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'saving' | 'clearing'>('idle')
  const [snapshot, setSnapshot] = useState<{ messages: readonly FeedbackMessage[]; visible: string[]; height: number; listHeight: number; hasMore: boolean; error: string | null } | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLOListElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
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
  const displayError = snapshot ? snapshot.error : state.error

  const changeOpen = (next: boolean) => {
    interaction.current += 1
    clearTimeout(timer.current)
    if (next) {
      returnFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== trigger.current && document.activeElement !== document.body ? document.activeElement : returnFocus.current
      setSnapshot(null)
      setPhase('idle')
      void useMessageStore.getState().refresh()
    }
    useMessageStore.getState().setViewing(next)
    setOpen(next)
  }

  useEffect(() => {
    mounted.current = true
    const unsubscribe = useMessageStore.getState().subscribe()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== 'F8') return
      event.preventDefault()
      event.stopPropagation()
      changeOpen(!openRef.current)
    }
    const report = () => {
      const current = useMessageStore.getState()
      const last = current.messages.at(-1)
      if (last?.message === UNEXPECTED_ERROR && Date.now() - Date.parse(last.occurredAt) < 30_000) return
      current.notify({ tone: 'danger', message: UNEXPECTED_ERROR })
    }
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('error', report)
    window.addEventListener('unhandledrejection', report)
    return () => {
      mounted.current = false
      unsubscribe()
      clearTimeout(timer.current)
      useMessageStore.getState().setViewing(false)
      window.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('error', report)
      window.removeEventListener('unhandledrejection', report)
    }
  }, [])

  const clear = async () => {
    if (phase !== 'idle') return
    const startedAt = interaction.current
    const visible = list.current ? visibleMessageIds(list.current) : []
    setSnapshot({ messages, visible, height: panel.current?.getBoundingClientRect().height ?? 0,
      listHeight: list.current?.getBoundingClientRect().height ?? 0, hasMore: state.hasMore, error: state.error })
    setPhase('saving')
    const succeeded = await useMessageStore.getState().clear()
    if (!mounted.current || !openRef.current || startedAt !== interaction.current) return
    if (!succeeded) {
      setSnapshot(null)
      setPhase('idle')
      useMessageStore.getState().setViewing(true)
      return
    }
    setPhase('clearing')
    const reduced = (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    const duration = reduced || !visible.length ? 0 : 180 + Math.min(270, (visible.length - 1) * 45)
    timer.current = setTimeout(() => changeOpen(false), duration)
  }

  return createPortal(<section aria-live="off" className="message-center" data-message-center>
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button ref={trigger} type="button" aria-label="消息" aria-keyshortcuts="F8" aria-haspopup="dialog"
          style={{ pointerEvents: 'auto' }}
          aria-expanded={open} aria-controls={open ? contentId : undefined}
          className="message-trigger icon-button icon-button-solid inline-flex items-center justify-center text-fg-muted transition-colors hover:text-fg"
          onPointerDown={event => {
            // 此入口在底层业务 Dialog 之外；保留其草稿，避免 outside 事件关闭底层弹窗。
            event.stopPropagation()
            returnFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== trigger.current && document.activeElement !== document.body ? document.activeElement : null
          }}
          onClick={() => changeOpen(!open)}>
          <Bell aria-hidden size={18} />
          {state.unread && <span className="message-unread" aria-label="有未读消息" />}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content side="bottom" sideOffset={6} className="z-[80] rounded border border-control-line bg-surface-raised px-2 py-1 text-xs text-fg shadow-lg">消息（F8）<Tooltip.Arrow className="fill-surface-raised" /></Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
    <div className="sr-only" aria-live={state.announcement?.tone === 'danger' ? 'assertive' : 'polite'} aria-atomic="true">
      {state.announcement && <span key={state.announcement.id + state.announcement.occurredAt}>新消息：{state.announcement.message}</span>}
    </div>
    <Dialog.Root open={open} onOpenChange={changeOpen}>
      <Dialog.Portal>
        <Dialog.Content ref={panel} id={contentId} aria-describedby={undefined} className="message-panel"
          style={snapshot ? { height: snapshot.height || undefined } : undefined}
          onCloseAutoFocus={event => {
            event.preventDefault()
            const previous = returnFocus.current
            if (previous?.isConnected) previous.focus()
            else trigger.current?.focus()
          }}
          onInteractOutside={event => { if (event.target instanceof Node && trigger.current?.contains(event.target)) event.preventDefault() }}>
          <div className="message-heading">
            <Dialog.Title className="text-sm font-semibold text-fg">消息</Dialog.Title>
            <button type="button" className="message-clear" disabled={phase !== 'idle' || !displayed.length}
              onClick={() => { void clear() }}>清空全部消息</button>
          </div>
          {displayError && <div role="alert" className="mx-3 mb-2 flex items-start gap-2 text-xs leading-5 text-danger">
            <span className="min-w-0 flex-1">{displayError}</span>
            <button type="button" className="shrink-0 rounded px-1 underline focus-visible:outline-2 focus-visible:outline-focus" disabled={phase !== 'idle'}
              onClick={() => { if (state.errorKind === 'clear') void clear(); else void state.retry() }}>重试</button>
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
          {!displayed.length && !state.loading && !state.error && <p className="message-empty text-center text-sm text-fg-subtle">暂无消息</p>}
          {state.loading && <p role="status" className="px-4 py-3 text-center text-xs text-fg-subtle">正在读取消息…</p>}
          {(snapshot ? snapshot.hasMore : state.hasMore) && !state.loading && <button type="button" disabled={phase !== 'idle'} className="message-more" onClick={() => { void state.loadMore() }}>加载更多</button>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </section>, document.body)
}
