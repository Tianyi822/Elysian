import { readAuthorizationPending, saveAuthorizationPending } from './authorizationPending'
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentAuthorizationRevokeInput, AgentSessionAuthorization } from '@elysian/contracts'
import type { AgentChatGovernance } from '../../contracts/agentChat'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { IconButton } from '../../components/IconButton'
import { X } from '../../components/icons'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { RuntimeAccessDetails } from './RuntimeAccessCard'

/** 旧组件名保留，入口已切换为服务端会话授权。运行中仍可撤回。 */
export function ChatExecutionScope({ open, sessionId, api, onClose }: {
  open: boolean; sessionId?: string; api?: AgentChatGovernance; onClose(): void
}) {
  const [items, setItems] = useState<readonly AgentSessionAuthorization[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState<Record<string, AgentAuthorizationRevokeInput>>({})
  const lifetime = useRef(0)
  useFeedbackNotification(open ? error : null)
  useEffect(() => {
    lifetime.current += 1; setItems([]); setError(null); setPending(sessionId ? readAuthorizationPending(`session:${sessionId}`) : {}); setActing(undefined)
    return () => { lifetime.current += 1 }
  }, [open, sessionId, api])
  useEffect(() => {
    if (!open || !api || !sessionId) return
    const controller = new AbortController(), auth = captureAuthGeneration(), owner = lifetime.current
    const current = () => !controller.signal.aborted && auth === captureAuthGeneration() && owner === lifetime.current
    setLoading(true)
    void api.authorizations(sessionId, controller.signal).then(rows => {
      if (!current()) return
      setItems(rows); setError(null)
      setPending(previous => Object.fromEntries(Object.entries(previous).filter(([id, input]) => rows.some(row => row.id === id && row.status === 'active' && row.revision === input.expectedRevision))))
    }).catch(cause => { if (current()) setError(cause instanceof Error ? cause.message : '读取本会话授权失败') }).finally(() => { if (current()) setLoading(false) })
    return () => controller.abort()
  }, [open, sessionId, api, attempt])
  const revoke = async (item: AgentSessionAuthorization) => {
    if (!api || !sessionId || acting || loading) return
    const owner = lifetime.current, auth = captureAuthGeneration()
    const input = pending[item.id] ?? { requestId: crypto.randomUUID(), expectedRevision: item.revision }
    setPending(previous => { const next = { ...previous, [item.id]: input }; saveAuthorizationPending(`session:${sessionId}`, next); return next }); setActing(item.id); setError(null)
    try {
      const receipt = await api.revokeAuthorization(sessionId, item.id, input)
      if (owner !== lifetime.current || auth !== captureAuthGeneration()) return
      setItems(rows => rows.map(row => row.id === item.id ? receipt : row))
      setPending(previous => { const next = { ...previous }; delete next[item.id]; saveAuthorizationPending(`session:${sessionId}`, next); return next })
    } catch (cause) { if (owner === lifetime.current && auth === captureAuthGeneration()) setError(cause instanceof Error ? cause.message : '撤回结果未确认，请重新读取') }
    finally { if (owner === lifetime.current && auth === captureAuthGeneration()) { setActing(undefined); setAttempt(value => value + 1) } }
  }
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
    <Dialog.Content className="fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
      <div className="flex items-center justify-between px-5 pt-4"><Dialog.Title className="text-sm font-semibold">本会话授权</Dialog.Title><IconButton label="关闭本会话授权" variant="ghost" onPress={onClose}><X size={16} aria-hidden /></IconButton></div>
      <Dialog.Description className="px-5 pt-1 text-xs leading-5 text-fg-muted">仅当前会话可复用这些允许项。撤回后停止后续派发，并请求停止关联执行；已产生的外部修改不会撤销。</Dialog.Description>
      <div className="hover-scrollbar min-h-0 space-y-3 overflow-y-auto px-5 py-4 text-sm">
        {!sessionId ? <p className="text-xs text-fg-muted">开始聊天后，选择「本会话允许」的权限会显示在这里。</p> : !api ? <p role="status" className="text-fg-muted">当前环境未提供会话授权。</p> : <>
          {loading && <p role="status" className="text-xs">正在读取本会话授权…</p>}
          {error && <button className="text-xs underline" disabled={!!acting} onClick={() => setAttempt(value => value + 1)}>重新读取本会话授权</button>}
          {!loading && !error && !items.length && <p className="text-xs text-fg-muted">尚未记住任何允许项。需要权限时，Ely 会在聊天中询问。</p>}
          {items.map(item => <section key={item.id} className="space-y-3 rounded-lg border border-line p-3"><div className="flex items-center justify-between gap-3"><h3 className="break-all text-xs font-medium">{item.tool}</h3><span className="shrink-0 text-xs text-fg-muted">{item.status === 'active' ? '可复用' : '已撤回'}</span></div><RuntimeAccessDetails access={item.access} profile={item.executionProfile} />
            {item.status === 'active' && <><button className="min-h-8 rounded-md border border-control-line px-3 text-xs text-danger hover:bg-surface-hover disabled:opacity-50" disabled={!!acting || loading || !!error} onClick={() => void revoke(item)}>{acting === item.id ? '正在撤回…' : pending[item.id] ? '按原请求重试撤回' : '撤回授权'}</button>{pending[item.id] && <p className="text-xs text-warning">撤回结果尚未确认，先读取服务端状态。</p>}</>}
          </section>)}
        </>}
      </div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}
