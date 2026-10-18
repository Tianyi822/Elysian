import { useEffect, useRef, useState } from 'react'
import type { AgentMCPCatalogProjection, AgentMCPServer, AgentMCPServerInput } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useAgentExtensionsStore } from '../../stores/agentExtensionsStore'
import { CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { Pencil, Plus, Trash2, Eye, EyeOff } from '../../components/icons'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { StatusTag } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { SelectDropdown } from '../../components/SelectDropdown'
import { ChipGroup } from '../../components/ChipGroup'
import { formatDateTime } from '../../components/format'
import { useFeedbackNotification } from '../../components/useFeedbackNotification'
import { JsonView } from './JsonView'
import { RevisionConflictNotice } from './RevisionConflictNotice'
import { useInFlightSubmit } from './useInFlightSubmit'
import { ExtensionDialog, ExtensionSearch, ExtensionTable, ExtensionToggle, Field, IconAction, extensionCell as cell } from './extensionUi'

const transports = [{ value: 'streamable-http', label: 'Streamable HTTP' }, { value: 'stdio', label: '容器 stdio' }] as const
const columns = [{ label: '服务名称', width: '22%' }, { label: '连接方式', width: '17%' }, { label: '地址 / 镜像', width: '32%' }, { label: '状态', width: '12%' }, { label: '操作', width: '17%' }]

export function McpSection({ active }: { active: boolean }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<AgentMCPServer | 'new'>()
  const [detail, setDetail] = useState<AgentMCPServer>()
  useEffect(() => { void state.loadMcpServers(gateway) }, [gateway, state.loadMcpServers])
  useFeedbackNotification(active && state.mcpStatus === 'ready' ? state.mcpErrorMessage : null)
  const rows = state.mcpServers.filter(server => [server.name, server.url, server.stdio?.image].some(value => value?.toLowerCase().includes(search.trim().toLowerCase())))
  return <div className="flex flex-col gap-3">
    <div className="flex flex-wrap items-center gap-2"><button type="button" className={CTL_PRIMARY} onClick={() => setEditing('new')}><Plus aria-hidden size={14} />新建 MCP 服务</button><ExtensionSearch label="搜索服务名称、地址或镜像" value={search} onChange={setSearch} /><RefreshButton label="刷新 MCP 服务" busy={state.mcpRefreshing} onPress={() => void state.loadMcpServers(gateway)} /></div>
    <div className="busy-host relative"><BusyVeil busy={state.mcpRefreshing} />
      {state.mcpStatus === 'idle' || state.mcpStatus === 'loading' ? <LoadingState label="正在读取 MCP 服务…" /> : state.mcpStatus === 'error' ? <ErrorState title="MCP 配置读取失败" description={state.mcpErrorMessage} onRetry={() => void state.loadMcpServers(gateway)} /> : rows.length === 0 ? <EmptyState title={search ? '没有匹配的 MCP 服务' : '还没有 MCP 服务'} description={search ? '换个关键词，或清空搜索查看全部服务。' : '添加 HTTP 或容器 stdio 服务，保存后可探测工具、资源与提示词。'} /> :
        <>{state.mcpErrorMessage && <p role="alert" className="mb-2 text-xs text-danger">刷新失败：{state.mcpErrorMessage}；当前保留的是上次读取结果。</p>}<ExtensionTable label="MCP 服务列表" columns={columns}>{rows.map(server => <tr key={server.id} className="hover:bg-surface-raised">
          <td className={cell}><span className="block truncate text-xs font-medium" title={server.name}>{server.name}</span></td>
          <td className={`${cell} text-xs text-fg-muted`}>{server.transport === 'stdio' ? '容器 stdio' : 'Streamable HTTP'}</td>
          <td className={cell}><span className="block truncate font-mono text-xs" title={server.url ?? server.stdio?.image}>{server.url ?? server.stdio?.image}</span><span className="text-xs text-fg-subtle">{server.transport === 'stdio' ? server.stdio?.hasEnvironment ? '已配置环境变量' : '无环境变量' : server.hasCredential ? '已配置 Bearer Token' : '无身份验证'}</span></td>
          <td className={cell}><StatusTag label={server.revoked ? '已永久撤销' : server.active ? '已启用' : '已停用'} tone={server.revoked ? 'danger' : server.active ? 'success' : 'neutral'} /></td>
          <td className={cell}><div className="flex flex-wrap items-center gap-1"><IconAction label={`编辑 ${server.name}`} disabled={server.revoked} onClick={() => setEditing(server)}><Pencil aria-hidden size={14} /></IconAction><button type="button" className="rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised" onClick={() => setDetail(server)}>详情</button><button type="button" className="rounded-md px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised disabled:opacity-40" disabled={!server.active || server.revoked || state.probe?.status === 'loading'} onClick={() => void state.probeMcpServer(gateway, server.id, server.revision)}>探测</button></div>{server.transport === 'stdio' && <p className="mt-1 text-[11px] text-fg-subtle">探测会启动容器</p>}</td>
        </tr>)}</ExtensionTable></>}
    </div>
    {editing !== undefined && <McpServerDialog server={editing === 'new' ? undefined : editing} visible={active} onClose={() => setEditing(undefined)} />}
    {detail && <McpDetailDialog initial={detail} visible={active} onClose={() => { setDetail(undefined); state.closeCatalog() }} />}
    <ExtensionDialog title="MCP 探测结果" open={active && state.probe !== null} onClose={state.closeProbe} wide>
      {state.probe?.status === 'loading' && <LoadingState label="正在连接服务并读取目录…" />}
      {state.probe?.status === 'error' && <div role="alert" className="text-xs text-danger">{state.probe.errorMessage}{state.probe.resourceBusy && <p className="mt-2">存在尚未确认的执行，请由管理员通过 API 核实后再探测。</p>}</div>}
      {state.probe?.status === 'ready' && state.probe.projection && <><p role="status" className="text-xs text-success">本次探测成功</p><McpCatalog catalog={state.probe.projection} /></>}
    </ExtensionDialog>
  </div>
}

function McpServerDialog({ server, visible, onClose }: { server?: AgentMCPServer; visible: boolean; onClose(): void }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const latest = state.mcpServers.find(item => item.id === server?.id)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [revision, setRevision] = useState(server?.revision ?? 0)
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<AgentMCPServer['transport']>(server?.transport ?? 'streamable-http')
  const [url, setUrl] = useState(server?.url ?? '')
  const [credential, setCredential] = useState('')
  const [clearCredential, setClearCredential] = useState(false)
  const [showCredential, setShowCredential] = useState(false)
  const [image, setImage] = useState(server?.stdio?.image ?? '')
  const [command, setCommand] = useState<string[]>([...(server?.stdio?.command ?? [''])])
  const [environmentMode, setEnvironmentMode] = useState<'keep' | 'replace' | 'clear'>('keep')
  const [environment, setEnvironment] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }])
  const [grantId, setGrantId] = useState(server?.stdio?.grantId ?? '')
  const [grantRevision, setGrantRevision] = useState(server?.stdio?.grantRevision?.toString() ?? '')
  const [enabled, setEnabled] = useState(server?.active ?? true)
  const [error, setError] = useState<string>()
  useEffect(() => { state.clearMcpSaveError() }, [state.clearMcpSaveError])
  useFeedbackNotification(visible ? error ?? state.mcpSaveError : null)
  const submit = async () => {
    setError(undefined)
    if (!name.trim()) { setError('请填写服务名称'); return }
    let env: Record<string, string> | undefined
    if (transport === 'streamable-http') {
      try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error() } catch { setError('服务地址须为 HTTP/HTTPS 地址，不能包含凭据、查询参数或片段'); return }
    } else {
      if (!image.trim() || !command[0]?.trim()) { setError('请填写容器镜像与可执行文件'); return }
      if (command.length > 64 || command.some(arg => arg.includes('\0') || new TextEncoder().encode(arg).length > 4096)) { setError('命令最多 64 项，单项不能超过 4096 字节或包含 NUL'); return }
      if ((grantId.trim() === '') !== (grantRevision.trim() === '') || (grantId.trim() && (!Number.isSafeInteger(Number(grantRevision)) || Number(grantRevision) < 1))) { setError('授权编号和正整数修订须一起填写，或一起留空'); return }
      if (environmentMode === 'clear') env = {}
      if (environmentMode === 'replace') {
        env = Object.create(null) as Record<string, string>
        for (const [index, row] of environment.entries()) {
          if (!row.key && !row.value) continue
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key) || Object.hasOwn(env, row.key)) { setError(`第 ${index + 1} 行环境变量名无效或重复`); return }
          env[row.key] = row.value
        }
      }
    }
    const input: AgentMCPServerInput = { name: name.trim(), transport, active: enabled, revoked: server?.revoked ?? false,
      ...(transport === 'streamable-http' ? { url: url.trim(), ...(clearCredential ? { credential: '' } : credential ? { credential } : {}) } : { stdio: { image: image.trim(), command, ...(env !== undefined ? { environment: env } : {}), ...(grantId.trim() ? { grantId: grantId.trim(), grantRevision: Number(grantRevision) } : {}) } }),
    }
    const ok = await inFlightOnly(() => server ? state.updateMcpServer(gateway, server.id, { ...input, expectedRevision: revision }) : state.createMcpServer(gateway, input))
    if (ok && alive.current) onClose()
  }
  return <ExtensionDialog title={server ? '编辑 MCP 服务' : '新建 MCP 服务'} open={visible} onClose={onClose} footer={<><button type="button" className={CTL_SECONDARY} onClick={onClose}>取消</button><button type="submit" form="mcp-service-form" className={CTL_PRIMARY} disabled={submitting || latest?.revoked}>{submitting ? '正在保存…' : '保存配置'}</button></>}>
    <form id="mcp-service-form" onSubmit={event => { event.preventDefault(); void submit() }}><fieldset disabled={submitting || latest?.revoked} className="flex min-w-0 flex-col gap-4">
      <p className="text-xs leading-5 text-fg-subtle">保存后可手动探测服务。启用配置不会自动加入聊天会话。</p>
      <Field label="服务名称" id="mcp-name"><input id="mcp-name" value={name} onChange={event => setName(event.target.value)} required maxLength={120} className={CTL_FIELD} /></Field>
      <Field label="连接方式" id="mcp-transport"><SelectDropdown id="mcp-transport" ariaLabel="连接方式" value={transport} onSelect={setTransport} items={transports} fullWidth /></Field>
      {transport === 'streamable-http' ? <>
        <Field label="服务地址" id="mcp-url"><input id="mcp-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://mcp.example.com/mcp" className={`${CTL_FIELD} font-mono text-xs`} /></Field>
        <Field label="Bearer Token（可选）" id="mcp-token"><div className="relative"><input id="mcp-token" type={showCredential ? 'text' : 'password'} autoComplete="new-password" value={credential} onChange={event => { setCredential(event.target.value); setClearCredential(false) }} placeholder={server?.hasCredential ? '留空沿用已保存的 Token' : '无身份验证时留空'} className={`${CTL_FIELD} w-full pr-9 font-mono text-xs`} /><div className="absolute right-1 top-0.5"><IconAction label={showCredential ? '隐藏 Token' : '显示输入的 Token'} onClick={() => setShowCredential(!showCredential)}>{showCredential ? <EyeOff size={14} /> : <Eye size={14} />}</IconAction></div></div>{server?.hasCredential && <button type="button" className={`${CTL_SECONDARY} mt-2 self-start`} onClick={() => { setClearCredential(!clearCredential); setCredential('') }}>{clearCredential ? '撤销清除 Token' : '清除已保存的 Token'}</button>}<p className="mt-1 text-xs text-fg-subtle">{clearCredential ? '保存后清除现有 Token。' : '已有凭据不回显；输入新值替换，留空沿用。'}</p></Field>
      </> : <>
        <Field label="容器镜像" id="mcp-image"><input id="mcp-image" required value={image} onChange={event => setImage(event.target.value)} placeholder="registry.example.com/mcp/server:1.0" className={`${CTL_FIELD} font-mono text-xs`} /></Field>
        <fieldset className="space-y-2"><legend className="mb-2 text-xs font-medium">启动命令</legend>{command.map((arg, index) => <div key={index} className="flex items-end gap-2"><div className="min-w-0 flex-1"><Field label={index === 0 ? '可执行文件' : `参数 ${index}`} id={`mcp-arg-${index}`}><input id={`mcp-arg-${index}`} required={index === 0} value={arg} onChange={event => setCommand(rows => rows.map((row, i) => i === index ? event.target.value : row))} className={`${CTL_FIELD} font-mono text-xs`} /></Field></div>{index > 0 && <IconAction label={`移除参数 ${index}`} onClick={() => setCommand(rows => rows.filter((_, i) => i !== index))}><Trash2 size={14} /></IconAction>}</div>)}<button type="button" className={CTL_SECONDARY} disabled={command.length >= 64} onClick={() => setCommand([...command, ''])}>添加参数</button></fieldset>
        <div className="space-y-2"><Field label="环境变量" id="mcp-env-mode"><SelectDropdown id="mcp-env-mode" ariaLabel="环境变量处理方式" value={environmentMode} onSelect={setEnvironmentMode} fullWidth items={[{ value: 'keep', label: server?.stdio?.hasEnvironment ? '保留已保存的环境变量' : '不设置环境变量' }, { value: 'replace', label: '整体替换环境变量' }, { value: 'clear', label: '清除全部环境变量' }]} /></Field>
          {environmentMode === 'replace' && <>{environment.map((row, index) => <div key={index} className="flex items-end gap-2"><div className="min-w-0 flex-1"><Field label={`变量名 ${index + 1}`} id={`mcp-env-key-${index}`}><input id={`mcp-env-key-${index}`} value={row.key} onChange={event => setEnvironment(rows => rows.map((item, i) => i === index ? { ...item, key: event.target.value } : item))} className={`${CTL_FIELD} font-mono text-xs`} /></Field></div><div className="min-w-0 flex-1"><Field label={`变量值 ${index + 1}`} id={`mcp-env-value-${index}`}><input id={`mcp-env-value-${index}`} type="password" autoComplete="new-password" value={row.value} onChange={event => setEnvironment(rows => rows.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} className={`${CTL_FIELD} font-mono text-xs`} /></Field></div><IconAction label={`移除环境变量 ${index + 1}`} onClick={() => setEnvironment(rows => rows.filter((_, i) => i !== index))}><Trash2 size={14} /></IconAction></div>)}<button type="button" className={CTL_SECONDARY} onClick={() => setEnvironment([...environment, { key: '', value: '' }])}>添加环境变量</button><p className="text-xs text-fg-subtle">保存后整体替换；已有变量值不回显。</p></>}
        </div>
        <details className="border-t border-line pt-3"><summary className="cursor-pointer text-xs font-medium">高级设置</summary><div className="mt-3 grid grid-cols-2 gap-3"><Field label="授权编号（可选）" id="mcp-grant"><input id="mcp-grant" value={grantId} onChange={event => setGrantId(event.target.value)} className={CTL_FIELD} /></Field><Field label="授权修订" id="mcp-grant-revision"><input id="mcp-grant-revision" type="number" min={1} step={1} value={grantRevision} onChange={event => setGrantRevision(event.target.value)} className={CTL_FIELD} /></Field></div><p className="mt-2 text-xs text-fg-subtle">引用已有授权及其具体修订。留空表示无目录挂载和网络授权。</p></details>
      </>}
      <ExtensionToggle label="启用服务" checked={enabled} onChange={setEnabled} />
      {(error || state.mcpSaveError) && <p role="alert" className="text-xs text-danger">{error ?? state.mcpSaveError}</p>}
      {server && <RevisionConflictNotice latest={latest} baseRevision={revision} onAccept={next => { setRevision(next); state.clearMcpSaveError() }} />}
    </fieldset></form>
  </ExtensionDialog>
}


