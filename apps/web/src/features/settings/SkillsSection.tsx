import { useEffect, useRef, useState } from 'react'
import { useMessageStore } from '../../stores/messageStore'
import { randomId } from '../../utils/randomId'
import type { AgentCapabilityRevocation, AgentSkill, AgentSkillImportInput, AgentSkillImportTask } from '@elysian/contracts'
import { formatLogBytes } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { AgentHttpError } from '../../adapters/http/agent/agentShared'
import { useAgentExtensionsStore, selectImportsActive } from '../../stores/agentExtensionsStore'
import { CTL_DANGER, CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { Plus, History } from '../../components/icons'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { StatusTag, type StatusTone } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { ChipGroup } from '../../components/ChipGroup'
import { CopyButton } from '../../components/CopyButton'
import { formatDateTime } from '../../components/format'
import { useFeedbackMessage } from '../../components/useFeedbackMessage'
import { ExtensionDialog, ExtensionSearch, ExtensionTable, ExtensionToggle, ExtensionMenu, Field, extensionCell as cell } from './extensionUi'
import { RevisionConflictNotice } from './RevisionConflictNotice'
import { useSilentPolling } from './useSilentPolling'
import { useInFlightSubmit } from './useInFlightSubmit'

const sourceLabels = { zip: 'ZIP 上传', git: 'HTTPS Git', directory: '服务器目录' }
const importLabels: Record<AgentSkillImportTask['state'], { label: string; tone: StatusTone }> = {
  queued: { label: '排队中', tone: 'neutral' }, running: { label: '导入中', tone: 'info' }, succeeded: { label: '成功', tone: 'success' }, failed: { label: '失败', tone: 'danger' }, cancelled: { label: '已取消', tone: 'neutral' }, interrupted: { label: '已中断', tone: 'warning' },
}
const terminal = (task: AgentSkillImportTask) => !['queued', 'running'].includes(task.state)
function sourceText(source: AgentSkill['source']) { return source.kind === 'zip' ? 'ZIP 上传' : source.kind === 'git' ? `${source.url} · ${source.ref}` : source.path ?? '服务器目录' }

export function SkillsSection({ active }: { active: boolean }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const importsActive = selectImportsActive(state)
  const [search, setSearch] = useState('')
  const [importTarget, setImportTarget] = useState<AgentSkill | 'new'>()
  const [importOpen, setImportOpen] = useState(false)
  const [pendingImport, setPendingImport] = useState(false)
  const [recordsOpen, setRecordsOpen] = useState(false)
  useEffect(() => { void state.loadSkills(gateway); void state.loadImports(gateway) }, [gateway, state.loadSkills, state.loadImports])
  const { degraded } = useSilentPolling(signal => state.pollImports(gateway, signal), { intervalMs: 3000, enabled: importsActive })
  useFeedbackMessage(active && degraded ? '导入状态连接中断，正在重试' : null, 'warning')
  useFeedbackMessage(active && state.skillsStatus === 'ready' ? state.skillsErrorMessage : null)
  const startImport = (target: AgentSkill | 'new') => { if (!pendingImport && (target !== 'new' || importTarget !== 'new')) setImportTarget(target); setImportOpen(true) }
  const rows = state.skills.filter(skill => [skill.manifest.name, skill.manifest.description, sourceText(skill.source)].some(value => value.toLowerCase().includes(search.trim().toLowerCase())))
  const running = state.imports.filter(task => !terminal(task)).length
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><button type="button" className={CTL_PRIMARY} onClick={() => startImport('new')}><Plus aria-hidden size={14} />{pendingImport ? '核对上次导入' : '导入 Skill'}</button><ExtensionSearch label="搜索 Skill 名称、描述或来源" value={search} onChange={setSearch} /><button type="button" className={CTL_SECONDARY} onClick={() => setRecordsOpen(true)}><History aria-hidden size={14} />导入记录{running > 0 ? `（${running} 进行中）` : ''}</button><RefreshButton label="刷新 Skill 配置" busy={state.skillsRefreshing} onPress={() => void state.loadSkills(gateway)} /></div>
    <div className="busy-host relative"><BusyVeil busy={state.skillsRefreshing} />
      {state.skillsStatus === 'idle' || state.skillsStatus === 'loading' ? <LoadingState label="正在读取 Skill 配置…" /> : state.skillsStatus === 'error' ? <ErrorState title="Skill 配置读取失败" description={state.skillsErrorMessage} onRetry={() => void state.loadSkills(gateway)} /> : rows.length === 0 ? <EmptyState title={search ? '没有匹配的 Skill' : '还没有导入的 Skill'} description={search ? '换个关键词，或清空搜索查看全部 Skill。' : '从 ZIP、HTTPS Git 或服务器目录导入包含 SKILL.md 的技能包。'} /> :
        <>{state.skillsErrorMessage && <p role="alert" className="mb-2 text-xs text-danger">刷新失败：{state.skillsErrorMessage}；当前保留的是上次读取结果。</p>}<ExtensionTable label="Skill 配置列表" columns={[{ label: '名称与描述', width: '32%' }, { label: '来源', width: '28%' }, { label: '文件 / 大小', width: '16%' }, { label: '状态', width: '12%' }, { label: '操作', width: '12%' }]}>{rows.map(skill => <tr key={skill.id} className="hover:bg-surface-raised"><td className={cell}><p className="truncate font-mono text-xs font-medium" title={skill.manifest.name}>{skill.manifest.name}</p><p className="truncate text-xs text-fg-subtle" title={skill.manifest.description}>{skill.manifest.description}</p></td><td className={cell}><p className="text-xs">{sourceLabels[skill.source.kind]}</p><p className="truncate text-xs text-fg-subtle" title={sourceText(skill.source)}>{skill.source.kind === 'zip' ? '上传的技能包' : sourceText(skill.source)}</p></td><td className={cell}><span className="text-xs tabular-nums text-fg-muted">{skill.files.length} 个文件</span><p className="text-xs text-fg-subtle">{formatLogBytes(skill.bytes)}</p></td><td className={cell}><StatusTag label={skill.enabled ? '已启用' : '已停用'} tone={skill.enabled ? 'success' : 'neutral'} /></td><td className={cell}><div className="flex items-center gap-1"><button type="button" className="rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised" onClick={() => void state.loadSkillDetail(gateway, skill.id, skill.revision)}>查看</button><ExtensionMenu label={`更多操作 ${skill.manifest.name}`} items={[{ label: '更新 Skill', disabled: pendingImport, action: () => startImport(skill) }, { label: skill.enabled ? '停用' : '启用', disabled: state.togglingSkillIds.includes(skill.id), action: () => void state.setSkillEnabled(gateway, skill.id, skill.revision, !skill.enabled) }, { label: '删除 Skill', danger: true, action: () => state.requestDeleteSkill({ skillId: skill.id, name: skill.manifest.name, revision: skill.revision }) }]} /></div></td></tr>)}</ExtensionTable></>}
    </div>
    {importTarget !== undefined && <SkillImportDialog key={importTarget === 'new' ? 'new' : `${importTarget.id}@${importTarget.revision}`} target={importTarget === 'new' ? undefined : importTarget} open={active && importOpen} onClose={() => setImportOpen(false)} onPending={setPendingImport} onAccepted={() => { setImportOpen(false); setImportTarget(undefined); setPendingImport(false); setRecordsOpen(true) }} />}
    <ImportRecords open={active && recordsOpen} onClose={() => setRecordsOpen(false)} />
    <SkillDetail open={active && state.skillDetail !== null} />
    <ExtensionDialog title="删除 Skill" open={active && state.deleteTarget !== null} onClose={state.cancelDeleteSkill} footer={<><button type="button" className={CTL_SECONDARY} disabled={state.deletingSkill} onClick={state.cancelDeleteSkill}>取消</button><button type="button" className={CTL_DANGER} disabled={state.deletingSkill} onClick={() => void state.confirmDeleteSkill(gateway)}>{state.deletingSkill ? '正在删除…' : '确认删除'}</button></>}><p className="text-sm">删除「{state.deleteTarget?.name}」的全部修订登记？</p><p className="text-xs leading-5 text-fg-muted">此操作不可撤回，引用它的会话将无法继续读取该 Skill。磁盘上的共享包文件与导入记录保留；这不是停用或新增撤销记录。</p></ExtensionDialog>
  </div>
}

// 沿用旧扩展页的受理核实：分页查找同一 requestId，不创建新的导入。
async function findImportByRequestId(gateway: ReturnType<typeof useGateway>, requestId: string, auth: number) {
  let cursor = ''
  const seen = new Set<string>()
  for (;;) {
    if (auth !== captureAuthGeneration()) throw new Error('登录状态已变化，请重新读取导入记录')
    const page = await gateway.agentExtensions.listSkillImports({ cursor, limit: 50 })
    const found = page.items.find(task => task.requestId === requestId)
    if (found || !page.hasMore) return found
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('导入任务分页异常，无法确认上次提交结果')
    seen.add(page.nextCursor); cursor = page.nextCursor
  }
}

function SkillImportDialog({ target, open, onClose, onPending, onAccepted }: { target?: AgentSkill; open: boolean; onClose(): void; onPending(value: boolean): void; onAccepted(): void }) {
  const gateway = useGateway()
  const latest = useAgentExtensionsStore(state => state.skills.find(skill => skill.id === target?.id))
  const [revision, setRevision] = useState(target?.revision ?? 0)
  const [kind, setKind] = useState<AgentSkill['source']['kind']>('zip')
  const [file, setFile] = useState<File>()
  const [path, setPath] = useState('')
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [subdirectory, setSubdirectory] = useState('')
  const [credential, setCredential] = useState('')
  const [enabled, setEnabled] = useState(target?.enabled ?? true)
  const [error, setError] = useState<string>()
  const [uncertain, setUncertain] = useState(false)
  const pending = useRef<{ input: AgentSkillImportInput; archive?: File } | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current = null } }, [])
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const submit = () => inFlightOnly(async () => {
    const auth = captureAuthGeneration()
    const current = () => alive.current && auth === captureAuthGeneration()
    setError(undefined)
    let dispatched = false
    try {
      if (pending.current) { dispatched = true }
      if (pending.current) {
        const found = await findImportByRequestId(gateway, pending.current.input.requestId, auth)
        if (!current()) return
        if (found) {
          useAgentExtensionsStore.getState().acceptSkillImport(gateway, found)
          pending.current = null; onPending(false); onAccepted(); return
        }
      } else {
        if (kind === 'zip' && (!file || file.size > 64 * 1024 * 1024)) throw new Error('请选择不超过 64 MiB 的 ZIP 文件')
        if (kind === 'directory' && !path.trim().startsWith('/')) throw new Error('服务器目录须为以 / 开头的绝对路径')
        if (kind === 'git') {
          let valid = false
          try { const parsed = new URL(url); valid = parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash } catch { /* 在表单内提示 */ }
          if (!valid || !ref.trim()) throw new Error('请填写 HTTPS Git 地址与明确的分支、标签或提交；地址不能包含凭据或查询参数')
        }
        const input: AgentSkillImportInput = { requestId: `skill-import-${randomId()}`, enabled, ...(target ? { skillId: target.id, expectedRevision: revision } : {}), source: kind === 'zip' ? { kind } : kind === 'directory' ? { kind, path: path.trim(), ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}) } : { kind, url: url.trim(), ref: ref.trim(), ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}) }, ...(kind === 'git' && credential ? { credential } : {}) }
        pending.current = { input, archive: kind === 'zip' ? file : undefined }; onPending(true)
      }
      const request = pending.current
      dispatched = true
      const task = await gateway.agentExtensions.createSkillImport(request.input, request.archive)
      if (!current()) return
      pending.current = null; setCredential(''); setFile(undefined); setUncertain(false); onPending(false)
      useAgentExtensionsStore.getState().acceptSkillImport(gateway, task)
      onAccepted()
    } catch (error) {
      if (!current()) return
      // 明确校验失败可修改输入；网络或服务端故障保留精确请求，先查后重试。
      if (error instanceof AgentHttpError && [400, 403, 404, 409, 413, 415, 422, 429].includes(error.status ?? 0)) {
        pending.current = null; onPending(false)
        if (error.status === 409) void useAgentExtensionsStore.getState().loadSkills(gateway, { silent: true })
      }
      setUncertain(pending.current !== null)
      const message = error instanceof Error ? error.message : '导入结果尚未确认'
      setError(message)
      if (dispatched) useMessageStore.getState().notify({ tone: 'danger', message })
    }
  })
  return <ExtensionDialog title={target ? `更新 Skill · ${target.manifest.name}` : '导入 Skill'} open={open} onClose={onClose} footer={<><button type="button" className={CTL_SECONDARY} onClick={onClose}>关闭</button><button type="submit" form="skill-import-form" disabled={submitting} className={CTL_PRIMARY}>{submitting ? '正在提交…' : uncertain ? '核对并重试' : '开始导入'}</button></>}>
    <p className="text-xs leading-5 text-fg-subtle">包根目录须有包含名称和描述的 SKILL.md。导入只保存和校验内容，不运行技能脚本，也不会自动加入聊天会话。</p>
    {uncertain && <p role="status" className="text-xs leading-5 text-warning">上次提交结果尚未确认，原请求与输入已保留。点击「核对并重试」会先查询受理记录，未找到时沿用同一请求编号提交。</p>}
    <form id="skill-import-form" onSubmit={event => { event.preventDefault(); void submit() }}><fieldset disabled={submitting || uncertain} className="space-y-4">
      <ChipGroup ariaLabel="Skill 来源" value={kind} onSelect={next => { setKind(next); setError(undefined) }} disabled={submitting || uncertain} items={[{ value: 'zip', label: 'ZIP 上传' }, { value: 'git', label: 'HTTPS Git' }, { value: 'directory', label: '服务器目录' }]} />
      {kind === 'zip' ? <Field label="ZIP 文件（不超过 64 MiB）" id="skill-archive"><input id="skill-archive" type="file" accept=".zip,application/zip" onChange={event => setFile(event.target.files?.[0])} className={`${CTL_FIELD} file:mr-2 file:border-0 file:bg-transparent file:text-xs file:text-fg`} />{file && <p className="mt-2 break-words text-xs text-fg-muted">{file.name} · {formatLogBytes(file.size)}</p>}</Field> : <>
        {kind === 'directory' ? <Field label="服务器绝对目录" id="skill-path"><input id="skill-path" required value={path} onChange={event => setPath(event.target.value)} placeholder="/opt/skills/example" className={CTL_FIELD} /><p className="mt-2 text-xs leading-5 text-fg-subtle">须为面板进程可见的目录；Docker 部署时填写已挂载到面板容器中的路径。</p></Field> : <><Field label="HTTPS Git 地址" id="skill-git-url"><input id="skill-git-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://github.com/example/skills.git" className={CTL_FIELD} /></Field><Field label="分支、标签或提交" id="skill-git-ref"><input id="skill-git-ref" required value={ref} onChange={event => setRef(event.target.value)} placeholder="main 或 v1.0.0" className={CTL_FIELD} /></Field><Field label="Git 凭据（可选）" id="skill-git-token"><input id="skill-git-token" type="password" autoComplete="new-password" value={credential} onChange={event => setCredential(event.target.value)} className={CTL_FIELD} /><p className="mt-2 text-xs text-fg-subtle">仅用于本次获取，不保存到来源或导入记录。</p></Field></>}
        <Field label="子目录（可选）" id="skill-subdirectory"><input id="skill-subdirectory" value={subdirectory} onChange={event => setSubdirectory(event.target.value)} placeholder="skills/example" className={CTL_FIELD} /></Field>
      </>}
      <ExtensionToggle label="导入后启用" checked={enabled} onChange={setEnabled} disabled={!!target || submitting || uncertain} />
      {target && <p className="text-xs text-fg-subtle">更新保留当前启用状态；需要切换时请使用列表中的启用／停用操作。</p>}
      {target && <RevisionConflictNotice latest={latest} baseRevision={revision} onAccept={next => { setRevision(next); setEnabled(latest?.enabled ?? enabled); setError(undefined) }} />}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </fieldset></form>
  </ExtensionDialog>
}

