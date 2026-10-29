import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import { AGENT_MEMORY_PAGE_KIND_LABELS } from '@elysian/contracts'
import type { AgentMemoryPage, AgentMemoryPageKind } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { useSessionStore } from '../../stores/sessionStore'
import { IconButton } from '../../components/IconButton'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { SelectDropdown } from '../../components/SelectDropdown'
import { EmptyState, LoadingState } from '../../components/states/StateViews'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_DANGER, CTL_FIELD, CTL_TOOLBAR } from '../../components/formControl'
import { ChatMarkdown } from '../agent/ChatMarkdown'
import { X } from '../../components/icons'
import './memory.css'

const bytes = (value: string) => new TextEncoder().encode(value).length
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
/** 编辑表单排除只读的导入原文。 */
const KIND_OPTIONS = (Object.entries(AGENT_MEMORY_PAGE_KIND_LABELS) as [AgentMemoryPageKind, string][])
  .filter(([kind]) => kind !== 'sources')
  .map(([value, label]) => ({ value, label }))

/** 知识 Wiki 独立浏览与人工编辑页。 */
export function WikiPage() {
  const gateway = useGateway()
  const state = useAgentMemoryStore()
  const authed = useSessionStore(s => s.phase === 'authed')
  const [openId, setOpenId] = useState<string | undefined>()
  const [selected, setSelected] = useState<AgentMemoryPage | undefined>()
  const [editing, setEditing] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [formError, setFormError] = useState<string>()
  const [draft, setDraft] = useState<{ title: string; kind: AgentMemoryPageKind; markdown: string }>({ title: '', kind: 'reference', markdown: '' })
  // 草稿基线固定在进入编辑那一刻的快照上：重读窗口与读取失败都会让 store 清空 page，
  // 未保存确认不能跟着漂移而被绕过。
  const [baseline, setBaseline] = useState<{ title: string; kind: AgentMemoryPageKind; markdown: string } | undefined>()

  useEffect(() => {
    if (!authed) { setOpenId(undefined); setSelected(undefined); setEditing(false); setDiscard(false); setFormError(undefined); return }
    void useAgentMemoryStore.getState().initialize(gateway)
    return () => useAgentMemoryStore.getState().reset()
  }, [gateway, authed])

  const runRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try { await useAgentMemoryStore.getState().refresh(gateway) } finally { setRefreshing(false) }
  }
  const open = (page: AgentMemoryPage) => {
    setSelected(page); setOpenId(page.id); setEditing(false); setDiscard(false); setFormError(undefined); setBaseline(undefined)
    useAgentMemoryStore.getState().clearError()
    void useAgentMemoryStore.getState().openPage(gateway, page.id)
  }
  // 保存在途时不关，避免「放弃修改」抢在保存回执之前把弹窗关掉。
  const close = () => {
    if (useAgentMemoryStore.getState().saving) return
    setOpenId(undefined); setSelected(undefined); setEditing(false); setDiscard(false); setFormError(undefined); setBaseline(undefined)
  }
  const page = state.page
  const dirty = editing && !!baseline && (draft.title !== baseline.title || draft.kind !== baseline.kind || draft.markdown !== baseline.markdown)
  const requestClose = () => {
    if (useAgentMemoryStore.getState().saving) return
    if (dirty) { setDiscard(true); return }
    close()
  }
  const startEdit = () => {
    const current = useAgentMemoryStore.getState().current
    if (!current) return
    const snapshot = { title: current.title, kind: current.kind === 'sources' ? 'reference' : current.kind, markdown: current.markdown }
    setDraft(snapshot); setBaseline(snapshot)
    setEditing(true); setDiscard(false); setFormError(undefined)
    useAgentMemoryStore.getState().clearError()
  }
  const submit = async () => {
    const store = useAgentMemoryStore.getState(), current = store.current
    if (!current) return
    if (!draft.title.trim()) { setFormError('请填写标题'); return }
    if (bytes(draft.markdown) > 16384) { setFormError('正文不能超过 16 KiB'); return }
    const ok = await store.savePage(gateway, { slug: current.slug, title: draft.title.trim(), markdown: draft.markdown, kind: draft.kind, maintenance: 'manual', expectedRevision: current.revision }, current.id)
    if (ok) { setEditing(false); setDiscard(false); setFormError(undefined) }
  }
  const reread = () => {
    const current = useAgentMemoryStore.getState().current
    if (current) void useAgentMemoryStore.getState().openPage(gateway, current.id)
  }

  if (!authed) return null
  const error = formError ?? state.error
  const over = bytes(draft.markdown) > 16384
  const spaceItems = state.spaces.map(space => ({ value: space.id, label: space.kind === 'global' ? `${space.name} · 共享` : space.name }))
  return <section aria-label="Wiki 页面浏览" className="flex flex-col gap-4">
    {state.loading && !state.spaces.length ? <LoadingState label="正在读取知识空间…" /> : <>
      <div className={`${CTL_TOOLBAR} rect-toolbar flex flex-wrap items-center gap-2 panel-surface px-4 py-3`}>
        <SelectDropdown ariaLabel="知识空间" items={spaceItems} value={state.spaceId || undefined} onSelect={id => { setFormError(undefined); void useAgentMemoryStore.getState().selectSpace(gateway, id) }} fallbackLabel="选择知识空间" emptyLabel="尚无知识空间" disabled={!state.spaces.length || state.loading} />
        <RefreshButton onPress={() => void runRefresh()} busy={refreshing} formControl />
      </div>
      {state.error && openId === undefined && <div role="alert" className="memory-error">{state.error}<button type="button" className={CTL_SECONDARY} onClick={() => void runRefresh()}>重试</button></div>}
      <div className="panel-surface overflow-hidden">
        <BusyVeil busy={refreshing} />
        {state.loading ? <p role="status" className="memory-empty">正在读取空间…</p>
          : !state.spaces.length ? <EmptyState title="尚无知识空间" />
          : !state.pages.length ? <EmptyState title="当前空间还没有页面" />
          : <ul aria-label="Wiki 页面列表" className="divide-y divide-line">
            {state.pages.map(item => <li key={item.id}>
              <button type="button" onClick={() => open(item)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-surface-raised">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
                <span className="text-xs text-fg-muted">{AGENT_MEMORY_PAGE_KIND_LABELS[item.kind]}</span>
                <span className="text-xs text-fg-subtle tabular-nums">r{item.revision}</span>
                <span className="text-xs text-fg-subtle">{item.maintenance === 'automatic' ? '自动维护' : '人工维护'}</span>
                <time dateTime={item.updatedAt} className="text-xs text-fg-subtle tabular-nums">{date(item.updatedAt)}</time>
                {item.status === 'withdrawn' && <span className="text-xs text-danger">已撤回</span>}
              </button>
            </li>)}
          </ul>}
      </div>
    </>}
    {openId !== undefined && <Dialog.Root open onOpenChange={next => { if (!next) requestClose() }}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
      {/* 浏览页弹窗被锁定：点外部与 Escape 都不关闭，关闭只走右上角 X、取消或保存完成后的路径。 */}
      <Dialog.Content onPointerDownOutside={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => event.preventDefault()} className="fixed left-1/2 top-1/2 z-[61] flex max-h-[90dvh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-line p-4"><div className="min-w-0"><Dialog.Title className="break-words text-base font-medium">{page?.title ?? selected?.title}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-fg-muted">{editing ? '保存会产生新修订，并切换为人工维护。冲突时保留当前草稿。' : page ? <span className="tabular-nums">{AGENT_MEMORY_PAGE_KIND_LABELS[page.kind]} · 修订 r{page.revision} · 更新于 {date(page.updatedAt)} · {page.maintenance === 'automatic' ? '自动维护' : '人工维护'}{page.status === 'withdrawn' ? ' · 已撤回' : ''}</span> : state.error ? '页面读取失败，可在下方重试。' : '正在读取页面…'}</Dialog.Description></div><IconButton label="关闭窗口" variant="ghost" onPress={requestClose}><X size={16} aria-hidden /></IconButton></header>
        {discard && <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line bg-warning/10 p-3 text-xs"><span className="flex-1">有未保存的内容。</span><button type="button" className={CTL_SECONDARY} onClick={() => setDiscard(false)}>继续编辑</button><button type="button" className={CTL_DANGER} onClick={close}>放弃修改</button></div>}
        <div className="memory-dialog-body hover-scrollbar"><fieldset disabled={state.saving} className="min-w-0">
          {state.reading ? <p role="status" className="memory-empty">正在读取文档…</p>
            : editing ? <form onSubmit={event => { event.preventDefault(); void submit() }}>
              {error && <div role="alert" className="mb-4 text-sm text-danger">{error}<button type="button" className={`${CTL_SECONDARY} mt-2`} onClick={reread}>读取最新修订并保留草稿</button></div>}
              <label className="memory-label">标题<input className={CTL_FIELD} value={draft.title} maxLength={200} onChange={event => setDraft({ ...draft, title: event.target.value })} autoFocus /></label>
              <label className="memory-label">页面类型<SelectDropdown ariaLabel="页面类型" items={KIND_OPTIONS} value={draft.kind} onSelect={kind => setDraft({ ...draft, kind })} fullWidth /></label>
              <label className="memory-label">Markdown 正文<textarea className="memory-editor" rows={12} value={draft.markdown} onChange={event => setDraft({ ...draft, markdown: event.target.value })} spellCheck={false} /></label>
              <p className={`mt-2 text-xs tabular-nums ${over ? 'text-danger' : 'text-fg-subtle'}`}>{bytes(draft.markdown)} / 16384 字节</p>
              {/* 旁注留在 label 之外，输入框的可访问名称只保留「页面标识」。 */}
              <div className="memory-label"><label htmlFor="wiki-page-slug">页面标识</label><input id="wiki-page-slug" className={`${CTL_FIELD} font-mono`} value={(page ?? selected)?.slug ?? ''} readOnly /><span className="text-xs text-fg-subtle">创建后不可修改</span></div>
              <div className="mt-5 flex justify-end gap-2"><button type="button" className={CTL_SECONDARY} onClick={requestClose} disabled={state.saving}>取消</button><button className={CTL_PRIMARY} disabled={state.saving || over || !draft.title.trim()}>{state.saving ? '保存中…' : '保存页面'}</button></div>
            </form>
            : page ? <div>
              <div className="memory-markdown"><ChatMarkdown text={page.markdown} /></div>
              {page.status === 'active' && page.kind !== 'sources' && <div className="mt-6 flex justify-end gap-2 border-t border-line pt-4"><button type="button" className={CTL_SECONDARY} disabled={state.saving} onClick={startEdit}>编辑</button></div>}
            </div>
            : state.error ? <div className="memory-empty"><p role="alert" className="text-danger">{state.error}</p><button type="button" className={`${CTL_SECONDARY} mt-2`} disabled={state.saving} onClick={() => { if (selected) void useAgentMemoryStore.getState().openPage(gateway, selected.id) }}>重试</button></div>
            : <p className="memory-empty">页面尚未读取，请刷新后重试。</p>}
        </fieldset></div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>}
  </section>
}
