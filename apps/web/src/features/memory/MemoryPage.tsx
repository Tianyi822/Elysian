import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AGENT_MEMORY_PAGE_KIND_LABELS, RUNTIME_RUN_STATUS_LABELS, runtimeRunIsActive } from '@elysian/contracts'
import type { AgentMemoryPage, AgentMemoryPageInput, AgentMemoryProposal, AgentModelProfile, AgentWikiRef } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { BookOpen, Loader2, Plus, RefreshCw, X } from '../../components/icons'
import { IconButton } from '../../components/IconButton'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_DANGER, CTL_FIELD } from '../../components/formControl'
import { ChatMarkdown } from '../agent/ChatMarkdown'
import { useAgentMemoryStore } from '../../stores/agentMemoryStore'
import { useSessionStore } from '../../stores/sessionStore'
import './memory.css'

const bytes = (value: string) => new TextEncoder().encode(value).length
const pageInput = (page: AgentMemoryPage): AgentMemoryPageInput => ({ slug: page.slug, title: page.title, markdown: page.markdown, kind: page.kind, maintenance: page.maintenance ?? 'manual', evidence: page.evidence, sources: page.sources, tags: page.tags, aliases: page.aliases, expiresAt: page.expiresAt })
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false })
const proposalReason = (reason?: string, pageId?: string) => {
  switch (reason) {
    case 'semantic-conflict': return '新内容与已有知识存在冲突，请核对后决定是否采纳。'
    case 'manual-protection': return '此页面由人工维护，自动整理的修改需要你确认。'
    case 'revision-conflict': return '页面在整理期间已更新，请核对当前版本后处理。'
    case 'wiki-slug-conflict': return '空间中已有相同标识的页面，请核对重复内容。'
    default: return pageId ? '此页面的修改需要人工复核。' : '新页面需要人工确认。'
  }
}

