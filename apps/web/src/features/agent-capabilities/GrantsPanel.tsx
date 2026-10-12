import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentDirectoryGrant, AgentExecutionGrant, AgentNetworkEndpoint } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_FIELD } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { FolderInput, Globe, History, Pencil, Plus, Trash2, X } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { useAgentCapabilitiesStore } from '../../stores/agentCapabilitiesStore'
import { CapabilitiesEmptyState, CapabilitiesSearchInput } from './AgentCapabilitiesPage'
import { RevisionDetailDialog } from './RevisionDetailDialog'
import { RevisionConflictNotice } from '../../components/agent/RevisionConflictNotice'

/*
 * 目录与网络授权面板：directories[{path,access}]、network[{scheme,host,port}] 与
 * privateCidrs 三组授权的增改启停，修订详情经 GET /grants/{id}?revision=（含历史
 * 修订）。授权只收紧不放大：目录映射到 /grants/序号，出网走精确协议/域名/端口；
 * 回环、链路本地与元数据地址禁止授权（服务端裁决，前端只透传中文错误）。
 */

export function GrantsPanel() {
  const gateway = useGateway()
  const grants = useAgentCapabilitiesStore((state) => state.grants)
  const togglingIds = useAgentCapabilitiesStore((state) => state.togglingIds)
  const toggleEnabled = useAgentCapabilitiesStore((state) => state.toggleGrantEnabled)
  const search = useAgentCapabilitiesStore((state) => state.search)
  const setSearch = useAgentCapabilitiesStore((state) => state.setSearch)
  const loadRevisionDetail = useAgentCapabilitiesStore((state) => state.loadRevisionDetail)
  const [editing, setEditing] = useState<AgentExecutionGrant | 'new' | undefined>(undefined)
  const [detailId, setDetailId] = useState<string | undefined>(undefined)

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (keyword === '') return grants
    return grants.filter((item) =>
      item.name.toLowerCase().includes(keyword) ||
      item.directories.some((directory) => directory.path.toLowerCase().includes(keyword)) ||
      item.network.some((endpoint) => endpoint.host.toLowerCase().includes(keyword)))
  }, [grants, search])

  const detailTarget = detailId === undefined ? undefined : grants.find((item) => item.id === detailId)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setEditing('new')} className={CTL_PRIMARY}>
          <span className="inline-flex items-center gap-1.5">
            <Plus aria-hidden size={14} />
            新建授权
          </span>
        </button>
        <CapabilitiesSearchInput
          id="agent-grants-search"
          label="搜索名称、目录或域名"
          value={search}
          onChange={setSearch}
        />
      </div>
      {filtered.length === 0 ? (
        <CapabilitiesEmptyState
          title={search.trim() === '' ? '还没有目录与网络授权' : '没有匹配的授权'}
          description={search.trim() === ''
            ? '授权把业务子目录映射为只读/读写挂载，把出网收敛到精确协议、域名与端口；会话环境按固定修订选择。'
            : '换个关键词，或清空过滤查看全部授权。'}
        />
      ) : (
        <div role="region" aria-label="目录与网络授权列表" className="overflow-x-auto panel-surface">
          <table className="w-full min-w-[58rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[15%]" />
              <col className="w-[26%]" />
              <col className="w-[26%]" />
              <col className="w-[13%]" />
              <col className="w-[20%]" />
            </colgroup>
            <thead>
              <tr>
                {['名称', '目录授权', '网络授权', '私网网段', '状态/操作'].map((label) => (
                  <th key={label} scope="col" className="border-b border-line bg-surface px-3 py-2.5 text-xs font-medium text-fg-muted">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={`${item.id}@${item.revision}`} className="transition-colors hover:bg-surface-raised/50">
                  <td className="border-b border-line px-3 py-2.5">
                    <span className="block truncate font-medium" title={item.name}>{item.name}</span>
                    <p className="truncate text-xs text-fg-subtle tabular-nums" title={`${item.id} · 修订 ${item.revision}`}>{item.id} · 修订 {item.revision}</p>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs">
                    {item.directories.length === 0 ? <span className="text-fg-subtle">无</span> : item.directories.map((directory) => (
                      <span key={directory.path} className="block truncate" title={directory.path}>
                        {directory.access === 'ro' ? '只读' : '读写'} {directory.path}
                      </span>
                    ))}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs">
                    {item.network.length === 0 ? <span className="text-fg-subtle">无</span> : item.network.map((endpoint) => (
                      <span key={`${endpoint.scheme}://${endpoint.host}:${endpoint.port}`} className="block truncate" title={`${endpoint.scheme}://${endpoint.host}:${endpoint.port}`}>
                        {endpoint.scheme}://{endpoint.host}:{endpoint.port}
                      </span>
                    ))}
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs">
                    {item.privateCidrs.length === 0 ? <span className="text-fg-subtle">无</span> : item.privateCidrs.map((cidr) => (
                      <span key={cidr} className="block truncate" title={cidr}>{cidr}</span>
                    ))}
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    <div className="flex flex-col gap-1.5">
                      {item.enabled ? <StatusTag label="已启用" tone="success" /> : <StatusTag label="已停用" tone="neutral" />}
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(item)}
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
                        >
                          <Pencil aria-hidden size={13} />
                          编辑
                        </button>
                        <button
                          type="button"
                          disabled={togglingIds.includes(item.id)}
                          onClick={() => void toggleEnabled(gateway, item, !item.enabled)}
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {item.enabled ? '停用' : '启用'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDetailId(item.id)
                            void loadRevisionDetail(gateway, 'grant', item.id)
                          }}
                          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
                        >
                          <History aria-hidden size={13} />
                          修订
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing !== undefined ? <GrantDialog grant={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} /> : null}
      {detailTarget !== undefined ? <RevisionDetailDialog latestRevision={detailTarget.revision} /> : null}
    </div>
  )
}

