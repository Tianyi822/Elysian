import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import { formatLogBytes } from '@elysian/contracts'
import type { AgentCapabilityRevocation, AgentSkill, AgentSkillImportInput, AgentSkillImportTask } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { AgentRunStatusTag } from '../../components/agent/AgentStatusTag'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { useSilentPolling } from '../../components/agent/useSilentPolling'
import { CopyButton } from '../../components/CopyButton'
import { CTL_CARD_ACTION, CTL_CHIP, CTL_DANGER, CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useAgentExtensionsStore, selectImportsActive } from '../../stores/agentExtensionsStore'

/*
 * 技能页签：技能目录（启停/删除按修订 CAS）、导入发起（ZIP multipart / 宿主目录 /
 * HTTPS Git，requestId 幂等）、导入任务列表（3 秒静默轮询、取消、终态记录删除）。
 * 服务端是唯一权威：任务回执只有受理与状态，「导入完成」的权威事实是技能目录
 * 里出现的新条目（轮询发现非终态转终态时静默重读目录）。
 */

const IMPORT_POLL_INTERVAL_MS = 3_000
const TERMINAL_IMPORT_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const SOURCE_KIND_LABELS: Record<'zip' | 'directory' | 'git', string> = { zip: 'ZIP 上传', directory: '宿主目录', git: 'HTTPS Git' }

type PendingImport = {
  inputFingerprint: string
  input: AgentSkillImportInput
  archive?: File
}

async function sameArchive(first?: File, second?: File): Promise<boolean> {
  if (first === second) return true
  if (first === undefined || second === undefined || first.size !== second.size) return false
  const firstBytes = new Uint8Array(await first.arrayBuffer())
  const secondBytes = new Uint8Array(await second.arrayBuffer())
  return firstBytes.every((byte, index) => byte === secondBytes[index])
}

async function findImportByRequestId(gateway: ReturnType<typeof useGateway>, requestId: string): Promise<AgentSkillImportTask | undefined> {
  let cursor = ''
  const seen = new Set<string>()
  for (;;) {
    const page = await gateway.agentExtensions.listSkillImports({ cursor, limit: 50 })
    const found = page.items.find((task) => task.requestId === requestId)
    if (found !== undefined) return found
    if (!page.hasMore) return undefined
    if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error('导入任务分页游标异常，无法确认上次提交结果')
    seen.add(page.nextCursor)
    cursor = page.nextCursor
  }
}

function skillSourceText(skill: { source: { kind: string; path?: string; url?: string; ref?: string; commit?: string; subdirectory?: string } }): string {
  const source = skill.source
  if (source.kind === 'directory') return `目录 ${source.path ?? ''}${source.subdirectory ? `（子目录 ${source.subdirectory}）` : ''}`
  if (source.kind === 'git') return `Git ${source.url ?? ''}@${source.ref ?? ''}${source.commit ? `（${source.commit.slice(0, 10)}）` : ''}`
  return 'ZIP 上传'
}

function importSourceText(task: AgentSkillImportTask): string {
  const source = task.source
  if (source.kind === 'directory') return `目录 ${source.path ?? ''}`
  if (source.kind === 'git') return `Git ${source.url ?? ''}@${source.ref ?? ''}`
  return 'ZIP 上传'
}