function MemoryDialog({ title, description, children, close, blocked = false, saving = false }: { title: string; description: string; children: ReactNode; close(): void; blocked?: boolean; saving?: boolean }) {
  const [discard, setDiscard] = useState(false)
  const requestClose = () => blocked ? setDiscard(true) : close()
  return <Dialog.Root open onOpenChange={open => { if (!open) requestClose() }}><Dialog.Portal>
    <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
    <Dialog.Content onPointerDownOutside={event => { if (blocked) event.preventDefault() }} onEscapeKeyDown={event => { if (blocked) { event.preventDefault(); setDiscard(true) } }} className="fixed left-1/2 top-1/2 z-[61] flex max-h-[90dvh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface shadow-xl">
      <header className="flex items-start justify-between gap-3 border-b border-line p-4"><div><Dialog.Title className="text-base font-medium">{title}</Dialog.Title><Dialog.Description className="mt-1 text-xs text-fg-muted">{description}</Dialog.Description></div><IconButton label="关闭窗口" variant="ghost" onPress={requestClose}><X size={16} aria-hidden /></IconButton></header>
      {discard && <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-line bg-warning/10 p-3 text-xs"><span className="flex-1">有未保存的内容。</span><button type="button" className={CTL_SECONDARY} onClick={() => setDiscard(false)}>继续编辑</button><button type="button" className={CTL_DANGER} onClick={close}>放弃修改</button></div>}
      <div className="memory-dialog-body hover-scrollbar"><fieldset disabled={saving}>{children}</fieldset></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>
}

function ProposalReview({ proposal, saving, decide }: { proposal: AgentMemoryProposal; saving: boolean; decide(decision: 'approved' | 'rejected', expectedRevision?: number): Promise<boolean> }) {
  const gateway = useGateway()
  // 复核内容固定到用户看到的版本，后台轮询不能悄悄替换采纳的基准。
  const [current, setCurrent] = useState(proposal.currentPage)
  const [reading, setReading] = useState(false)
  const [mustReload, setMustReload] = useState(false)
  const [error, setError] = useState<string>()
  const request = useRef(0)
  useEffect(() => () => { request.current++ }, [])
  const reload = async () => {
    if (!proposal.pageId) return
    const read = ++request.current, epoch = captureAuthGeneration()
    setReading(true); setError(undefined)
    try {
      const page = await gateway.agentMemory.getPage(proposal.spaceId, proposal.pageId)
      if (read !== request.current || epoch !== captureAuthGeneration() || useSessionStore.getState().phase !== 'authed') return
      setCurrent(page); setMustReload(false)
    } catch (error) { if (read === request.current && epoch === captureAuthGeneration()) setError(error instanceof Error ? error.message : '读取当前版本失败') }
    finally { if (read === request.current && epoch === captureAuthGeneration()) setReading(false) }
  }
  const approve = async () => {
    const ok = await decide('approved', proposal.pageId ? current?.revision : 0)
    if (!ok && proposal.pageId) { setMustReload(true); setError('尚未确认采纳。请重新读取当前版本，核对后再提交。') }
  }
  const available = !proposal.pageId || !!current && current.status === 'active' && current.kind !== 'sources'
  return <div className="memory-evidence">
    <h4 className="text-sm font-medium">{proposal.page.title}</h4>
    <p className="mt-2 text-xs text-fg-muted">{proposalReason(proposal.reason, proposal.pageId)}</p>
    {proposal.pageId && <section className="mt-3 rounded border border-line p-3" aria-label="当前页面内容">
      <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="text-xs font-medium">{current ? `当前页面 · 修订 ${current.revision}` : '尚未读取当前页面'}</h5><button type="button" className={CTL_SECONDARY} disabled={saving || reading} onClick={() => void reload()}>{reading ? '正在读取…' : '重新读取当前版本'}</button></div>
      {current && <><p className="mt-2 text-xs text-fg-muted">{current.title}</p><div className="memory-proposal-preview"><ChatMarkdown text={current.markdown} /></div></>}
      {current?.status === 'withdrawn' ? <p className="mt-2 text-xs text-danger">当前页面已撤回，不能采纳此修改。</p> : current?.kind === 'sources' ? <p className="mt-2 text-xs text-danger">导入原文不可改写，不能采纳此修改。</p> : null}
    </section>}
    <section className="mt-3 rounded border border-line p-3" aria-label="建议页面内容"><h5 className="text-xs font-medium">建议内容</h5><div className="memory-proposal-preview"><ChatMarkdown text={proposal.page.markdown} /></div></section>
    {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={CTL_PRIMARY} disabled={saving || reading || !available || mustReload} onClick={() => void approve()}>{proposal.pageId ? current ? `基于修订 ${current.revision} 采纳` : '采纳修改' : '采纳新页面'}</button><button type="button" className={CTL_SECONDARY} disabled={saving || reading} onClick={() => void decide('rejected')}>拒绝</button></div>
  </div>
}

export function MemoryPage() {
  const gateway = useGateway()
  const state = useAgentMemoryStore()
  const authed = useSessionStore(s => s.phase === 'authed')
  const [params, setParams] = useSearchParams()
  const preferredSpace = useRef(params.get('space') ?? undefined)
  preferredSpace.current = params.get('space') ?? undefined
  const [query, setQuery] = useState('')
  const [panel, setPanel] = useState<'sources' | 'versions' | 'jobs' | 'proposals'>('sources')
  const [dialog, setDialog] = useState<'space' | 'page' | 'edit' | 'import' | 'withdraw' | 'rollback' | undefined>()
  const [name, setName] = useState('')
  const [draft, setDraft] = useState<AgentMemoryPageInput>({ slug: '', title: '', markdown: '', kind: 'reference', maintenance: 'manual' })
  const [source, setSource] = useState({ title: '', text: '', filename: '', modelId: '' })
  const [models, setModels] = useState<readonly AgentModelProfile[]>([])
  const [modelError, setModelError] = useState<string>()
  const [formError, setFormError] = useState<string>()
  const [modelAttempt, setModelAttempt] = useState(0)
  const pendingSource = useRef<{ key: string; requestId: string } | undefined>(undefined)
  const deepLinkRead = useRef('')

  useEffect(() => {
    if (!authed) { setDialog(undefined); setModels([]); setSource({ title: '', text: '', filename: '', modelId: '' }); setDraft({ slug: '', title: '', markdown: '', kind: 'reference', maintenance: 'manual' }); setName(''); setQuery(''); setFormError(undefined); pendingSource.current = undefined; deepLinkRead.current = ''; return }
    void state.initialize(gateway, preferredSpace.current)
    return () => useAgentMemoryStore.getState().reset()
  }, [gateway, authed]) // 初始化只消费地址中的空间，之后由工作台保持选择。
  useEffect(() => {
    if (!authed) return
    let cancelled = false
    setModelError(undefined)
    gateway.modelSettings.listModelProfiles().then(models => { if (!cancelled && useSessionStore.getState().phase === 'authed') setModels(models.filter(model => model.active && model.hasCredential && model.capabilities.text && model.capabilities.tools)) }).catch((error: unknown) => { if (!cancelled) setModelError(error instanceof Error ? error.message : '读取模型失败') })
    return () => { cancelled = true }
  }, [gateway, authed, modelAttempt])
  useEffect(() => {
    if (!authed || !state.spaceId) return
    const timer = setTimeout(() => void state.search(gateway, query), 250)
    return () => clearTimeout(timer)
  }, [gateway, authed, state.spaceId, query])
  useEffect(() => {
    const id = params.get('page'), sid = params.get('space'), revision = Number(params.get('revision')) || undefined
    if (!authed || !id || sid !== state.spaceId || state.loading) return
    const key = `${sid}/${id}/${revision ?? ''}`
    if (deepLinkRead.current === key) return
    deepLinkRead.current = key
    void state.openPage(gateway, id, revision)
  }, [gateway, authed, params, state.spaceId, state.loading])
  useEffect(() => {
    if (!authed || !state.jobs.some(job => runtimeRunIsActive(job.status))) return
    const timer = setInterval(() => void state.refresh(gateway), 2500)
    return () => clearInterval(timer)
  }, [gateway, authed, state.jobs])

  const navigatePage = (page: AgentMemoryPage, revision?: number) => {
    const selected = useAgentMemoryStore.getState()
    const alreadyOpen = selected.page?.id === page.id && selected.page.spaceId === page.spaceId && selected.page.revision === (revision ?? selected.current?.revision)
    deepLinkRead.current = alreadyOpen ? `${page.spaceId}/${page.id}/${revision ?? ''}` : ''
    setParams({ space: page.spaceId, page: page.id, ...(revision ? { revision: String(revision) } : {}) })
    if (page.spaceId !== selected.spaceId) void selected.selectSpace(gateway, page.spaceId)
  }
  const openRef = async (ref: AgentWikiRef) => { const epoch = captureAuthGeneration(); try { const page = await gateway.agentMemory.getReference(ref); if (epoch === captureAuthGeneration() && useSessionStore.getState().phase === 'authed') navigatePage(page, ref.revision) } catch (error) { if (epoch === captureAuthGeneration()) setFormError(error instanceof Error ? error.message : '读取来源失败') } }
  const openDialog = (kind: typeof dialog) => { setFormError(undefined); state.clearError(); setName(''); if (kind === 'page') setDraft({ slug: '', title: '', markdown: '', kind: 'reference', maintenance: 'manual' }); if (kind === 'edit' && state.current) setDraft({ ...pageInput(state.current), maintenance: 'manual' }); setDialog(kind) }
  const closeDialog = () => { if (!state.saving) { setDialog(undefined); setFormError(undefined) } }
  const submitPage = async () => {
    if (!draft.title.trim() || !draft.slug.trim()) { setFormError('请填写标题与页面标识'); return }
    if (bytes(draft.markdown) > 16384) { setFormError('正文不能超过 16 KiB'); return }
    const editing = dialog === 'edit' ? state.current : undefined
    const ok = await state.savePage(gateway, { ...draft, title: draft.title.trim(), ...(editing ? { expectedRevision: editing.revision } : {}), maintenance: 'manual' }, editing?.id)
    if (ok) { setDialog(undefined); const current = useAgentMemoryStore.getState().current; if (current) navigatePage(current) }
  }
  const submitSource = async () => {
    const model = models.find(model => model.id === source.modelId)
    if (!source.title.trim() || !source.text.trim() || !model) { setFormError('请填写资料标题、正文并选择整理模型'); return }
    if (bytes(source.text) > 16384) { setFormError('单份资料不能超过 16 KiB'); return }
    const key = JSON.stringify({ ...source, modelRevision: model.revision, spaceId: state.spaceId })
    if (pendingSource.current?.key !== key) pendingSource.current = { key, requestId: crypto.randomUUID() }
    const ok = await state.importSource(gateway, { requestId: pendingSource.current.requestId, title: source.title.trim(), text: source.text, ...(source.filename ? { filename: source.filename } : {}), modelProfileId: model.id, modelProfileRevision: model.revision })
    if (ok) { pendingSource.current = undefined; setDialog(undefined); setSource({ title: '', text: '', filename: '', modelId: source.modelId }); setPanel('jobs'); const current = useAgentMemoryStore.getState().current; if (current) navigatePage(current) }
  }
  const readFile = async (file?: File) => {
    if (!file) return
    if (!/\.(md|txt)$/i.test(file.name)) { setFormError('只支持 .md 或 .txt 文件'); return }
    if (file.size > 16384) { setFormError('单份资料不能超过 16 KiB'); return }
    const epoch = captureAuthGeneration()
    try { const content = await file.arrayBuffer(); const text = new TextDecoder('utf-8', { fatal: true }).decode(content); if (epoch !== captureAuthGeneration() || !authed) return; setSource(previous => ({ ...previous, filename: file.name, title: previous.title || file.name.replace(/\.(md|txt)$/i, ''), text })); setFormError(undefined) } catch { if (epoch === captureAuthGeneration() && useSessionStore.getState().phase === 'authed') setFormError('文件必须是 UTF-8 文本') }
  }
  const page = state.page, current = state.current, historical = !!page && !!current && page.revision !== current.revision
  const visiblePages = state.searchResults ?? state.pages
  const jobs = state.jobs.filter(job => job.spaceId === state.spaceId)
  const error = formError ?? state.error
  if (!authed) return null
  return <section aria-label="知识 Wiki 工作台" className="memory-workspace">
    <div className="memory-toolbar"><div className="min-w-0"><h2 className="flex items-center gap-2 text-base font-medium"><BookOpen size={18} aria-hidden />知识 Wiki</h2><p className="mt-1 text-xs text-fg-muted">资料与聊天事实整理为主题页面，保留来源与每次修订。</p></div><div className="flex flex-wrap gap-2"><Link className={CTL_SECONDARY} to="/agent">返回聊天</Link><button type="button" className={CTL_SECONDARY} disabled={!state.spaceId || state.saving} onClick={() => openDialog('import')}>导入资料</button><button type="button" className={CTL_PRIMARY} disabled={!state.spaceId || state.saving} onClick={() => openDialog('page')}><Plus size={14} aria-hidden />新建页面</button></div></div>
    {error && !dialog && <div role="alert" className="memory-error">{error}<button type="button" className={CTL_SECONDARY} onClick={() => { setFormError(undefined); void state.refresh(gateway) }}>重试读取</button></div>}
    <div className="memory-columns">
      <aside aria-label="Wiki 页面目录" className="memory-sidebar">
        <div className="flex items-center gap-2"><label className="sr-only" htmlFor="memory-space">知识空间</label><select id="memory-space" className={`${CTL_FIELD} min-w-0 flex-1`} value={state.spaceId} disabled={state.saving} onChange={event => { setQuery(''); deepLinkRead.current = ''; setParams({ space: event.target.value }); void state.selectSpace(gateway, event.target.value) }}><option value="" disabled>选择空间</option>{state.spaces.map(space => <option key={space.id} value={space.id}>{space.name}{space.kind === 'global' ? ' · 共享' : ''}</option>)}</select><IconButton label="新建知识空间" onPress={() => openDialog('space')} disabled={state.saving}><Plus size={15} aria-hidden /></IconButton><IconButton label="刷新知识空间" onPress={() => void state.refresh(gateway)} disabled={state.loading || state.saving}><RefreshCw size={14} aria-hidden /></IconButton></div>
        <input type="search" aria-label="搜索当前知识空间" placeholder="搜索页面标题与正文" value={query} onChange={event => setQuery(event.target.value)} className={`${CTL_FIELD} mt-3 w-full`} />
        <div className="mt-3 flex items-center justify-between text-xs text-fg-subtle"><span>{visiblePages.length} 个页面</span>{state.searching && <span role="status">搜索中…</span>}</div>
        <nav aria-label="知识页面" className="memory-page-list hover-scrollbar">{state.loading ? <p role="status" className="memory-empty">正在读取空间…</p> : visiblePages.length ? visiblePages.map(item => <button type="button" key={item.id} onClick={() => navigatePage(item)} aria-current={page?.id === item.id ? 'page' : undefined} className="memory-page-row"><span className="block truncate text-sm">{item.title}</span><span className="mt-1 block text-xs text-fg-subtle">{AGENT_MEMORY_PAGE_KIND_LABELS[item.kind]} · r{item.revision}{item.status === 'withdrawn' ? ' · 已撤回' : ''}</span></button>) : <p className="memory-empty">{query ? '没有匹配的页面' : '尚无页面，可以导入资料或新建页面。'}</p>}</nav>
      </aside>
      <article aria-label="Wiki 文档" className="memory-document hover-scrollbar">
        {state.reading ? <p role="status" className="memory-empty">正在读取文档…</p> : page ? <>
          <header className="memory-document-header"><div className="min-w-0"><p className="mb-2 text-xs text-fg-subtle">{AGENT_MEMORY_PAGE_KIND_LABELS[page.kind]} · {page.maintenance === 'automatic' ? '自动维护' : '人工维护'}</p><h3 className="break-words text-xl font-medium">{page.title}</h3><p className="mt-2 text-xs text-fg-subtle">修订 {page.revision} · {date(page.updatedAt)}</p></div><div className="flex flex-wrap gap-2">{!historical && current?.status === 'active' && current.kind !== 'sources' && <button type="button" className={CTL_SECONDARY} disabled={state.saving} onClick={() => openDialog('edit')}>编辑</button>}<button type="button" className={CTL_SECONDARY} onClick={() => setPanel('versions')}>版本记录</button></div></header>
          {page.status === 'withdrawn' || current?.status === 'withdrawn' ? <p role="status" className="memory-notice text-danger">此页面已撤回，保留历史以供查证，不能继续作为知识来源。</p> : historical ? <div className="memory-notice"><p>正在查看固定历史修订 {page.revision}。</p><button type="button" className={CTL_SECONDARY} onClick={() => navigatePage(current!)}>返回当前版本</button>{current?.kind !== 'sources' && <button type="button" className={CTL_SECONDARY} disabled={state.saving} onClick={() => openDialog('rollback')}>回退到此版本</button>}</div> : null}
          <div className="memory-markdown"><ChatMarkdown text={page.markdown} /></div>
          {!!page.links.length && <div className="mt-8 border-t border-line pt-4"><h4 className="text-xs text-fg-muted">关联页面</h4><div className="mt-2 flex flex-wrap gap-2">{page.links.map(id => { const linked = state.pages.find(item => item.id === id); return linked ? <button type="button" key={id} className={CTL_SECONDARY} onClick={() => navigatePage(linked)}>{linked.title}</button> : <span key={id} className="text-xs text-fg-subtle">未解析：{id}</span> })}</div></div>}
        </> : <div className="memory-document-empty"><BookOpen size={28} className="text-fg-subtle" aria-hidden /><h3 className="mt-4 text-sm font-medium">选择一篇文档</h3><p className="mt-2 text-xs text-fg-muted">在左侧浏览或搜索，右侧查看来源、修订与整理记录。</p>{!state.spaces.length && !state.loading && <button type="button" className={`${CTL_PRIMARY} mt-4`} onClick={() => openDialog('space')}>创建知识空间</button>}</div>}
      </article>
      <aside aria-label="Wiki 辅助信息" className="memory-inspector">
        <div role="group" aria-label="Wiki 辅助面板" className="memory-inspector-tabs">{([['sources', '来源'], ['versions', '版本'], ['jobs', '整理记录'], ['proposals', '待确认']] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={panel === id} onClick={() => setPanel(id)}>{label}{id === 'proposals' && state.proposals.length ? ` ${state.proposals.length}` : ''}</button>)}</div>
        <div className="memory-inspector-body hover-scrollbar">
          {panel === 'sources' && (page ? <><p className="mb-4 text-xs text-fg-subtle">来源固定到修订与摘要，更新不会改写历史引用。</p>{page.sources.map(ref => <button type="button" key={`${ref.pageId}:${ref.revision}`} className="memory-ref" onClick={() => void openRef(ref)}>{state.pages.find(item => item.id === ref.pageId)?.title ?? ref.pageId}<span className="block text-xs text-fg-subtle">修订 {ref.revision} · {ref.digest.slice(0, 12)}</span></button>)}{page.evidence.map(evidence => <div key={evidence.id} className="memory-evidence"><p className="text-xs text-fg-subtle">{evidence.kind}{evidence.runId ? ` · Run ${evidence.runId}` : ''}</p><p className="mt-2 whitespace-pre-wrap break-words text-xs">{evidence.text}</p>{evidence.originalCleared && <p className="mt-2 text-xs text-fg-subtle">原始内容已清理，此处保留来源摘录。</p>}{evidence.uri && <p className="mt-2 break-all text-xs text-fg-subtle">{evidence.uri}</p>}</div>)}{!page.sources.length && !page.evidence.length && <p className="memory-empty">{page.kind === 'sources' ? '此页保存导入原文。' : '此页没有关联来源。'}</p>}</> : <p className="memory-empty">选择页面后查看来源。</p>)}
          {panel === 'versions' && <>{current?.status === 'active' && <div className="mb-4 border-b border-line pb-4">{current.kind === 'sources' ? <p className="text-xs text-fg-muted">导入原文不可改写；更新资料请重新导入。</p> : <><p className="text-xs text-fg-muted">人工编辑后暂停自动改写；可随时恢复自动维护。</p><button type="button" className={`${CTL_SECONDARY} mt-2`} disabled={state.saving} onClick={() => void state.savePage(gateway, { ...pageInput(current), expectedRevision: current.revision, maintenance: current.maintenance === 'automatic' ? 'manual' : 'automatic' }, current.id)}>{current.maintenance === 'automatic' ? '改为人工维护' : '恢复自动维护'}</button></>}<button type="button" className={`${CTL_DANGER} mt-2`} disabled={state.saving} onClick={() => openDialog('withdraw')}>撤回页面</button></div>}{state.revisions.length ? state.revisions.map(revision => <button type="button" key={revision.revision} className="memory-ref" onClick={() => navigatePage(revision, revision.revision)} aria-current={revision.revision === page?.revision ? 'true' : undefined}><span className="block text-sm">修订 {revision.revision}{revision.revision === current?.revision ? ' · 当前' : ''}</span><span className="mt-1 block text-xs text-fg-subtle">{date(revision.updatedAt)}</span><span className="mt-1 block text-xs text-fg-subtle">{revision.maintenance === 'automatic' ? '自动维护' : '人工维护'} · {revision.status === 'withdrawn' ? '已撤回' : '有效'}</span></button>) : <p className="memory-empty">选择页面后查看版本。</p>}</>}
          {panel === 'jobs' && <>{jobs.length ? jobs.map(job => <div className="memory-evidence" key={job.id}><div className="flex items-center justify-between gap-2"><span className="text-sm">{job.originKind === 'source' ? '资料整理' : '聊天整理'}</span><span className={`text-xs ${job.status === 'failed' || job.status === 'interrupted' ? 'text-danger' : job.status === 'succeeded' ? 'text-success' : 'text-fg-muted'}`}>{RUNTIME_RUN_STATUS_LABELS[job.status]}</span></div><p className="mt-2 text-xs text-fg-subtle">{date(job.createdAt)} · {job.model.model}</p>{job.error && <p className="mt-2 text-xs text-danger">{job.error.message}</p>}<p className="mt-2 text-xs text-fg-muted">已发布 {job.publishedRefs?.length ?? 0} 页 · 待确认 {job.candidateIds.length} 项</p>{job.publishedRefs?.map(ref => <button key={`${ref.pageId}:${ref.revision}`} type="button" className={`${CTL_SECONDARY} mt-2`} onClick={() => void openRef(ref)}>{state.pages.find(page => page.id === ref.pageId)?.title ?? ref.pageId} · r{ref.revision}</button>)}</div>) : <p className="memory-empty">当前空间尚无整理记录。</p>}{state.jobsHasMore && <button type="button" className={CTL_SECONDARY} onClick={() => void state.moreJobs(gateway)}>加载更多整理记录</button>}</>}
          {panel === 'proposals' && <>{state.proposals.length ? state.proposals.map(proposal => <ProposalReview key={proposal.id} proposal={proposal} saving={state.saving} decide={(decision, expectedRevision) => state.decide(gateway, proposal.id, decision, expectedRevision)} />) : <p className="memory-empty">没有待确认的修改。</p>}</>}
        </div>
      </aside>
    </div>
    {dialog && <MemoryDialog title={({ space: '新建知识空间', page: '新建页面', edit: '编辑页面', import: '导入资料', withdraw: '撤回页面', rollback: '回退页面版本' })[dialog]} description={({ space: '空间用于归集同一项目或业务的知识。', page: '新页面由人工维护，正文支持 Markdown。', edit: '保存会产生新修订，并切换为人工维护。冲突时保留当前草稿。', import: '导入 UTF-8 .md / .txt 或粘贴文本，单份最多 16 KiB；原文单独保留，由所选模型后台整理。', withdraw: '撤回会使依赖此页的知识与回答来源失效，并阻止相关执行继续使用。', rollback: '将此历史版本保存为新的人工修订，完整保留现有版本记录。' })[dialog]} close={closeDialog} saving={state.saving} blocked={state.saving || dialog === 'edit' || (dialog === 'page' && !!(draft.title || draft.markdown)) || (dialog === 'import' && !!source.text)}>
      {error && <div role="alert" className="mb-4 text-sm text-danger">{error}{dialog === 'edit' && current && <button type="button" className={`${CTL_SECONDARY} mt-2`} onClick={() => void state.openPage(gateway, current.id)}>读取最新修订并保留草稿</button>}</div>}
      {dialog === 'space' && <form onSubmit={event => { event.preventDefault(); if (!name.trim()) { setFormError('请输入空间名称'); return }; void state.createSpace(gateway, name.trim()).then(ok => { if (ok) { setDialog(undefined); setParams({ space: useAgentMemoryStore.getState().spaceId }) } }) }}><label className="memory-label">空间名称<input className={CTL_FIELD} value={name} maxLength={120} onChange={event => setName(event.target.value)} autoFocus /></label><button className={`${CTL_PRIMARY} mt-5`} disabled={state.saving}>创建空间</button></form>}
      {(dialog === 'page' || dialog === 'edit') && <form onSubmit={event => { event.preventDefault(); void submitPage() }}><label className="memory-label">标题<input className={CTL_FIELD} value={draft.title} maxLength={200} onChange={event => setDraft({ ...draft, title: event.target.value })} /></label><label className="memory-label">页面标识<input className={CTL_FIELD} value={draft.slug} readOnly={dialog === 'edit'} onChange={event => setDraft({ ...draft, slug: event.target.value })} placeholder="例如 operations/nginx" />{dialog === 'edit' && <span className="text-xs text-fg-subtle">创建后不可修改</span>}</label><label className="memory-label">页面类型<select className={CTL_FIELD} value={draft.kind} onChange={event => setDraft({ ...draft, kind: event.target.value as AgentMemoryPage['kind'] })}>{Object.entries(AGENT_MEMORY_PAGE_KIND_LABELS).filter(([kind]) => kind !== 'sources').map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></label><label className="memory-label">Markdown 正文<textarea className="memory-editor" rows={12} value={draft.markdown} onChange={event => setDraft({ ...draft, markdown: event.target.value })} spellCheck={false} /></label><p className={`mt-2 text-xs ${bytes(draft.markdown) > 16384 ? 'text-danger' : 'text-fg-subtle'}`}>{bytes(draft.markdown)} / 16384 字节</p><div className="mt-5 flex justify-end gap-2"><button type="button" className={CTL_SECONDARY} onClick={closeDialog} disabled={state.saving}>取消</button><button className={CTL_PRIMARY} disabled={state.saving}>{state.saving ? '保存中…' : '保存页面'}</button></div></form>}
      {dialog === 'import' && <form onSubmit={event => { event.preventDefault(); void submitSource() }}><label className="memory-label">选择文件<input type="file" accept=".md,.txt,text/markdown,text/plain" disabled={state.saving} onChange={event => { void readFile(event.target.files?.[0]); event.target.value = '' }} className="text-xs" /></label><label className="memory-label">资料标题<input className={CTL_FIELD} value={source.title} maxLength={200} onChange={event => setSource({ ...source, title: event.target.value })} /></label><label className="memory-label">粘贴或编辑原文<textarea className="memory-editor" rows={10} value={source.text} onChange={event => setSource({ ...source, text: event.target.value, filename: '' })} spellCheck={false} /></label><p className={`mt-2 text-xs ${bytes(source.text) > 16384 ? 'text-danger' : 'text-fg-subtle'}`}>{bytes(source.text)} / 16384 字节</p><label className="memory-label">整理模型<select className={CTL_FIELD} value={source.modelId} onChange={event => setSource({ ...source, modelId: event.target.value })}><option value="">选择已配置的模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.model} · 修订 {model.revision}</option>)}</select></label>{modelError ? <div role="alert" className="mt-2 text-xs text-danger">{modelError}<button type="button" className={`${CTL_SECONDARY} ml-2`} onClick={() => setModelAttempt(attempt => attempt + 1)}>重试模型目录</button></div> : !models.length ? <p className="mt-2 text-xs text-fg-muted">请先在<Link to="/settings?tab=models" className="text-accent">系统设置</Link>配置支持文本与工具调用的模型。</p> : null}<div className="mt-5 flex justify-end gap-2"><button type="button" className={CTL_SECONDARY} onClick={closeDialog} disabled={state.saving}>取消</button><button className={CTL_PRIMARY} disabled={state.saving || !models.length}>{state.saving ? <><Loader2 size={14} aria-hidden className="animate-spin" />提交中…</> : '保存并开始整理'}</button></div></form>}
      {dialog === 'withdraw' && <div><p className="text-sm">确认撤回「{current?.title}」？历史版本仍可查阅。</p><div className="mt-5 flex justify-end gap-2"><button type="button" className={CTL_SECONDARY} onClick={closeDialog} disabled={state.saving}>取消</button><button type="button" className={CTL_DANGER} disabled={state.saving} onClick={() => void state.withdraw(gateway).then(ok => { if (ok) setDialog(undefined) })}>确认撤回</button></div></div>}
      {dialog === 'rollback' && page && current && <div><p className="text-sm">用修订 {page.revision} 的内容创建新修订（当前为修订 {current.revision}）。</p><div className="mt-5 flex justify-end gap-2"><button type="button" className={CTL_SECONDARY} onClick={closeDialog} disabled={state.saving}>取消</button><button type="button" className={CTL_PRIMARY} disabled={state.saving} onClick={() => void state.savePage(gateway, { ...pageInput(page), expectedRevision: current.revision, maintenance: 'manual' }, current.id).then(ok => { if (ok) { setDialog(undefined); const latest = useAgentMemoryStore.getState().current; if (latest) navigatePage(latest) } })}>确认回退</button></div></div>}
    </MemoryDialog>}
  </section>
}