type DirectoryRow = { path: string; access: AgentDirectoryGrant['access'] }
type EndpointRow = { scheme: AgentNetworkEndpoint['scheme']; host: string; port: string }

function GrantDialog({ grant, onClose }: { grant?: AgentExecutionGrant; onClose(): void }) {
  const gateway = useGateway()
  const saveGrant = useAgentCapabilitiesStore((state) => state.saveGrant)
  const latest = useAgentCapabilitiesStore((state) => state.grants.find((item) => item.id === grant?.id))
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [baseRevision, setBaseRevision] = useState(grant?.revision ?? 0)
  const [name, setName] = useState(grant?.name ?? '')
  const [directories, setDirectories] = useState<DirectoryRow[]>(
    grant ? grant.directories.map((directory) => ({ ...directory })) : [],
  )
  const [endpoints, setEndpoints] = useState<EndpointRow[]>(
    grant ? grant.network.map((endpoint) => ({ ...endpoint, port: String(endpoint.port) })) : [],
  )
  const [cidrText, setCidrText] = useState(grant ? grant.privateCidrs.join('\n') : '')
  const [enabled, setEnabled] = useState(grant?.enabled ?? true)
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    if (grant === undefined) return
    setName(grant.name)
    setBaseRevision(grant.revision)
    setDirectories(grant.directories.map((directory) => ({ ...directory })))
    setEndpoints(grant.network.map((endpoint) => ({ ...endpoint, port: String(endpoint.port) })))
    setCidrText(grant.privateCidrs.join('\n'))
    setEnabled(grant.enabled)
    setErrorMessage(undefined)
  }, [grant])

  const submit = async () => {
    const network = endpoints.map((endpoint) => ({ ...endpoint, port: Number.parseInt(endpoint.port, 10) }))
    if (network.some((endpoint) => !Number.isSafeInteger(endpoint.port))) {
      setErrorMessage('网络授权端口必须是整数')
      return
    }
    const ok = await inFlightOnly(() => saveGrant(gateway, {
      enabled, name,
      directories: directories.map((directory) => ({ path: directory.path, access: directory.access })),
      network,
      privateCidrs: cidrText.split('\n').map((line) => line.trim()).filter((line) => line !== ''),
      expectedRevision: baseRevision,
    }, grant === undefined ? undefined : { id: grant.id, revision: baseRevision }))
    if (ok) onClose()
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-overlay" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 z-[61] flex max-h-[85vh] w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col panel-surface p-4 shadow-xl"
        >
          <div className="flex items-start justify-between gap-2">
            <Dialog.Title className="text-sm font-semibold">
              {grant === undefined ? '新建目录与网络授权' : `编辑「${grant.name}」（修订 ${grant.revision}）`}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭授权表单" className="rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg">
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
              <label htmlFor="agent-grant-name" className="block text-xs text-fg-muted">名称</label>
              <input id="agent-grant-name" value={name} onChange={(event) => setName(event.target.value)} required className={`${CTL_FIELD} mt-1 h-9 w-full`} />
            </div>
            <fieldset className="rounded-lg border border-line p-2.5">
              <legend className="px-1 text-xs text-fg-muted">目录授权（业务挂载根下的真实子目录）</legend>
              {directories.length === 0 ? <p className="text-xs text-fg-subtle">未授权任何目录：执行容器只能访问任务工作区。</p> : null}
              <div className="flex flex-col gap-2">
                {directories.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`agent-grant-directory-${index}`}>目录路径 {index + 1}</label>
                    <input
                      id={`agent-grant-directory-${index}`}
                      value={row.path}
                      onChange={(event) => setDirectories((rows) => rows.map((item, at) => at === index ? { ...item, path: event.target.value } : item))}
                      placeholder="/srv/projects/demo"
                      className={`${CTL_FIELD} h-9 flex-1 font-mono text-xs`}
                    />
                    <label className="sr-only" htmlFor={`agent-grant-directory-access-${index}`}>访问方式 {index + 1}</label>
                    <SelectDropdown
                      id={`agent-grant-directory-access-${index}`}
                      ariaLabel={`访问方式 ${index + 1}`}
                      value={row.access}
                      onSelect={(access) => setDirectories((rows) => rows.map((item, at) => at === index ? { ...item, access } : item))}
                      items={[{ value: 'ro', label: '只读' }, { value: 'rw', label: '读写' }]}
                      className="w-24"
                    />
                    <button
                      type="button"
                      aria-label={`删除目录 ${row.path || index + 1}`}
                      onClick={() => setDirectories((rows) => rows.filter((_, at) => at !== index))}
                      className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-danger"
                    >
                      <Trash2 aria-hidden size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setDirectories((rows) => [...rows, { path: '', access: 'ro' }])}
                className={`${CTL_SECONDARY} mt-2 px-2`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <FolderInput aria-hidden size={13} />
                  添加目录
                </span>
              </button>
            </fieldset>
            <fieldset className="rounded-lg border border-line p-2.5">
              <legend className="px-1 text-xs text-fg-muted">网络授权（精确协议、域名与端口；回环与元数据地址禁止授权）</legend>
              {endpoints.length === 0 ? <p className="text-xs text-fg-subtle">未授权任何出网目标：脚本网络请求将被拒绝。</p> : null}
              <div className="flex flex-col gap-2">
                {endpoints.map((row, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <label className="sr-only" htmlFor={`agent-grant-endpoint-scheme-${index}`}>协议 {index + 1}</label>
                    <SelectDropdown
                      id={`agent-grant-endpoint-scheme-${index}`}
                      ariaLabel={`协议 ${index + 1}`}
                      value={row.scheme}
                      onSelect={(scheme) => setEndpoints((rows) => rows.map((item, at) => at === index ? { ...item, scheme } : item))}
                      items={[{ value: 'https', label: 'https' }, { value: 'http', label: 'http' }]}
                      className="w-24"
                    />
                    <label className="sr-only" htmlFor={`agent-grant-endpoint-host-${index}`}>域名 {index + 1}</label>
                    <input
                      id={`agent-grant-endpoint-host-${index}`}
                      value={row.host}
                      onChange={(event) => setEndpoints((rows) => rows.map((item, at) => at === index ? { ...item, host: event.target.value } : item))}
                      placeholder="registry.example.com"
                      className={`${CTL_FIELD} h-9 flex-1 font-mono text-xs`}
                    />
                    <label className="sr-only" htmlFor={`agent-grant-endpoint-port-${index}`}>端口 {index + 1}</label>
                    <input
                      id={`agent-grant-endpoint-port-${index}`}
                      type="number"
                      min={1}
                      max={65535}
                      value={row.port}
                      onChange={(event) => setEndpoints((rows) => rows.map((item, at) => at === index ? { ...item, port: event.target.value } : item))}
                      className={`${CTL_FIELD} h-9 w-20 tabular-nums`}
                    />
                    <button
                      type="button"
                      aria-label={`删除网络授权 ${row.host || index + 1}`}
                      onClick={() => setEndpoints((rows) => rows.filter((_, at) => at !== index))}
                      className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-surface-raised hover:text-danger"
                    >
                      <Trash2 aria-hidden size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setEndpoints((rows) => [...rows, { scheme: 'https', host: '', port: '443' }])}
                className={`${CTL_SECONDARY} mt-2 px-2`}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Globe aria-hidden size={13} />
                  添加网络端点
                </span>
              </button>
            </fieldset>
            <div>
              <label htmlFor="agent-grant-cidrs" className="block text-xs text-fg-muted">私网网段（每行一个 CIDR，需网络授权配合）</label>
              <textarea id="agent-grant-cidrs" value={cidrText} onChange={(event) => setCidrText(event.target.value)} rows={2} placeholder={'10.0.0.0/8'} className={`${CTL_FIELD} mt-1 w-full font-mono text-xs`} />
            </div>
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4" />
              启用（停用后新操作不能选择该授权）
            </label>
            {errorMessage ? <p role="alert" className="text-xs text-danger">{errorMessage}</p> : null}
            {grant !== undefined ? <RevisionConflictNotice latest={latest} baseRevision={baseRevision} onAccept={setBaseRevision} /> : null}
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={CTL_SECONDARY}>取消</button>
              <button type="submit" disabled={submitting} className={CTL_PRIMARY}>
                {grant === undefined ? '创建授权' : '保存授权'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
