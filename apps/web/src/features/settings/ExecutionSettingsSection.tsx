import { useEffect, useState } from 'react'
import type { AgentExecutionGrant, AgentExecutionProfile } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { captureAuthGeneration } from '../../adapters/http/unauthorized'
import { useSessionStore } from '../../stores/sessionStore'
import { useAgentRuntimeStore } from '../../stores/agentRuntimeStore'
import { useAgentExecutionStore, type ExecutionItem, type ExecutionKind, type ExecutionSaveResult } from '../../stores/agentExecutionStore'
import { SelectDropdown } from '../../components/SelectDropdown'
import { CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { Plus, Pencil } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { ExtensionDialog, ExtensionSearch, ExtensionTable, IconAction, extensionCell as cell } from './extensionUi'
import { ExecutionProfileDialog } from './ExecutionProfileDialog'
import { ExecutionGrantDialog } from './ExecutionGrantDialog'
import { JsonView } from './JsonView'

const filters = [{ value: 'all', label: '全部' }, { value: 'enabled', label: '已启用' }, { value: 'disabled', label: '已停用' }] as const
const profileColumns = [{ label: '名称 / 修订', width: '20%' }, { label: '运行类型 / 镜像', width: '35%' }, { label: '执行限额', width: '20%' }, { label: '状态', width: '10%' }, { label: '操作', width: '15%' }]
const grantColumns = [{ label: '名称 / 修订', width: '20%' }, { label: '目录、网络与对象', width: '55%' }, { label: '状态', width: '10%' }, { label: '操作', width: '15%' }]

/** 配置接口可用时独立管理，执行器不就绪只展示诊断，不挡住配置修复。 */
export function ExecutionSettingsSection({ kind, active }: { kind: ExecutionKind; active: boolean }) {
  const phase = useSessionStore(state => state.phase)
  const epoch = useAgentExecutionStore(state => state.epoch)
  return phase === 'authed' ? <ExecutionCatalog key={`${kind}:${epoch}`} kind={kind} active={active} /> : null
}

function ExecutionCatalog({ kind, active }: { kind: ExecutionKind; active: boolean }) {
  const gateway = useGateway()
  const state = useAgentExecutionStore()
  const catalog = state[kind]
  const runtime = useAgentRuntimeStore()
  const demo = useSessionStore(state => state.mode === 'demo')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [editing, setEditing] = useState<ExecutionItem | 'new'>()
  const [detail, setDetail] = useState<ExecutionItem>()
  const [disable, setDisable] = useState<ExecutionItem>()
  const [action, setAction] = useState<{ id: string; result: ExecutionSaveResult }>()
  const label = kind === 'profiles' ? '执行配置' : '资源授权'
  useEffect(() => { void state.load(gateway, kind); if (runtime.status === 'idle') void runtime.load(gateway) }, [gateway, kind, state.load])
  const keyword = search.trim().toLowerCase()
  const rows = catalog.items.filter(item => (status === 'all' || item.enabled === (status === 'enabled')) && JSON.stringify(item).toLowerCase().includes(keyword))
  const toggle = async (item: ExecutionItem, enabled: boolean) => {
    const auth = captureAuthGeneration(), epoch = useAgentExecutionStore.getState().epoch
    const result = await state.toggle(gateway, kind, item, enabled)
    if (auth !== captureAuthGeneration() || epoch !== useAgentExecutionStore.getState().epoch || result.status === 'stale') return
    setDisable(undefined)
    setAction(result.status === 'saved' ? undefined : { id: item.id, result })
  }
  return <div className="min-w-0 space-y-3">
    <p className="text-xs leading-5 text-fg-muted">{kind === 'profiles' ? '管理 Ely 执行脚本使用的容器环境。保存后，在聊天的「执行范围」中明确选用。' : '管理允许 Ely 接触的目录、网络与精确平台对象。保存授权不会自动加入会话。'}</p>
    {demo && <p className="text-xs text-fg-subtle">演示数据 · 配置仅在当前页面运行期间模拟，不执行脚本或修改资源。</p>}
    {runtime.info?.containerExecution && !runtime.info.containerExecution.available && <p role="status" className="text-xs text-warning">当前容器执行不可用：{runtime.info.containerExecution.reason ?? '执行器尚未就绪'}。配置可继续管理。</p>}
    <div className="flex flex-wrap items-center gap-2"><button type="button" className={CTL_PRIMARY} onClick={() => setEditing('new')}><Plus size={14} aria-hidden />新建{label}</button><ExtensionSearch label={`搜索${label}名称或范围`} value={search} onChange={setSearch} /><SelectDropdown ariaLabel={`${label}状态`} label="状态" items={filters} value={status} active={status !== 'all'} onSelect={setStatus} /><RefreshButton label={`刷新${label}`} busy={catalog.refreshing} onPress={() => void state.load(gateway, kind)} /></div>
    {action && <div role="alert" className="space-y-2 text-xs text-danger"><p>{action.result.message}</p>{action.result.status === 'unknown' && <button type="button" className={CTL_SECONDARY} onClick={() => setAction(undefined)}>我已核对列表与修订，允许继续操作</button>}</div>}
    <div className="relative min-w-0"><BusyVeil busy={catalog.refreshing} />
      {catalog.status === 'idle' || catalog.status === 'loading' ? <LoadingState label={`正在读取${label}…`} /> : catalog.status === 'error' ? <ErrorState title={`${label}读取失败`} description={catalog.error} onRetry={() => void state.load(gateway, kind)} /> : <>
        {catalog.error && <p role="alert" className="mb-3 text-xs text-danger">刷新失败：{catalog.error}；已保留上次读取结果。</p>}
        {!rows.length ? <EmptyState title={keyword || status !== 'all' ? `没有匹配的${label}` : `还没有${label}`} description={keyword || status !== 'all' ? '调整搜索或状态筛选查看其他记录。' : kind === 'profiles' ? '添加固定镜像和资源限额，供聊天中的脚本执行选用。' : '添加明确的目录、网络或平台对象范围。'} /> :
          <ExtensionTable label={`${label}列表`} columns={kind === 'profiles' ? profileColumns : grantColumns}>{rows.map(item => {
            const profile = kind === 'profiles' ? item as AgentExecutionProfile : undefined
            const grant = kind === 'grants' ? item as AgentExecutionGrant : undefined
            const blocked = state.busy.includes(`${kind}:${item.id}`) || (action?.id === item.id && action.result.status === 'unknown')
            return <tr key={item.id} className="hover:bg-surface-raised">
              <td className={cell}><span className="block truncate text-xs font-medium" title={item.name}>{item.name}</span><span className="text-xs text-fg-muted">修订 {item.revision}</span><code className="mt-1 block truncate text-xs text-fg-subtle" title={item.id}>{item.id}</code></td>
              {profile && <><td className={cell}><span className="block text-xs">{profile.runtime === 'bash' ? 'Bash' : profile.runtime === 'python' ? 'Python' : 'Node'}</span><code className="mt-1 block truncate text-xs text-fg-muted" title={profile.image}>{profile.image}</code></td><td className={`${cell} text-xs tabular-nums text-fg-muted`}><span className="block">{profile.timeoutSeconds} 秒 · {profile.cpuMillis / 1000} CPU</span><span className="block">{profile.memoryBytes / 1048576} MiB · {profile.pids} 进程</span></td></>}
              {grant && <td className={`${cell} text-xs text-fg-muted`}><div className="hover-scrollbar max-h-32 space-y-1 overflow-y-auto">
                {grant.directories.map((item, index) => <p key={`d${index}`} className={`break-all font-mono ${item.access === 'rw' ? 'text-danger' : ''}`}>{item.path} → /grants/{index} · {item.access}</p>)}
                {grant.network.map((item, index) => <p key={`n${index}`} className="break-all font-mono">{item.scheme}://{item.host}:{item.port}</p>)}
                {grant.resources?.map((item, index) => <p key={`r${index}`} className="break-all font-mono">{item.domain} / {item.id} · {item.access}</p>)}
                {grant.privateCidrs.map(item => <p key={item} className="break-all font-mono">私网：{item}</p>)}
              </div></td>}
              <td className={cell}><StatusTag label={item.enabled ? '已启用' : '已停用'} tone={item.enabled ? 'success' : 'neutral'} /></td>
              <td className={cell}><div className="flex flex-wrap items-center gap-1"><IconAction label={`编辑 ${item.name}`} disabled={blocked} onClick={() => setEditing(item)}><Pencil size={14} aria-hidden /></IconAction><button type="button" className="rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised disabled:opacity-40" disabled={blocked} onClick={() => item.enabled ? setDisable(item) : void toggle(item, true)}>{item.enabled ? '停用' : '启用'}</button><button type="button" className="rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised" onClick={() => setDetail(item)}>修订</button></div></td>
            </tr>
          })}</ExtensionTable>}
      </>}
    </div>
    {editing !== undefined && (kind === 'profiles' ? <ExecutionProfileDialog profile={editing === 'new' ? undefined : editing as AgentExecutionProfile} visible={active} onClose={() => setEditing(undefined)} /> : <ExecutionGrantDialog grant={editing === 'new' ? undefined : editing as AgentExecutionGrant} visible={active} onClose={() => setEditing(undefined)} />)}
    {detail && <ExecutionRevisionDialog kind={kind} item={detail} visible={active} onClose={() => setDetail(undefined)} />}
    <ExtensionDialog title={`停用${label}`} open={active && !!disable} onClose={() => { if (!state.busy.includes(`${kind}:${disable?.id}`)) setDisable(undefined) }} footer={<><button type="button" className={CTL_SECONDARY} disabled={state.busy.includes(`${kind}:${disable?.id}`)} onClick={() => setDisable(undefined)}>取消</button><button type="button" className={CTL_PRIMARY} disabled={state.busy.includes(`${kind}:${disable?.id}`)} onClick={() => { if (disable) void toggle(disable, false) }}>确认停用</button></>}>
      <p className="text-sm">停用「{disable?.name}」？</p><p className="text-xs leading-5 text-fg-muted">停用阻止后续使用并保留历史修订，不保证停止已派发的操作。已有会话中的选择会保留，需在执行范围中明确处理。</p>
    </ExtensionDialog>
  </div>
}

function ExecutionRevisionDialog({ kind, item, visible, onClose }: { kind: ExecutionKind; item: ExecutionItem; visible: boolean; onClose(): void }) {
  const gateway = useGateway()
  const [revision, setRevision] = useState(String(item.revision))
  const [detail, setDetail] = useState<ExecutionItem>()
  const [error, setError] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!visible) return
    const number = Number(revision)
    if (!Number.isSafeInteger(number) || number < 1 || number > item.revision) { setLoading(false); setError(`修订号须为 1–${item.revision} 的整数。`); setDetail(undefined); return }
    const controller = new AbortController(), auth = captureAuthGeneration()
    setLoading(true); setDetail(undefined); setError(undefined)
    void (kind === 'profiles' ? gateway.agentExecution.getProfile(item.id, number, controller.signal) : gateway.agentExecution.getGrant(item.id, number, controller.signal))
      .then(value => { if (!controller.signal.aborted && auth === captureAuthGeneration()) setDetail(value) })
      .catch(cause => { if (!controller.signal.aborted && auth === captureAuthGeneration()) setError(cause instanceof Error ? cause.message : '修订读取失败') })
      .finally(() => { if (!controller.signal.aborted && auth === captureAuthGeneration()) setLoading(false) })
    return () => controller.abort()
  }, [visible, revision, item.id, item.revision, gateway, kind, attempt])
  return <ExtensionDialog title={`${kind === 'profiles' ? '执行配置' : '资源授权'}修订`} open={visible} onClose={onClose} wide>
    <p className="break-all text-sm font-medium">{item.name}</p><p className="break-all font-mono text-xs text-fg-muted">{item.id}</p>
    <label className="flex items-center gap-3 text-xs">修订号<input aria-label="修订号" type="number" min={1} max={item.revision} value={revision} onChange={event => setRevision(event.target.value)} className={`${CTL_FIELD} w-28`} /></label>
    {loading && <p role="status" className="text-xs text-fg-muted">正在读取修订…</p>}{error && <p role="alert" className="text-xs text-danger">{error} <button className="underline" onClick={() => setAttempt(attempt + 1)}>重新读取</button></p>}
    {detail && <JsonView label="完整修订内容" text={JSON.stringify(detail, null, 2)} />}
  </ExtensionDialog>
}