function McpDetailDialog({ initial, visible, onClose }: { initial: AgentMCPServer; visible: boolean; onClose(): void }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const [server, setServer] = useState(initial)
  const [revision, setRevision] = useState(initial.revision.toString())
  const [selectedRevision, setSelectedRevision] = useState(initial.revision)
  const [error, setError] = useState<string>()
  useEffect(() => {
    let cancelled = false
    setError(undefined)
    void gateway.agentExtensions.getMcpServer(initial.id, selectedRevision).then(item => { if (!cancelled) setServer(item) }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : '修订读取失败') })
    void state.loadMcpCatalog(gateway, initial.id, selectedRevision)
    return () => { cancelled = true }
  }, [gateway, initial.id, selectedRevision, state.loadMcpCatalog])
  return <ExtensionDialog title={`MCP 详情 · ${initial.name}`} open={visible} onClose={onClose} wide>
    {error ? <p role="alert" className="text-xs text-danger">{error}</p> : <dl className="grid grid-cols-[5rem_1fr] gap-2 text-xs"><dt className="text-fg-subtle">连接方式</dt><dd>{server.transport === 'stdio' ? '容器 stdio' : 'Streamable HTTP'}</dd><dt className="text-fg-subtle">地址 / 镜像</dt><dd className="break-all font-mono">{server.url ?? server.stdio?.image}</dd><dt className="text-fg-subtle">状态</dt><dd>{server.revoked ? '已永久撤销' : server.active ? '已启用' : '已停用'}</dd></dl>}
    {state.catalog?.status === 'loading' && <LoadingState label="正在读取已保存的目录…" />}
    {state.catalog?.status === 'error' && <p role="status" className="text-xs text-fg-muted">{state.catalog.errorMessage}。可返回列表手动探测。</p>}
    {state.catalog?.status === 'ready' && state.catalog.projection && <McpCatalog catalog={state.catalog.projection} />}
    <details className="border-t border-line pt-3"><summary className="cursor-pointer text-xs font-medium">配置与历史修订</summary><div className="my-3 flex items-end gap-2"><Field label="修订号" id="mcp-history-revision"><input id="mcp-history-revision" type="number" min={1} step={1} value={revision} onChange={event => setRevision(event.target.value)} className={`${CTL_FIELD} w-24`} /></Field><button type="button" className={CTL_SECONDARY} disabled={!Number.isSafeInteger(Number(revision)) || Number(revision) < 1} onClick={() => setSelectedRevision(Number(revision))}>读取修订</button></div>{!error && <JsonView label="公开配置" text={JSON.stringify(server, null, 2)} />}</details>
  </ExtensionDialog>
}