function ImportRecords({ open, onClose }: { open: boolean; onClose(): void }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const [deleting, setDeleting] = useState<string>()
  return <ExtensionDialog title="Skill 导入记录" open={open} onClose={onClose} wide>
    <div className="flex justify-end"><RefreshButton label="刷新导入记录" busy={state.importsRefreshing} onPress={() => void state.loadImports(gateway)} /></div>
    <div className="busy-host relative"><BusyVeil busy={state.importsRefreshing} />
      {state.importsStatus === 'idle' || state.importsStatus === 'loading' ? <LoadingState /> : state.importsStatus === 'error' ? <ErrorState description={state.importsErrorMessage} onRetry={() => void state.loadImports(gateway)} /> : <>
        {state.importsErrorMessage && <p role="alert" className="mb-2 text-xs text-danger">{state.importsErrorMessage}</p>}
        {state.imports.length === 0 ? <EmptyState title="暂无导入记录" description="发起导入后，可在这里查看进度和结果。" /> : <ul className="space-y-2">{state.imports.map(task => <li key={task.id} className="space-y-2 rounded-lg border border-line p-3"><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0 flex-1"><p className="break-all text-xs font-medium">{sourceText(task.source)}</p><p className="mt-1 text-xs text-fg-subtle">{formatDateTime(task.createdAt)}{task.revision ? ` · 修订 ${task.revision}` : ''}</p></div><StatusTag {...importLabels[task.state]} /></div>{task.error && <p className="text-xs text-danger">{task.error.message}</p>}{task.cancelRequestedAt && !terminal(task) && <p role="status" className="text-xs text-warning">取消请求已提交，等待任务停止</p>}<div className="flex items-center justify-between gap-3"><details className="min-w-0 text-xs text-fg-subtle"><summary className="cursor-pointer">任务信息</summary><p className="mt-1 break-all">任务：{task.id}<br />请求：{task.requestId}</p></details>{terminal(task) ? <button type="button" className={CTL_SECONDARY} disabled={state.importActingIds.includes(task.id)} onClick={() => setDeleting(task.id)}>删除记录</button> : <button type="button" className={CTL_SECONDARY} disabled={state.importActingIds.includes(task.id) || !!task.cancelRequestedAt} onClick={() => void state.cancelSkillImport(gateway, task.id)}>取消导入</button>}</div></li>)}</ul>}
        {state.importsHasMore && <button type="button" className={`${CTL_SECONDARY} mt-3`} disabled={state.importsLoadingMore} onClick={() => void state.loadMoreImports(gateway)}>{state.importsLoadingMore ? '加载中…' : '加载更多'}</button>}
      </>}
    </div>
    <ExtensionDialog title="删除导入记录" open={open && deleting !== undefined} onClose={() => setDeleting(undefined)} footer={<><button type="button" className={CTL_SECONDARY} onClick={() => setDeleting(undefined)}>取消</button><button type="button" className={CTL_DANGER} disabled={!!deleting && state.importActingIds.includes(deleting)} onClick={async () => { if (deleting) { await state.deleteSkillImportRecord(gateway, deleting); setDeleting(undefined) } }}>确认删除记录</button></>}><p className="text-xs leading-5">仅删除这条已结束的导入记录，不删除导入的 Skill 或磁盘包文件。</p></ExtensionDialog>
  </ExtensionDialog>
}

function SkillDetail({ open }: { open: boolean }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const detail = state.skillDetail
  const skill = detail?.item
  const [revision, setRevision] = useState('')
  useEffect(() => { setRevision(detail?.revision?.toString() ?? '') }, [detail?.skillId, detail?.revision])
  return <ExtensionDialog title="Skill 详情" open={open} onClose={state.closeSkillDetail} wide>
    {detail?.loading && <LoadingState label="正在读取 Skill…" />}{detail?.errorMessage && <p role="alert" className="text-xs text-danger">{detail.errorMessage}</p>}
    {skill && <><div><p className="text-sm font-medium">{skill.manifest.name}</p><p className="mt-1 text-xs leading-5 text-fg-muted">{skill.manifest.description}</p></div>
      <div className="grid min-w-0 gap-3 md:grid-cols-[12rem_minmax(0,1fr)]"><div className="max-h-72 overflow-auto rounded-lg border border-line p-1" aria-label="Skill 文件列表">{skill.files.map(file => <button key={file.path} type="button" aria-pressed={detail.file?.path === file.path} onClick={() => void state.loadSkillFile(gateway, skill.id, skill.revision, file.path)} className={`block w-full break-all rounded-md px-2 py-2 text-left font-mono text-xs hover:bg-surface-raised ${detail.file?.path === file.path ? 'bg-surface-raised text-fg' : 'text-fg-muted'}`}>{file.path}</button>)}</div><div className="min-w-0 rounded-lg border border-line p-3"><p className="mb-2 break-all font-mono text-xs text-fg-muted">{detail.file?.path ?? '选择文件预览'}</p>{detail.file?.status === 'loading' ? <LoadingState label="读取文件中…" /> : detail.file?.status === 'error' ? <p role="alert" className="text-xs text-danger">{detail.file.errorMessage}</p> : detail.file?.preview && (detail.file.preview.previewable ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">{detail.file.preview.content}</pre> : <p className="text-xs text-fg-subtle">{detail.file.preview.reason === 'binary' ? '二进制文件不能预览' : '文件超过 256 KiB，无法预览'}</p>)}</div></div>
      <details className="border-t border-line pt-3"><summary className="cursor-pointer text-xs font-medium">来源与版本信息</summary><dl className="mt-3 grid grid-cols-[5rem_1fr] gap-2 text-xs"><dt>来源</dt><dd className="break-all">{sourceText(skill.source)}{skill.source.subdirectory && ` / ${skill.source.subdirectory}`}</dd>{skill.source.commit && <><dt>Git 提交</dt><dd className="break-all font-mono">{skill.source.commit}</dd></>}<dt>修订</dt><dd>{skill.revision} · {formatDateTime(skill.createdAt)}</dd><dt>标识</dt><dd className="break-all font-mono">{skill.id}</dd><dt>内容摘要</dt><dd className="min-w-0 break-all font-mono">{skill.digest} <CopyButton label="Skill 内容摘要" value={skill.digest} tooltip="复制完整摘要" /></dd><dt>文件 / 大小</dt><dd>{skill.files.length} / {formatLogBytes(skill.bytes)}</dd>{skill.manifest.license && <><dt>许可证</dt><dd>{skill.manifest.license}</dd></>}{skill.manifest.compatibility && <><dt>兼容性</dt><dd>{skill.manifest.compatibility}</dd></>}{skill.manifest.allowedTools && <><dt>工具需求</dt><dd className="break-words">{skill.manifest.allowedTools}（自述需求，不代表授权）</dd></>}</dl></details>
      <SkillRevocations key={skill.id} skillId={skill.id} />
    </>}
    {detail && <details className="border-t border-line pt-3"><summary className="cursor-pointer text-xs font-medium">查看历史修订</summary><div className="mt-3 flex items-end gap-2"><Field label="修订号" id="skill-history-revision"><input id="skill-history-revision" type="number" min={1} step={1} value={revision} onChange={event => setRevision(event.target.value)} className={`${CTL_FIELD} w-24`} /></Field><button type="button" className={CTL_SECONDARY} disabled={!Number.isSafeInteger(Number(revision)) || Number(revision) < 1} onClick={() => void state.loadSkillDetail(gateway, detail.skillId, Number(revision))}>读取修订</button><button type="button" className={CTL_SECONDARY} onClick={() => void state.loadSkillDetail(gateway, detail.skillId)}>读取最新</button></div></details>}
  </ExtensionDialog>
}

function SkillRevocations({ skillId }: { skillId: string }) {
  const gateway = useGateway()
  const [items, setItems] = useState<readonly AgentCapabilityRevocation[]>([])
  const [cursor, setCursor] = useState('')
  const [more, setMore] = useState(false)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(undefined)
    void gateway.agentExtensions.listCapabilityRevocations({ kind: 'skill', id: skillId, cursor, limit: 20 }).then(page => { if (!cancelled) { setItems(rows => cursor ? [...rows, ...page.items] : page.items); setMore(page.hasMore); setNext(page.nextCursor) } }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : '撤销记录读取失败') }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [gateway, skillId, cursor])
  const [next, setNext] = useState('')
  return <details className="border-t border-line pt-3"><summary className="cursor-pointer text-xs font-medium">永久撤销记录</summary><div className="mt-3 space-y-2 text-xs">{error ? <p role="alert" className="text-danger">{error}</p> : loading && items.length === 0 ? <p>读取中…</p> : items.length === 0 ? <p className="text-fg-subtle">无撤销记录</p> : items.map(item => <div key={item.cursor}><p>{item.revision === 0 ? '全部修订' : `修订 ${item.revision}`} · {formatDateTime(item.createdAt)}</p><p className="mt-1 break-words text-fg-muted">{item.reason}</p></div>)}{more && <button type="button" className={CTL_SECONDARY} disabled={loading} onClick={() => setCursor(next)}>加载更多</button>}</div></details>
}
