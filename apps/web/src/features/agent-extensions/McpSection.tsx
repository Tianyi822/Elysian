import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import type { AgentMCPCatalogProjection, AgentMCPServer } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { JsonView } from '../../components/agent/JsonView'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CopyButton } from '../../components/CopyButton'
import { CTL_CARD_ACTION, CTL_FIELD, CTL_PRIMARY, CTL_SECONDARY } from '../../components/formControl'
import { formatDateTime } from '../../components/format'
import { Pencil, Plus, Trash2, X } from '../../components/icons'
import { BusyVeil, RefreshButton } from '../../components/RefreshState'
import { StatusTag } from '../../components/StatusTag'
import { EmptyState, ErrorState, LoadingState } from '../../components/states/StateViews'
import { useAgentExtensionsStore } from '../../stores/agentExtensionsStore'

/*
 * MCP 服务页签：列表（transport / url 或容器镜像 / grant 绑定 / active，凭据与
 * 环境变量只写不回显）、新建与编辑（无 requestId，inFlightOnly 单飞）、探测
 * （请求体仅 {revision}，返回目录投影：capabilities、tools/resources/prompts 与
 * 三组别名映射、digest/fetchedAt）与按 revision+digest 读取的固定目录查看器。
 * 探测被 409 resource-busy 拒绝时提示先到治理中心核实租约并深链
 * /agent/approvals?tab=locks；digest 不符按服务端 404 文案透传。
 */

const TRANSPORT_LABELS: Record<AgentMCPServer['transport'], string> = {
  'streamable-http': 'HTTP（Streamable HTTP）',
  stdio: '容器 stdio',
}