function McpCatalog({ catalog }: { catalog: AgentMCPCatalogProjection }) {
  const [tab, setTab] = useState<'tools' | 'resources' | 'prompts'>('tools')
  return <div className="space-y-3"><p className="text-xs text-fg-subtle">目录获取于 {formatDateTime(catalog.fetchedAt)}</p><ChipGroup ariaLabel="MCP 目录分类" value={tab} onSelect={setTab} items={[{ value: 'tools', label: `工具 ${catalog.tools.length}` }, { value: 'resources', label: `资源 ${catalog.resources.length}` }, { value: 'prompts', label: `提示词 ${catalog.prompts.length}` }]} />
    {catalog[tab].length === 0 ? <p className="py-3 text-xs text-fg-subtle">此目录没有{tab === 'tools' ? '工具' : tab === 'resources' ? '资源' : '提示词'}。</p> : catalog[tab].map((item, index) => <details key={`${tab}-${index}`} className="rounded-lg border border-line p-3"><summary className="cursor-pointer break-words text-xs font-medium">{'title' in item && item.title ? item.title : item.name}</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs text-fg-muted">{item.description ?? '无描述'}</p><div className="mt-3"><JsonView label="目录条目" text={JSON.stringify(item, null, 2)} /></div></details>)}
    <details><summary className="cursor-pointer text-xs text-fg-subtle">目录技术信息</summary><div className="mt-2"><JsonView label="协议与别名" text={JSON.stringify({ protocolVersion: catalog.protocolVersion, digest: catalog.digest, modelAliases: catalog.modelAliases, resourceAliases: catalog.resourceAliases, promptAliases: catalog.promptAliases }, null, 2)} /></div></details>
  </div>
}
