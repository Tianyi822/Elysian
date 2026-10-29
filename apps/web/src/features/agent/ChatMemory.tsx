import { useEffect, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentMemoryPage, AgentWikiRef } from '@elysian/contracts'
import type { AgentMemoryAdapter } from '../../contracts/agentMemory'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { IconButton } from '../../components/IconButton'
import { BookOpen, X } from '../../components/icons'
import { ChatMarkdown } from './ChatMarkdown'

const failure = (cause: unknown) => cause instanceof Error ? cause.message : '读取长期记忆失败'

/** 从回答保存的精确引用读取历史，绝不以当前页面代替。 */
export function ChatMemorySources({ sources, api }: { sources: readonly AgentWikiRef[]; api: AgentMemoryAdapter }) {
  const [selected, setSelected] = useState<AgentWikiRef>()
  const [page, setPage] = useState<AgentMemoryPage>()
  const [currentStatus, setCurrentStatus] = useState<AgentMemoryPage['status']>()
  const [statusError, setStatusError] = useState(false)
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    setPage(undefined); setCurrentStatus(undefined); setStatusError(false); setError(undefined)
    if (!selected) return
    const controller = new AbortController(), auth = captureAuthGeneration()
    const current = () => !controller.signal.aborted && auth === captureAuthGeneration()
    void api.getReference(selected, controller.signal).then(async value => {
      if (!current()) return
      setPage(value)
      try {
        const latest = await api.getPage(value.spaceId, value.id, controller.signal)
        if (current()) setCurrentStatus(latest.status)
      } catch { if (current()) setStatusError(true) }
    }).catch(cause => { if (current()) setError(failure(cause)) })
    return () => controller.abort()
  }, [api, selected, attempt])
  return <>
    <div className="-mt-3 mb-5 flex flex-wrap items-center gap-2 text-xs text-fg-muted" aria-label="回答引用的记忆">
      <BookOpen size={13} aria-hidden /><span>记忆引用</span>{sources.map((ref, index) => <button key={`${ref.pageId}:${ref.revision}`} className="rounded border border-line px-2 py-1 hover:bg-surface-hover" onClick={() => setSelected(ref)}>来源 {index + 1} · v{ref.revision}</button>)}
    </div>
    <Dialog.Root open={!!selected} onOpenChange={open => { if (!open) setSelected(undefined) }}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
      <Dialog.Content className="panel-surface fixed left-1/2 top-1/2 z-[61] flex max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col shadow-xl">
        <div className="flex items-center justify-between gap-4 px-5 pt-4"><Dialog.Title className="min-w-0 truncate text-sm font-semibold">{page?.title ?? '记忆引用'} · v{selected?.revision}</Dialog.Title><IconButton label="关闭记忆引用" variant="ghost" onPress={() => setSelected(undefined)}><X size={16} aria-hidden /></IconButton></div>
        <Dialog.Description className="px-5 pt-1 text-xs text-fg-muted">回答当时使用的固定修订</Dialog.Description>
        <div className="hover-scrollbar min-h-0 overflow-y-auto px-5 py-4">
          {error ? <p role="alert" className="text-xs text-danger">{error} <button className="underline" onClick={() => setAttempt(value => value + 1)}>重试读取引用</button></p> : page ? <>
            {(currentStatus === 'withdrawn' || page.status === 'withdrawn') && <p className="mb-3 text-xs text-danger">此来源已撤回，历史内容仅供核对。</p>}
            {statusError && <p className="mb-3 text-xs text-fg-muted">暂时无法核实来源当前状态，以下为回答当时使用的内容。</p>}
            <ChatMarkdown text={page.markdown} />
          </> : <p role="status" className="text-xs text-fg-muted">正在读取固定修订…</p>}
        </div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  </>
}