export function SkillsSection({ importIdParam }: { importIdParam?: string | null }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const active = useAgentExtensionsStore(selectImportsActive)
  const [importOpen, setImportOpen] = useState(false)
  const [importTarget, setImportTarget] = useState<AgentSkill | undefined>()
  const [importUncertain, setImportUncertain] = useState(false)

  useEffect(() => {
    void state.loadSkills(gateway)
    void state.loadImports(gateway)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway])

  const { degraded } = useSilentPolling(
    (signal) => state.pollImports(gateway, signal),
    { intervalMs: IMPORT_POLL_INTERVAL_MS, enabled: active },
  )

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="技能目录" className="relative panel-surface overflow-hidden">
        <BusyVeil busy={state.skillsRefreshing} />
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">技能目录</h2>
          <div className="flex items-center gap-2">
            <RefreshButton label="刷新技能目录" onPress={() => void state.loadSkills(gateway)} busy={state.skillsRefreshing} />
            <button type="button" className={`${CTL_PRIMARY} px-3`} onClick={() => {
              if (importUncertain) { setImportOpen(true); return }
              setImportTarget(undefined)
              setImportOpen((open) => !open)
            }}>
              {importUncertain ? '核对上次导入' : importOpen ? '收起导入区' : '导入技能'}
            </button>
          </div>
        </div>
        {state.skillsStatus === 'loading' ? <LoadingState label="正在读取技能目录…" /> : null}
        {state.skillsStatus === 'error' ? (
          <div className="p-4">
            <ErrorState description={state.skillsErrorMessage} onRetry={() => void state.loadSkills(gateway)} />
          </div>
        ) : null}
        {state.skillsStatus === 'ready' && state.skills.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="还没有已导入的技能"
              description="技能只能经导入产生（ZIP、宿主目录或 HTTPS Git）；导入后在这里启用、停用或删除。"
              action={
                <button type="button" className={`${CTL_SECONDARY} mt-1 px-2`} onClick={() => setImportOpen(true)}>
                  导入第一个技能
                </button>
              }
            />
          </div>
        ) : null}
        {state.skillsStatus === 'ready' && state.skills.length > 0 ? <SkillsTable onImportTarget={(skill) => {
          if (!importUncertain) setImportTarget(skill)
          setImportOpen(true)
        }} /> : null}
      </section>

      {importOpen ? <SkillImportPanel key={`${importTarget?.id ?? 'new'}@${importTarget?.revision ?? 0}`} target={importTarget} onFinished={() => setImportOpen(false)} onUncertainChange={setImportUncertain} /> : null}

      <section aria-label="导入任务" className="relative panel-surface overflow-hidden">
        <BusyVeil busy={state.importsRefreshing} />
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">导入任务</h2>
          <div className="flex items-center gap-2">
            {degraded ? (
              <span role="status" className="text-xs text-warning">连接中断，正在重试</span>
            ) : null}
            <RefreshButton label="刷新导入任务" onPress={() => void state.loadImports(gateway)} busy={state.importsRefreshing} />
          </div>
        </div>
        {state.importsStatus === 'loading' ? <LoadingState label="正在读取导入任务…" /> : null}
        {state.importsStatus === 'error' ? (
          <div className="p-4">
            <ErrorState description={state.importsErrorMessage} onRetry={() => void state.loadImports(gateway)} />
          </div>
        ) : null}
        {state.importsStatus === 'ready' && state.imports.length === 0 ? (
          <div className="p-4">
            <EmptyState title="暂无导入记录" description="发起导入后，任务按受理、执行、终态回执留痕；终态记录可删除以收缩登记容量。" />
          </div>
        ) : null}
        {state.importsStatus === 'ready' && state.imports.length > 0 ? <ImportsTable importIdParam={importIdParam ?? null} /> : null}
      </section>

      <SkillDetailDialog />
      <SkillDeleteDialog />
    </div>
  )
}