export function McpSection({ serverIdParam, revisionParam }: { serverIdParam?: string | null; revisionParam?: string | null }) {
  const gateway = useGateway()
  const state = useAgentExtensionsStore()
  const [editing, setEditing] = useState<AgentMCPServer | 'new' | undefined>(undefined)
  const [revisionTarget, setRevisionTarget] = useState<{ serverId: string; revision: number } | undefined>(undefined)

  useEffect(() => {
    void state.loadMcpServers(gateway)
    // 深链 /agent/extensions?tab=mcp&serverId=&revision=：按固定修订打开详情。
    if (serverIdParam !== null && serverIdParam !== undefined && serverIdParam !== '') {
      const revision = Number.parseInt(revisionParam ?? '', 10)
      if (Number.isSafeInteger(revision) && revision >= 1) {
        setRevisionTarget({ serverId: serverIdParam, revision })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway])

  return (
    <div className="flex flex-col gap-4">
      <section aria-label="MCP 服务列表" className="relative panel-surface overflow-hidden">
        <BusyVeil busy={state.mcpRefreshing} />
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">MCP 服务</h2>
          <div className="flex items-center gap-2">
            <RefreshButton label="刷新 MCP 服务" onPress={() => void state.loadMcpServers(gateway)} busy={state.mcpRefreshing} />
            <button type="button" className={`${CTL_PRIMARY} px-3`} onClick={() => setEditing('new')}>
              新建 MCP 服务
            </button>
          </div>
        </div>
        {state.mcpStatus === 'loading' ? <LoadingState label="正在读取 MCP 服务…" /> : null}
        {state.mcpStatus === 'error' ? (
          <div className="p-4">
            <ErrorState description={state.mcpErrorMessage} onRetry={() => void state.loadMcpServers(gateway)} />
          </div>
        ) : null}
        {state.mcpStatus === 'ready' && state.mcpServers.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="还没有 MCP 服务"
              description="新建 HTTP 或容器 stdio 服务后，可现场探测其目录（tools / resources / prompts）并固定读取。"
              action={
                <button type="button" className={`${CTL_SECONDARY} mt-1 px-2`} onClick={() => setEditing('new')}>
                  新建第一个服务
                </button>
              }
            />
          </div>
        ) : null}
        {state.mcpStatus === 'ready' && state.mcpServers.length > 0 ? (
          <McpServersTable
            onEdit={(server) => setEditing(server)}
            onRevision={(serverId, revision) => setRevisionTarget({ serverId, revision })}
          />
        ) : null}
      </section>
      {editing !== undefined ? (
        <McpServerDialog server={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} />
      ) : null}
      {revisionTarget !== undefined ? (
        <McpRevisionDialog target={revisionTarget} onClose={() => setRevisionTarget(undefined)} />
      ) : null}
      <ProbeDialog />
      <CatalogDialog />
    </div>
  )
}

function McpServersTable({ onEdit, onRevision }: {
  onEdit(server: AgentMCPServer): void
  onRevision(serverId: string, revision: number): void
}) {
  const gateway = useGateway()
  const servers = useAgentExtensionsStore((state) => state.mcpServers)
  const probe = useAgentExtensionsStore((state) => state.probeMcpServer)
  const openCatalog = useAgentExtensionsStore((state) => state.loadMcpCatalog)
  const catalog = useAgentExtensionsStore((state) => state.catalog)
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[54rem] table-fixed border-separate border-spacing-0 text-left text-sm">
        <colgroup>
          <col className="w-[18%]" />
          <col className="w-[13%]" />
          <col className="w-[22%]" />
          <col className="w-[13%]" />
          <col className="w-[10%]" />
          <col className="w-[7%]" />
          <col className="w-[17%]" />
        </colgroup>
        <thead>
          <tr>
            {['名称', '传输', '地址 / 镜像', '授权绑定', '凭据 / 环境', '修订', '操作'].map((label) => (
              <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {servers.map((server) => (
            <tr key={`${server.id}@${server.revision}`} className="hover:bg-surface-raised/50">
              <td className="border-b border-line px-3 py-2.5">
                <p className="truncate font-medium" title={server.name}>{server.name}</p>
                <p className="truncate text-xs text-fg-subtle tabular-nums" title={server.id}>{server.id}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <StatusTag label={server.active ? '已启用' : '已停用'} tone={server.active ? 'success' : 'neutral'} />
                  {server.revoked ? <StatusTag label="已永久撤销" tone="danger" /> : null}
                </div>
              </td>
              <td className="border-b border-line px-3 py-2.5 text-xs text-fg-muted">{TRANSPORT_LABELS[server.transport]}</td>
              <td className="border-b border-line px-3 py-2.5">
                <p className="truncate font-mono text-xs text-fg-muted" title={server.transport === 'streamable-http' ? (server.url ?? '') : (server.stdio?.image ?? '')}>
                  {server.transport === 'streamable-http' ? server.url : server.stdio?.image}
                </p>
                {server.stdio !== undefined ? (
                  <p className="truncate font-mono text-xs text-fg-subtle" title={server.stdio.command.join(' ')}>
                  {JSON.stringify(server.stdio.command)}
                  </p>
                ) : null}
              </td>
              <td className="border-b border-line px-3 py-2.5 text-xs tabular-nums text-fg-muted">
                {server.stdio?.grantId !== undefined
                  ? `${server.stdio.grantId} @ ${server.stdio.grantRevision ?? '—'}`
                  : server.transport === 'stdio' ? '无' : '—'}
              </td>
              <td className="border-b border-line px-3 py-2.5">
                <div className="flex flex-col items-start gap-1">
                  {server.transport === 'streamable-http'
                    ? server.hasCredential
                      ? <StatusTag label="凭据已保存" tone="success" />
                      : <StatusTag label="无凭据" tone="neutral" />
                    : null}
                  {server.stdio !== undefined
                    ? server.stdio.hasEnvironment
                      ? <StatusTag label="环境变量已保存" tone="success" />
                      : <StatusTag label="无环境变量" tone="neutral" />
                    : null}
                </div>
              </td>
              <td className="tabular-nums border-b border-line px-3 py-2.5 text-xs text-fg-muted">{server.revision}</td>
              <td className="border-b border-line px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" className={CTL_CARD_ACTION} disabled={server.revoked} title={server.revoked ? '已撤销的服务不能重新启用' : undefined} onClick={() => onEdit(server)}>
                    <span className="inline-flex items-center gap-1">
                      <Pencil aria-hidden size={12} />
                      编辑
                    </span>
                  </button>
                  <button
                    type="button"
                    className={CTL_CARD_ACTION}
                    disabled={catalog?.serverId === server.id && catalog.status === 'loading'}
                    onClick={() => openCatalog(gateway, server.id, server.revision)}
                  >
                    目录
                  </button>
                  <button
                    type="button"
                    className={CTL_CARD_ACTION}
                    disabled={!server.active || server.revoked || (catalog?.serverId === server.id && catalog.status === 'loading')}
                    title={server.revoked ? '已撤销的服务不能探测' : server.active ? undefined : '已停用的服务不能开始新探测'}
                    onClick={() => void probe(gateway, server.id, server.revision)}
                  >
                    探测
                  </button>
                  <button type="button" className={CTL_CARD_ACTION} onClick={() => onRevision(server.id, server.revision)}>
                    修订详情
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type EnvChoice = 'keep' | 'edit'

function McpServerDialog({ server, onClose }: { server?: AgentMCPServer; onClose(): void }) {
  const gateway = useGateway()
  const createServer = useAgentExtensionsStore((state) => state.createMcpServer)
  const updateServer = useAgentExtensionsStore((state) => state.updateMcpServer)
  const mcpSaving = useAgentExtensionsStore((state) => state.mcpSaving)
  const mcpSaveError = useAgentExtensionsStore((state) => state.mcpSaveError)
  const clearMcpSaveError = useAgentExtensionsStore((state) => state.clearMcpSaveError)
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [name, setName] = useState(server?.name ?? '')
  const [transport, setTransport] = useState<AgentMCPServer['transport']>(server?.transport ?? 'streamable-http')
  const [url, setUrl] = useState(server?.url ?? '')
  const [credential, setCredential] = useState('')
  const [clearCredential, setClearCredential] = useState(false)
  const [image, setImage] = useState(server?.stdio?.image ?? '')
  const [commandArgs, setCommandArgs] = useState<string[]>([...(server?.stdio?.command ?? ['mcp-server'])])
  const [grantId, setGrantId] = useState(server?.stdio?.grantId ?? '')
  const [grantRevisionText, setGrantRevisionText] = useState(server?.stdio?.grantRevision !== undefined ? String(server.stdio.grantRevision) : '')
  const [envText, setEnvText] = useState('')
  const [envChoice, setEnvChoice] = useState<EnvChoice>('keep')
  const [active, setActive] = useState(server?.active ?? true)
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    clearMcpSaveError()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = async () => {
    setErrorMessage(undefined)
    if (!name.trim()) {
      setErrorMessage('服务名称不能为空')
      return
    }
    const grantRevision = grantRevisionText.trim() === '' ? undefined : Number.parseInt(grantRevisionText, 10)
    if ((grantId.trim() === '') !== (grantRevision === undefined)) {
      setErrorMessage('容器授权必须同时提供授权编号与具体修订，或都不提供')
      return
    }
    if (grantRevision !== undefined && (!Number.isSafeInteger(grantRevision) || grantRevision < 1)) {
      setErrorMessage('授权修订必须是正整数')
      return
    }
    if (transport === 'stdio') {
      if (commandArgs.length < 1 || commandArgs.length > 64 || commandArgs[0] === '') {
        setErrorMessage('启动命令须包含 1 至 64 个参数，且第一个参数不能为空')
        return
      }
      if (commandArgs.some((arg) => arg.includes('\0') || new TextEncoder().encode(arg).length > 4096)) {
        setErrorMessage('单个命令参数不能包含 NUL，且不能超过 4096 字节')
        return
      }
    }
    let environment: Record<string, string> | undefined
    if (transport === 'stdio' && envChoice === 'edit') {
      environment = {}
      for (const line of envText.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '' || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq <= 0) {
          setErrorMessage(`环境变量行「${trimmed}」无效：每行必须是 KEY=VALUE`)
          return
        }
        const key = trimmed.slice(0, eq).trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          setErrorMessage(`环境变量名「${key}」无效：只允许字母、数字与下划线且不以数字开头`)
          return
        }
        environment[key] = trimmed.slice(eq + 1)
      }
    }
    const ok = await inFlightOnly(() => {
      const base = {
        name: name.trim(),
        transport,
        ...(transport === 'streamable-http' ? { url: url.trim() } : {}),
        ...(transport === 'stdio' ? {
          stdio: {
            image: image.trim(),
            command: commandArgs,
            ...(grantId.trim() !== '' && grantRevision !== undefined ? { grantId: grantId.trim(), grantRevision } : {}),
            ...(environment !== undefined ? { environment } : {}),
          },
        } : {}),
        active,
        revoked: server?.revoked ?? false,
        ...(transport === 'streamable-http'
          ? { credential: clearCredential ? '' : (credential === '' ? undefined : credential) }
          : {}),
      }
      return server === undefined
        ? createServer(gateway, base)
        : updateServer(gateway, server.id, { ...base, expectedRevision: server.revision })
    })
    if (ok) onClose()
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">
              {server === undefined ? '新建 MCP 服务' : `编辑「${server.name}」（修订 ${server.revision}）`}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭 MCP 服务表单" className="rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg">
                <X aria-hidden size={14} />
              </button>
            </Dialog.Close>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
            className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1"
          >
            <div>
              <label htmlFor="agent-mcp-name" className="block text-xs text-fg-muted">名称</label>
              <input id="agent-mcp-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} className={`${CTL_FIELD} mt-1 h-9 w-full`} />
            </div>
            <fieldset className="rounded-lg border border-line p-2.5">
              <legend className="px-1 text-xs text-fg-muted">传输</legend>
              <div className="flex flex-wrap items-center gap-4">
                <label className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="agent-mcp-transport"
                    checked={transport === 'streamable-http'}
                    onChange={() => setTransport('streamable-http')}
                  />
                  HTTP（Streamable HTTP）
                </label>
                <label className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="agent-mcp-transport"
                    checked={transport === 'stdio'}
                    onChange={() => setTransport('stdio')}
                  />
                  容器 stdio
                </label>
              </div>
            </fieldset>
            {transport === 'streamable-http' ? (
              <>
                <div>
                  <label htmlFor="agent-mcp-url" className="block text-xs text-fg-muted">服务地址（HTTP/HTTPS，不含凭据、查询参数或片段）</label>
                  <input id="agent-mcp-url" type="url" value={url} onChange={(event) => setUrl(event.target.value)} required placeholder="https://mcp.example.com/mcp" className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`} />
                  <p className="mt-1 text-xs text-fg-subtle">HTTP MCP 由父进程直连配置地址，不套用容器出网授权。</p>
                </div>
                <fieldset className="rounded-lg border border-line p-2.5">
                  <legend className="px-1 text-xs text-fg-muted">凭据（只写不回显）</legend>
                  <input
                    id="agent-mcp-credential"
                    type="password"
                    value={credential}
                    onChange={(event) => {
                      setCredential(event.target.value)
                      setClearCredential(false)
                    }}
                    autoComplete="new-password"
                    placeholder={server?.hasCredential ? '留空保存＝沿用现有凭据' : '输入服务凭据（如无可留空）'}
                    className={`${CTL_FIELD} h-9 w-full font-mono text-xs`}
                  />
                  {server !== undefined && server.hasCredential ? (
                    <button
                      type="button"
                      aria-pressed={clearCredential}
                      onClick={() => setClearCredential((value) => !value)}
                      className={`${CTL_SECONDARY} mt-2 px-2`}
                    >
                      {clearCredential ? '撤销清除' : '清除凭据'}
                    </button>
                  ) : null}
                  <p className="mt-1.5 text-xs text-fg-subtle">
                    {clearCredential ? '保存后将清除现有凭据。' : '凭据只提交不回显：输入新值即替换，留空保存即沿用。'}
                  </p>
                </fieldset>
              </>
            ) : (
              <>
                <div>
                  <label htmlFor="agent-mcp-image" className="block text-xs text-fg-muted">容器镜像</label>
                  <input id="agent-mcp-image" value={image} onChange={(event) => setImage(event.target.value)} required placeholder="registry.example.com/mcp/demo:1.0.0" className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`} />
                </div>
                <fieldset className="min-w-0">
                  <legend className="text-xs text-fg-muted">启动命令（逐参数）</legend>
                  <div className="mt-1 flex flex-col gap-2">
                    {commandArgs.map((arg, index) => (
                      <div key={index} className="flex min-w-0 items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <label htmlFor={`agent-mcp-command-${index}`} className="block text-xs text-fg-subtle">
                            {index === 0 ? '可执行文件' : `参数 ${index}`}
                          </label>
                          <input
                            id={`agent-mcp-command-${index}`}
                            value={arg}
                            onChange={(event) => setCommandArgs((current) => current.map((part, partIndex) => partIndex === index ? event.target.value : part))}
                            required={index === 0}
                            className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`}
                          />
                        </div>
                        <button
                          type="button"
                          aria-label={`移除${index === 0 ? '可执行文件' : `参数 ${index}`}`}
                          title={commandArgs.length === 1 ? '命令至少需要一个参数' : '移除参数'}
                          disabled={commandArgs.length === 1}
                          onClick={() => setCommandArgs((current) => current.filter((_, partIndex) => partIndex !== index))}
                          className={`${CTL_SECONDARY} h-9 w-9 shrink-0 px-0`}
                        >
                          <Trash2 aria-hidden size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={commandArgs.length >= 64}
                    onClick={() => setCommandArgs((current) => [...current, ''])}
                    className={`${CTL_SECONDARY} mt-2 gap-1.5 px-2`}
                  >
                    <Plus aria-hidden size={14} />
                    添加参数
                  </button>
                </fieldset>
                <fieldset className="rounded-lg border border-line p-2.5">
                  <legend className="px-1 text-xs text-fg-muted">容器授权（可选；stdio 挂载与出网必须固定具体修订）</legend>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label htmlFor="agent-mcp-grant-id" className="block text-xs text-fg-subtle">授权编号</label>
                      <input id="agent-mcp-grant-id" value={grantId} onChange={(event) => setGrantId(event.target.value)} placeholder="留空表示无目录与网络授权" className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`} />
                    </div>
                    <div>
                      <label htmlFor="agent-mcp-grant-revision" className="block text-xs text-fg-subtle">授权修订（正整数）</label>
                      <input id="agent-mcp-grant-revision" type="number" min={1} step={1} value={grantRevisionText} onChange={(event) => setGrantRevisionText(event.target.value)} className={`${CTL_FIELD} mt-1 h-9 w-full tabular-nums`} />
                    </div>
                  </div>
                </fieldset>
                <fieldset className="rounded-lg border border-line p-2.5">
                  <legend className="px-1 text-xs text-fg-muted">环境变量（只写不回显）</legend>
                  {server !== undefined && server.stdio?.hasEnvironment && envChoice === 'keep' ? (
                    <p className="text-xs text-fg-subtle">
                      该服务已保存环境变量（值不回显）。在下面输入新内容并保存即替换；不输入直接保存则沿用。
                      <button type="button" className={`${CTL_SECONDARY} ml-2 px-2`} onClick={() => setEnvChoice('edit')}>
                        编辑环境变量
                      </button>
                    </p>
                  ) : (
                    <>
                      <textarea
                        id="agent-mcp-environment"
                        aria-label="环境变量（KEY=VALUE，每行一个）"
                        value={envText}
                        onChange={(event) => {
                          setEnvText(event.target.value)
                          setEnvChoice('edit')
                        }}
                        rows={3}
                        placeholder={'每行一个 KEY=VALUE；全部删空保存即清除全部环境变量'}
                        className={`${CTL_FIELD} mt-1 w-full font-mono text-xs`}
                      />
                      {server !== undefined && server.stdio?.hasEnvironment ? (
                        <button type="button" className={`${CTL_SECONDARY} mt-2 px-2`} onClick={() => { setEnvText(''); setEnvChoice('edit') }}>
                          清除全部环境变量
                        </button>
                      ) : null}
                      <p className="mt-1.5 text-xs text-fg-subtle">所有值均按凭据处理：只提交不回显、不进入日志。</p>
                    </>
                  )}
                </fieldset>
              </>
            )}
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} className="size-4" />
              启用（停用的服务不能开始新的探测或运行）
            </label>
            {errorMessage ? <p role="alert" className="text-xs text-danger">{errorMessage}</p> : null}
            {mcpSaveError !== null ? <p role="alert" className="text-xs text-danger">{mcpSaveError}</p> : null}
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={CTL_SECONDARY}>取消</button>
              <button type="submit" disabled={submitting || mcpSaving} className={CTL_PRIMARY}>
                {server === undefined ? '创建 MCP 服务' : '保存 MCP 服务'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function McpRevisionDialog({ target, onClose }: { target: { serverId: string; revision: number }; onClose(): void }) {
  const gateway = useGateway()
  const requestGeneration = useRef(0)
  const [server, setServer] = useState<AgentMCPServer | undefined>(undefined)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string>()
  const [revisionText, setRevisionText] = useState(String(target.revision))

  const read = async (revision: number) => {
    const generation = ++requestGeneration.current
    setStatus('loading')
    setErrorMessage(undefined)
    try {
      const item = await gateway.agentExtensions.getMcpServer(target.serverId, revision)
      if (generation !== requestGeneration.current) return
      setServer(item)
      setStatus('ready')
    } catch (error) {
      if (generation !== requestGeneration.current) return
      setErrorMessage(error instanceof Error ? error.message : '读取 MCP 服务修订失败')
      setStatus('error')
    }
  }

  useEffect(() => {
    void read(target.revision)
    return () => { requestGeneration.current += 1 }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.serverId, target.revision])

  const parsed = Number.parseInt(revisionText, 10)

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">MCP 服务修订详情（{target.serverId}）</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭修订详情" className="rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg">
                <X aria-hidden size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="agent-mcp-revision-input" className="block text-xs text-fg-muted">修订号（正整数，必填）</label>
              <input
                id="agent-mcp-revision-input"
                type="number"
                min={1}
                step={1}
                value={revisionText}
                onChange={(event) => setRevisionText(event.target.value)}
                className={`${CTL_FIELD} mt-1 h-9 w-28 tabular-nums`}
              />
            </div>
            <button
              type="button"
              className={CTL_SECONDARY}
              disabled={!Number.isSafeInteger(parsed) || parsed < 1}
              onClick={() => void read(parsed)}
            >
              读取该修订
            </button>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {status === 'loading' ? <LoadingState label="正在读取修订…" /> : null}
            {status === 'error' ? (
              <ErrorState title="修订读取失败" description={errorMessage} onRetry={() => void read(target.revision)} />
            ) : null}
            {status === 'ready' && server !== undefined ? <JsonView label="修订完整 JSON" text={JSON.stringify(server, null, 2)} /> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ProbeDialog() {
  const probe = useAgentExtensionsStore((state) => state.probe)
  const close = useAgentExtensionsStore((state) => state.closeProbe)
  if (probe === null) return null
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">MCP 探测（{probe.serverId}，修订 {probe.revision}）</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭探测结果" className="rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg">
                <X aria-hidden size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {probe.status === 'loading' ? <LoadingState label="正在现场探测（stdio 服务可能需要拉起执行容器）…" /> : null}
            {probe.status === 'error' ? (
              probe.resourceBusy ? (
                <div role="alert" className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-fg">
                  <p className="font-medium text-warning">{probe.errorMessage}</p>
                  <p>存在结果未知的租约，先到治理中心核实。</p>
                  <Link to="/agent/approvals?tab=locks" className="text-fg underline underline-offset-2" onClick={close}>
                    前往治理中心核实资源租约
                  </Link>
                </div>
              ) : (
                <ErrorState title="探测失败" description={probe.errorMessage} />
              )
            ) : null}
            {probe.status === 'ready' && probe.projection !== undefined ? <CatalogProjectionView projection={probe.projection} /> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function CatalogDialog() {
  const gateway = useGateway()
  const catalog = useAgentExtensionsStore((state) => state.catalog)
  const loadCatalog = useAgentExtensionsStore((state) => state.loadMcpCatalog)
  const close = useAgentExtensionsStore((state) => state.closeCatalog)
  const [digestText, setDigestText] = useState('')
  useEffect(() => {
    setDigestText(catalog?.digest ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog?.serverId, catalog?.revision])
  if (catalog === null) return null
  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(44rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">固定目录（{catalog.serverId}，修订 {catalog.revision}）</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭固定目录" className="rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg">
                <X aria-hidden size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="agent-mcp-catalog-digest" className="block text-xs text-fg-muted">目录摘要（可选；填写后按该摘要读取固定快照，不符时报服务端提示）</label>
              <input
                id="agent-mcp-catalog-digest"
                value={digestText}
                onChange={(event) => setDigestText(event.target.value)}
                placeholder="留空读取该修订最近一次已验证目录"
                className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`}
              />
            </div>
            <button
              type="button"
              className={CTL_PRIMARY}
              onClick={() => void loadCatalog(gateway, catalog.serverId, catalog.revision, digestText.trim() === '' ? undefined : digestText.trim())}
            >
              读取目录
            </button>
          </div>
          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {catalog.status === 'loading' ? <LoadingState label="正在读取固定目录…" /> : null}
            {catalog.status === 'error' ? (
              <ErrorState
                title="目录读取失败"
                description={catalog.errorMessage}
                onRetry={() => void loadCatalog(gateway, catalog.serverId, catalog.revision, catalog.digest)}
              />
            ) : null}
            {catalog.status === 'ready' && catalog.projection !== undefined ? <CatalogProjectionView projection={catalog.projection} /> : null}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** probe 与 catalog 共用的目录投影只读视图：能力位、三组条目与别名映射、digest/fetchedAt。 */
function CatalogProjectionView({ projection }: { projection: AgentMCPCatalogProjection }) {
  const aliasFor = (map: Readonly<Record<string, string>>, key: string): string | undefined => map[key]
  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <StatusTag label={`协议 ${projection.protocolVersion}`} tone="info" />
        {projection.capabilities.tools ? <StatusTag label="tools" tone="success" /> : null}
        {projection.capabilities.resources ? <StatusTag label="resources" tone="success" /> : null}
        {projection.capabilities.prompts ? <StatusTag label="prompts" tone="success" /> : null}
        {!projection.capabilities.tools && !projection.capabilities.resources && !projection.capabilities.prompts ? (
          <StatusTag label="未声明任何能力" tone="warning" />
        ) : null}
        <span className="tabular-nums">抓取于 {formatDateTime(projection.fetchedAt)}</span>
      </div>
      <div className="flex items-center gap-1 text-xs text-fg-muted">
        <span className="shrink-0">目录摘要</span>
        <span className="min-w-0 truncate font-mono" title={projection.digest}>{projection.digest}</span>
        <CopyButton label="目录摘要" value={projection.digest} tooltip="复制完整目录摘要" />
      </div>
      <section aria-label="工具目录">
        <h3 className="mb-1.5 text-xs font-medium text-fg-muted">工具（{projection.tools.length}）</h3>
        {projection.tools.length === 0 ? (
          <p className="text-xs text-fg-subtle">该服务没有工具。</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projection.tools.map((tool) => (
              <li key={tool.name} className="rounded-lg border border-line p-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-mono text-xs font-medium">{tool.name}{tool.title !== undefined ? <span className="font-sans text-fg-muted">（{tool.title}）</span> : null}</p>
                  {aliasFor(projection.modelAliases, tool.name) !== undefined ? (
                    <p className="font-mono text-xs text-fg-subtle">模型别名 {projection.modelAliases[tool.name]}</p>
                  ) : null}
                </div>
                {tool.description !== undefined ? <p className="mt-1 text-xs text-fg-muted">{tool.description}</p> : null}
                <div className="mt-1.5">
                  <JsonView label={`${tool.name} 输入 Schema`} text={JSON.stringify(tool.inputSchema)} collapseBytes={1200} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="资源目录">
        <h3 className="mb-1.5 text-xs font-medium text-fg-muted">资源（{projection.resources.length}）</h3>
        {projection.resources.length === 0 ? (
          <p className="text-xs text-fg-subtle">该服务没有资源。</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {projection.resources.map((resource) => (
              <li key={resource.uri} className="rounded-lg border border-line px-2.5 py-2 text-xs">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-mono">{resource.uri}{resource.name !== resource.uri ? <span className="font-sans text-fg-muted">（{resource.name}）</span> : null}</p>
                  {projection.resourceAliases[resource.uri] !== undefined ? (
                    <p className="font-mono text-fg-subtle">资源别名 {projection.resourceAliases[resource.uri]}</p>
                  ) : null}
                </div>
                {resource.description !== undefined ? <p className="mt-0.5 text-fg-muted">{resource.description}</p> : null}
                {resource.mimeType !== undefined ? <p className="text-fg-subtle">{resource.mimeType}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="提示目录">
        <h3 className="mb-1.5 text-xs font-medium text-fg-muted">提示（{projection.prompts.length}）</h3>
        {projection.prompts.length === 0 ? (
          <p className="text-xs text-fg-subtle">该服务没有提示。</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {projection.prompts.map((prompt) => (
              <li key={prompt.name} className="rounded-lg border border-line px-2.5 py-2 text-xs">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-mono">{prompt.name}{prompt.title !== undefined ? <span className="font-sans text-fg-muted">（{prompt.title}）</span> : null}</p>
                  {projection.promptAliases[prompt.name] !== undefined ? (
                    <p className="font-mono text-fg-subtle">提示别名 {projection.promptAliases[prompt.name]}</p>
                  ) : null}
                </div>
                {prompt.description !== undefined ? <p className="mt-0.5 text-fg-muted">{prompt.description}</p> : null}
                {prompt.arguments !== undefined && prompt.arguments.length > 0 ? (
                  <p className="mt-0.5 text-fg-subtle">
                    参数：{prompt.arguments.map((argument) => `${argument.name}${argument.required ? '（必填）' : ''}`).join('、')}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className="text-xs text-fg-subtle">
        服务器 annotations 与目录别名不自动授予权限：会话内的工具与只读信任由环境固定与本地策略决定，MCP 默认逐调用审批。
      </p>
    </div>
  )
}