function SkillsTable({ onImportTarget }: { onImportTarget(skill: AgentSkill): void }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-left text-sm">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[20%]" />
          <col className="w-[14%]" />
          <col className="w-[10%]" />
          <col className="w-[14%]" />
        </colgroup>
        <thead>
          <tr>
            {['名称', '状态', '修订', '来源', '内容摘要', '体积 / 文件', '操作'].map((label) => (
              <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.skills.map((skill) => {
            const toggling = state.togglingSkillIds.includes(skill.id)
            return (
              <tr key={skill.id} className="hover:bg-surface-raised/50">
                <td className="border-b border-line px-3 py-2.5">
                  <p className="truncate font-medium" title={skill.manifest.name}>{skill.manifest.name}</p>
                  <p className="truncate text-xs text-fg-subtle" title={skill.manifest.description}>{skill.manifest.description}</p>
                </td>
                <td className="border-b border-line px-3 py-2.5">
                  {skill.enabled ? (
                    <span className="text-xs font-medium text-success">已启用</span>
                  ) : (
                    <span className="text-xs font-medium text-fg-subtle">已停用</span>
                  )}
                </td>
                <td className="tabular-nums border-b border-line px-3 py-2.5 text-xs text-fg-muted">{skill.revision}</td>
                <td className="border-b border-line px-3 py-2.5">
                  <p className="truncate text-xs text-fg-muted" title={skillSourceText(skill)}>{skillSourceText(skill)}</p>
                </td>
                <td className="border-b border-line px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    <span className="truncate font-mono text-xs text-fg-muted" title={skill.digest}>{skill.digest.slice(0, 12)}…</span>
                    <CopyButton label="技能内容摘要" value={skill.digest} tooltip="复制完整内容摘要" />
                  </div>
                </td>
                <td className="tabular-nums border-b border-line px-3 py-2.5 text-xs text-fg-muted">
                  {formatLogBytes(skill.bytes)} / {skill.files.length}
                </td>
                <td className="border-b border-line px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      className={CTL_CARD_ACTION}
                      onClick={() => void state.loadSkillDetail(gateway, skill.id)}
                    >
                      详情
                    </button>
                    <button type="button" className={CTL_CARD_ACTION} onClick={() => onImportTarget(skill)}>
                      更新包
                    </button>
                    <button
                      type="button"
                      disabled={toggling}
                      className={CTL_CARD_ACTION}
                      onClick={() => void state.setSkillEnabled(gateway, skill.id, skill.revision, !skill.enabled)}
                    >
                      {toggling ? '处理中…' : skill.enabled ? '停用' : '启用'}
                    </button>
                    <button
                      type="button"
                      className={CTL_CARD_ACTION}
                      onClick={() => state.requestDeleteSkill({ skillId: skill.id, name: skill.manifest.name, revision: skill.revision })}
                    >
                      删除
                    </button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SkillDetailDialog() {
  const gateway = useGateway()
  const detail = useAgentExtensionsStore((state) => state.skillDetail)
  const close = useAgentExtensionsStore((state) => state.closeSkillDetail)
  const loadDetail = useAgentExtensionsStore((state) => state.loadSkillDetail)
  const [revisionText, setRevisionText] = useState('')
  useEffect(() => {
    setRevisionText(detail?.revision === undefined ? '' : String(detail.revision))
  }, [detail?.skillId, detail?.revision])
  if (detail === null) return null
  const revision = Number(revisionText)
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] max-h-[85vh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">技能详情</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭技能详情" className="text-xs text-fg-muted hover:text-fg">关闭</button>
            </Dialog.Close>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="agent-skill-revision" className="block text-xs text-fg-muted">修订号</label>
              <input id="agent-skill-revision" type="number" min={1} step={1} value={revisionText} onChange={(event) => setRevisionText(event.target.value)} className={`${CTL_FIELD} mt-1 h-9 w-24`} />
            </div>
            <button type="button" className={CTL_SECONDARY} disabled={!Number.isSafeInteger(revision) || revision < 1} onClick={() => void loadDetail(gateway, detail.skillId, revision)}>读取修订</button>
            <button type="button" className={CTL_SECONDARY} onClick={() => void loadDetail(gateway, detail.skillId)}>读取最新</button>
          </div>
          {detail.loading ? <LoadingState label="正在读取技能详情…" /> : null}
          {!detail.loading && detail.errorMessage !== undefined ? (
            <p role="alert" className="mt-3 text-xs text-danger">{detail.errorMessage}</p>
          ) : null}
          {!detail.loading && detail.item !== undefined ? <SkillDetailBody /> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SkillDetailBody() {
  const gateway = useGateway()
  const detail = useAgentExtensionsStore((state) => state.skillDetail)
  const loadFile = useAgentExtensionsStore((state) => state.loadSkillFile)
  const skill = detail?.item
  if (skill === undefined) return null
  const manifestRow = skill.manifest
  return (
    <div className="mt-3 flex flex-col gap-3 text-sm">
      <div className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-fg-subtle">名称 / 描述</dt>
        <dd className="min-w-0 break-words text-fg">
          <span className="font-medium">{manifestRow.name}</span>
          <span className="text-fg-muted">：{manifestRow.description}</span>
        </dd>
        <dt className="text-fg-subtle">状态 / 修订</dt>
        <dd className="tabular-nums text-fg-muted">{skill.enabled ? '已启用' : '已停用'} · 修订 {skill.revision} · 导入于 {formatDateTime(skill.createdAt)}</dd>
        <dt className="text-fg-subtle">来源</dt>
        <dd className="min-w-0 break-words text-fg-muted">{skillSourceText(skill)}</dd>
        {manifestRow.license !== undefined ? (
          <>
            <dt className="text-fg-subtle">许可证</dt>
            <dd className="text-fg-muted">{manifestRow.license}</dd>
          </>
        ) : null}
        {manifestRow.compatibility !== undefined ? (
          <>
            <dt className="text-fg-subtle">兼容性</dt>
            <dd className="text-fg-muted">{manifestRow.compatibility}</dd>
          </>
        ) : null}
        {manifestRow.allowedTools !== undefined ? (
          <>
            <dt className="text-fg-subtle">自述工具需求</dt>
            <dd className="break-words text-fg-muted">{manifestRow.allowedTools}（仅资料自述，不能替代环境授权与逐调用审批）</dd>
          </>
        ) : null}
        <dt className="text-fg-subtle">内容摘要</dt>
        <dd className="min-w-0 break-all font-mono text-xs text-fg-muted">
          {skill.digest}
          <CopyButton label="技能内容摘要" value={skill.digest} tooltip="复制完整内容摘要" />
        </dd>
        <dt className="text-fg-subtle">体积 / 文件数</dt>
        <dd className="tabular-nums text-fg-muted">{formatLogBytes(skill.bytes)} / {skill.files.length}</dd>
      </div>
      <SkillRevocations skillId={skill.id} />
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-fg-muted">文件清单（{skill.files.length}）</h3>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[28rem] table-fixed border-separate border-spacing-0 text-left text-xs">
            <colgroup>
              <col className="w-[48%]" />
              <col className="w-[20%]" />
              <col className="w-[32%]" />
            </colgroup>
            <thead>
              <tr>
                {['路径', '大小', '摘要'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-2.5 py-2 font-medium text-fg-muted">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {skill.files.map((file) => (
                <tr key={file.path}>
                  <td className="border-b border-line px-2.5 py-1.5 break-all font-mono">
                    <button type="button" className="text-left text-accent hover:underline" onClick={() => void loadFile(gateway, skill.id, skill.revision, file.path)}>{file.path}</button>
                  </td>
                  <td className="tabular-nums border-b border-line px-2.5 py-1.5 text-fg-muted">{formatLogBytes(file.size)}</td>
                  <td className="border-b border-line px-2.5 py-1.5 break-all font-mono text-fg-subtle" title={file.digest}>{file.digest.slice(0, 16)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {detail?.file !== null && detail?.file !== undefined ? (
        <div>
          <h3 className="mb-1.5 text-xs font-medium text-fg-muted">文件预览：{detail.file.path}</h3>
          {detail.file.status === 'loading' ? <LoadingState label="正在读取文件…" /> : null}
          {detail.file.status === 'error' ? <p role="alert" className="text-xs text-danger">{detail.file.errorMessage}</p> : null}
          {detail.file.status === 'ready' && detail.file.preview !== undefined ? (
            detail.file.preview.previewable
              ? <pre className="max-h-72 overflow-auto rounded border border-line bg-surface p-2.5 font-mono text-xs whitespace-pre-wrap break-all">{detail.file.preview.content}</pre>
              : <p className="text-xs text-fg-muted">{detail.file.preview.reason === 'too-large' ? '文件超过预览大小限制' : '二进制文件不能预览'}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function SkillRevocations({ skillId }: { skillId: string }) {
  const gateway = useGateway()
  const generation = useRef(0)
  const [items, setItems] = useState<readonly AgentCapabilityRevocation[]>([])
  const [nextCursor, setNextCursor] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string>()

  const load = async (cursor = '') => {
    const request = ++generation.current
    setStatus('loading')
    setErrorMessage(undefined)
    try {
      const page = await gateway.agentExtensions.listCapabilityRevocations({ kind: 'skill', id: skillId, cursor, limit: 20 })
      if (request !== generation.current) return
      setItems((current) => cursor === '' ? page.items : [...current, ...page.items])
      setNextCursor(page.nextCursor)
      setHasMore(page.hasMore)
      setStatus('ready')
    } catch (error) {
      if (request !== generation.current) return
      setErrorMessage(error instanceof Error ? error.message : '读取撤销记录失败')
      setStatus('error')
    }
  }

  useEffect(() => {
    setItems([])
    void load()
    return () => { generation.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, skillId])

  return (
    <section aria-label="技能撤销记录" className="border-t border-line pt-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium text-fg-muted">永久撤销记录</h3>
        <button type="button" className={CTL_SECONDARY} onClick={() => void load()} disabled={status === 'loading'}>刷新</button>
      </div>
      {status === 'loading' && items.length === 0 ? <p className="mt-2 text-fg-subtle">正在读取…</p> : null}
      {status === 'error' ? <p role="alert" className="mt-2 text-danger">{errorMessage}</p> : null}
      {status === 'ready' && items.length === 0 ? <p className="mt-2 text-fg-subtle">无撤销记录</p> : null}
      {items.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li key={item.cursor} className="rounded border border-line px-2.5 py-2">
              <span className="font-medium">{item.revision === 0 ? '全部修订' : `修订 ${item.revision}`}</span>
              <span className="ml-2 text-fg-subtle">{formatDateTime(item.createdAt)}</span>
              <p className="mt-1 break-words text-fg-muted">{item.reason}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {hasMore ? <button type="button" className={`${CTL_SECONDARY} mt-2`} onClick={() => void load(nextCursor)} disabled={status === 'loading'}>加载更多</button> : null}
    </section>
  )
}

function SkillDeleteDialog() {
  const gateway = useGateway()
  const target = useAgentExtensionsStore((state) => state.deleteTarget)
  const deleting = useAgentExtensionsStore((state) => state.deletingSkill)
  const cancel = useAgentExtensionsStore((state) => state.cancelDeleteSkill)
  const confirm = useAgentExtensionsStore((state) => state.confirmDeleteSkill)
  if (target === null) return null
  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) cancel() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 panel-surface p-4 shadow-xl"
        >
          <Dialog.Title className="text-sm font-semibold">确认删除技能「{target.name}」？</Dialog.Title>
          <p className="mt-1.5 text-xs text-fg-muted">
            将按修订 {target.revision} 删除该技能的全部修订登记。已把它固定进会话环境的运行在派发读取时会得到「技能不存在」。
            删除产出更小的登记文件，因此登记容量触顶（写盘上限拒绝增长）之后仍可用它自助清理，不需要停面板手工编辑配置。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className={`${CTL_SECONDARY} px-3`} onClick={() => cancel()} disabled={deleting}>
              取消
            </button>
            <button type="button" className={`${CTL_DANGER} px-3`} disabled={deleting} onClick={() => void confirm(gateway)}>
              {deleting ? '删除中…' : `确认删除（修订 ${target.revision}）`}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function SkillImportPanel({ onFinished, onUncertainChange, target }: { onFinished(): void; onUncertainChange(value: boolean): void; target?: AgentSkill }) {
  const gateway = useGateway()
  const submitImport = useAgentExtensionsStore((state) => state.submitSkillImport)
  const importSubmitError = useAgentExtensionsStore((state) => state.importSubmitError)
  const clearImportError = useAgentExtensionsStore((state) => state.clearImportSubmitError)
  const { submitting, withRequestId, inFlightOnly, newRequestId } = useInFlightSubmit()
  const [kind, setKind] = useState<'zip' | 'directory' | 'git'>('zip')
  const [file, setFile] = useState<File | null>(null)
  const [path, setPath] = useState('')
  const [subdirectory, setSubdirectory] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [gitRef, setGitRef] = useState('')
  const [credential, setCredential] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [preparing, setPreparing] = useState(false)
  const preparingRef = useRef(false)
  const pendingRef = useRef<PendingImport | null>(null)
  const [uncertain, setUncertain] = useState(false)

  const setPending = (value: PendingImport | null) => {
    pendingRef.current = value
    setUncertain(value !== null)
    onUncertainChange(value !== null)
  }

  const payload = (): Omit<AgentSkillImportInput, 'requestId'> => ({
    enabled,
    ...(target === undefined ? {} : { skillId: target.id, expectedRevision: target.revision }),
    ...(kind === 'zip'
      ? { source: { kind: 'zip' } as const }
      : kind === 'directory'
        ? { source: { kind: 'directory' as const, path: path.trim(), ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}) } }
        : {
            source: { kind: 'git' as const, url: gitUrl.trim(), ref: gitRef.trim(), ...(subdirectory.trim() ? { subdirectory: subdirectory.trim() } : {}) },
            ...(credential !== '' ? { credential } : {}),
          }),
  })

  const accepted = () => {
    setPending(null)
    newRequestId()
    setCredential('')
    if (kind === 'zip') setFile(null)
  }

  const submit = async (): Promise<void> => {
    if (preparingRef.current || submitting) return
    preparingRef.current = true
    setPreparing(true)
    setFormError(null)
    setNotice(null)
    clearImportError()
    try {
      const previous = pendingRef.current
      if (previous !== null) {
        const found = await findImportByRequestId(gateway, previous.input.requestId)
        if (found !== undefined) {
          accepted()
          setNotice(`上次导入已受理为任务 ${found.id}，未重复提交`)
          void useAgentExtensionsStore.getState().loadImports(gateway)
          return
        }
        const currentArchive = kind === 'zip' ? (file ?? undefined) : undefined
        if (JSON.stringify(payload()) !== previous.inputFingerprint || !await sameArchive(previous.archive, currentArchive)) {
          setFormError('上次导入尚未查到受理记录；当前输入已变更。请恢复原输入后核对并重试，原请求仍已保留。')
          return
        }
        const retried = await inFlightOnly(() => submitImport(gateway, previous.input, previous.archive))
        if (retried === true) accepted()
        return
      }

      if (kind === 'zip' && file === null) {
        setFormError('ZIP 来源必须选择上传文件')
        return
      }
      if (kind === 'directory' && !path.trim().startsWith('/')) {
        setFormError('宿主目录来源必须填写以 / 开头的绝对路径')
        return
      }
      if (kind === 'git') {
        if (!gitUrl.trim().startsWith('https://')) {
          setFormError('Git 来源必须是以 https:// 开头的地址')
          return
        }
        if (!gitRef.trim()) {
          setFormError('Git 来源必须显式填写分支、标签或提交')
          return
        }
      }
      const inputWithoutId = payload()
      const archive = kind === 'zip' ? (file ?? undefined) : undefined
      const inputFingerprint = JSON.stringify(inputWithoutId)
      const ok = await withRequestId((requestId) => {
        const input = { requestId, ...inputWithoutId }
        setPending({ inputFingerprint, input, archive })
        return submitImport(gateway, input, archive)
      })
      if (ok === true) accepted()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : '无法确认导入结果，请保留原输入后重试')
    } finally {
      preparingRef.current = false
      setPreparing(false)
    }
  }

  return (
    <section aria-label="导入技能" className="panel-surface p-4">
      <h2 className="text-sm font-semibold">{target === undefined ? '导入技能' : `更新技能「${target.manifest.name}」（修订 ${target.revision}）`}</h2>
      <p className="mt-1 text-xs text-fg-muted">
        导入不执行技能脚本、不运行 hooks 或 submodule；Git 来源锁定完整提交（显式 ref），
        包内容作为不可变内容包登记；越界路径、链接与特殊文件一律拒绝。导入受并发与队列限额约束，任务可取消。
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {(['zip', 'directory', 'git'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={kind === value}
            className={`${CTL_CHIP} ${kind === value ? 'border-control-line-strong bg-surface-raised text-fg' : 'text-fg-muted'}`}
            onClick={() => { setKind(value); setFormError(null); clearImportError() }}
          >
            {SOURCE_KIND_LABELS[value]}
          </button>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {kind === 'zip' ? (
          <div className="sm:col-span-2">
            <label htmlFor="skill-import-archive" className="text-xs font-medium text-fg-muted">ZIP 文件（不超过 64 MiB）</label>
            <input
              id="skill-import-archive"
              type="file"
              accept=".zip,application/zip"
              className={`${CTL_FIELD} mt-1 w-full file:mr-2 file:rounded file:border-0 file:bg-transparent file:text-xs file:text-fg-muted`}
              onChange={(event) => { setFile(event.target.files?.[0] ?? null); clearImportError() }}
            />
            {file !== null ? (
              <p className="mt-1 text-xs text-fg-subtle">已选择：{file.name}（{formatLogBytes(file.size)}）</p>
            ) : null}
          </div>
        ) : null}
        {kind === 'directory' ? (
          <>
            <div>
              <label htmlFor="skill-import-path" className="text-xs font-medium text-fg-muted">宿主绝对目录</label>
              <input
                id="skill-import-path"
                type="text"
                className={`${CTL_FIELD} mt-1 w-full`}
                placeholder="/opt/elysian/skills/example"
                value={path}
                onChange={(event) => setPath(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="skill-import-subdirectory" className="text-xs font-medium text-fg-muted">子目录（可选）</label>
              <input
                id="skill-import-subdirectory"
                type="text"
                className={`${CTL_FIELD} mt-1 w-full`}
                placeholder="packages/main"
                value={subdirectory}
                onChange={(event) => setSubdirectory(event.target.value)}
              />
            </div>
          </>
        ) : null}
        {kind === 'git' ? (
          <>
            <div>
              <label htmlFor="skill-import-git-url" className="text-xs font-medium text-fg-muted">HTTPS Git 地址</label>
              <input
                id="skill-import-git-url"
                type="url"
                className={`${CTL_FIELD} mt-1 w-full`}
                placeholder="https://git.example.com/ops/skill.git"
                value={gitUrl}
                onChange={(event) => setGitUrl(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="skill-import-git-ref" className="text-xs font-medium text-fg-muted">显式 ref（分支 / 标签 / 提交）</label>
              <input
                id="skill-import-git-ref"
                type="text"
                className={`${CTL_FIELD} mt-1 w-full`}
                placeholder="v1.2.0"
                value={gitRef}
                onChange={(event) => setGitRef(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="skill-import-git-subdirectory" className="text-xs font-medium text-fg-muted">子目录（可选）</label>
              <input
                id="skill-import-git-subdirectory"
                type="text"
                className={`${CTL_FIELD} mt-1 w-full`}
                placeholder="skills/main"
                value={subdirectory}
                onChange={(event) => setSubdirectory(event.target.value)}
              />
            </div>
            <div>
              <label htmlFor="skill-import-credential" className="text-xs font-medium text-fg-muted">Git 凭据（可选，只写不回显）</label>
              <input
                id="skill-import-credential"
                type="password"
                autoComplete="off"
                className={`${CTL_FIELD} mt-1 w-full`}
                placeholder="仅 HTTPS Git 来源；不落入任务或技能来源"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
              />
            </div>
          </>
        ) : null}
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="size-4 accent-[var(--color-accent)]"
          />
            导入后立即启用（不勾选则导入为停用状态，可稍后启用）
        </label>
      </div>
      {formError !== null ? <p role="alert" className="mt-2 text-xs text-danger">{formError}</p> : null}
      {notice !== null ? <p role="status" className="mt-2 text-xs text-success">{notice}</p> : null}
      {importSubmitError !== null ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {importSubmitError}
          <button type="button" className={`${CTL_CARD_ACTION} ml-2`} onClick={clearImportError}>知道了</button>
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" className={`${CTL_PRIMARY} px-3`} disabled={submitting || preparing} onClick={() => void submit()}>
          {submitting || preparing ? '处理中…' : uncertain ? '核对并重试' : '开始导入'}
        </button>
        <button type="button" className={`${CTL_SECONDARY} px-3`} onClick={onFinished} disabled={uncertain}>
          收起
        </button>
        <span className="text-xs text-fg-subtle">结果未确认时先按 requestId 核对任务，再用原输入和原键重试。</span>
      </div>
    </section>
  )
}

function ImportsTable({ importIdParam }: { importIdParam: string | null }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const cancel = useInFlightSubmit()
  const rowSubmit = useInFlightSubmit()
  const highlighted = useMemo(() => importIdParam, [importIdParam])
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] table-fixed border-separate border-spacing-0 text-left text-sm">
        <colgroup>
          <col className="w-[14%]" />
          <col className="w-[13%]" />
          <col className="w-[23%]" />
          <col className="w-[12%]" />
          <col className="w-[22%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead>
          <tr>
            {['任务', '状态', '来源', '技能 / 修订', '错误', '操作'].map((label) => (
              <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {state.imports.map((task) => {
            const acting = state.importActingIds.includes(task.id)
            const active = task.state === 'queued' || task.state === 'running'
            const terminal = TERMINAL_IMPORT_STATES.has(task.state)
            return (
              <tr
                key={task.id}
                className={`hover:bg-surface-raised/50 ${highlighted === task.id ? 'bg-surface-raised ring-1 ring-control-line-strong' : ''}`}
              >
                <td className="border-b border-line px-3 py-2.5">
                  <p className="truncate font-mono text-xs" title={task.id}>{task.id}</p>
                  <p className="truncate text-xs text-fg-subtle" title={task.requestId}>requestId {task.requestId}</p>
                </td>
                <td className="border-b border-line px-3 py-2.5">
                  <div className="flex flex-col items-start gap-1">
                    <AgentRunStatusTag status={task.state} />
                    {task.cancelRequestedAt && active ? (
                      <span className="text-xs text-warning">已请求取消，等待停止</span>
                    ) : null}
                  </div>
                </td>
                <td className="border-b border-line px-3 py-2.5">
                  <p className="truncate text-xs text-fg-muted" title={importSourceText(task)}>{importSourceText(task)}</p>
                  <p className="text-xs text-fg-subtle">受理 {formatDateTime(task.createdAt)}</p>
                </td>
                <td className="border-b border-line px-3 py-2.5 text-xs tabular-nums text-fg-muted">
                  {task.skillId !== undefined ? `${task.skillId} · 修订 ${task.revision ?? '—'}` : '—'}
                </td>
                <td className="border-b border-line px-3 py-2.5">
                  {task.error !== undefined ? (
                    <p className="text-xs text-danger" title={`${task.error.code}：${task.error.message}`}>{task.error.message}</p>
                  ) : (
                    <span className="text-xs text-fg-subtle">—</span>
                  )}
                </td>
                <td className="border-b border-line px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {active ? (
                      <button
                        type="button"
                        className={CTL_CARD_ACTION}
                        disabled={acting || cancel.submitting}
                        onClick={() => {
                          void cancel.inFlightOnly(async () => {
                            await useAgentExtensionsStore.getState().cancelSkillImport(gateway, task.id)
                          })
                        }}
                      >
                        {acting ? '处理中…' : '取消导入'}
                      </button>
                    ) : null}
                    {terminal ? (
                      <button
                        type="button"
                        className={CTL_CARD_ACTION}
                        disabled={acting || rowSubmit.submitting}
                        onClick={() => {
                          void rowSubmit.inFlightOnly(async () => {
                            await useAgentExtensionsStore.getState().deleteSkillImportRecord(gateway, task.id)
                          })
                        }}
                      >
                        {acting ? '处理中…' : '删除记录'}
                      </button>
                    ) : null}
                    {!active && !terminal ? <span className="text-xs text-fg-subtle">—</span> : null}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {state.importsHasMore ? (
        <div className="flex justify-center border-t border-line px-4 py-2.5">
          <button
            type="button"
            className={`${CTL_SECONDARY} px-3`}
            disabled={state.importsLoadingMore}
            onClick={() => void state.loadMoreImports(gateway)}
          >
            {state.importsLoadingMore ? '加载中…' : '加载更早的导入记录'}
          </button>
        </div>
      ) : null}
    </div>
  )
}
