import { useEffect, useMemo, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { AgentExecutionProfile } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { useInFlightSubmit } from '../../components/agent/useInFlightSubmit'
import { CTL_PRIMARY, CTL_SECONDARY, CTL_FIELD } from '../../components/formControl'
import { SelectDropdown } from '../../components/SelectDropdown'
import { History, Pencil, Plus, X } from '../../components/icons'
import { StatusTag } from '../../components/StatusTag'
import { EXECUTION_LIMITS, useAgentCapabilitiesStore } from '../../stores/agentCapabilitiesStore'
import { CapabilitiesEmptyState, CapabilitiesSearchInput } from './AgentCapabilitiesPage'
import { RevisionDetailDialog } from './RevisionDetailDialog'
import { RevisionConflictNotice } from '../../components/agent/RevisionConflictNotice'

/*
 * 执行配置面板：Profile 列表＋新建/编辑＋启停（PUT /{id}/enabled 回读）＋修订详情
 * （GET /execution-profiles/{id}?revision=，含历史修订）。表单按前端上限校验并显示
 * 上限中文说明：时限 300 秒、CPU 1000 毫秒、内存 512 MiB、进程 128；内存以 MiB
 * 输入、提交换算字节。撤销入口不在本页（归审批与治理）。
 */

function formatBytes(value: number): string {
  return value >= 1024 * 1024 ? `${Math.round(value / (1024 * 1024))} MiB` : `${Math.round(value / 1024)} KiB`
}

function parseCommandArgs(text: string): string[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value) || value.length < 1 || value.length > 64 || !value.every((part) => typeof part === 'string')) {
    throw new Error('容器命令必须是含 1 至 64 个字符串的 JSON 数组')
  }
  return value
}

export function ExecutionProfilesPanel() {
  const gateway = useGateway()
  const profiles = useAgentCapabilitiesStore((state) => state.executionProfiles)
  const togglingIds = useAgentCapabilitiesStore((state) => state.togglingIds)
  const toggleEnabled = useAgentCapabilitiesStore((state) => state.toggleExecutionProfileEnabled)
  const search = useAgentCapabilitiesStore((state) => state.search)
  const setSearch = useAgentCapabilitiesStore((state) => state.setSearch)
  const loadRevisionDetail = useAgentCapabilitiesStore((state) => state.loadRevisionDetail)
  const [editing, setEditing] = useState<AgentExecutionProfile | 'new' | undefined>(undefined)
  const [detailId, setDetailId] = useState<string | undefined>(undefined)

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    if (keyword === '') return profiles
    return profiles.filter((item) =>
      item.name.toLowerCase().includes(keyword) ||
      item.image.toLowerCase().includes(keyword) ||
      item.runtime.toLowerCase().includes(keyword))
  }, [profiles, search])

  const detailTarget = detailId === undefined ? undefined : profiles.find((item) => item.id === detailId)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setEditing('new')} className={CTL_PRIMARY}>
          <span className="inline-flex items-center gap-1.5">
            <Plus aria-hidden size={14} />
            新建执行配置
          </span>
        </button>
        <CapabilitiesSearchInput
          id="agent-execution-search"
          label="搜索名称、镜像或运行时"
          value={search}
          onChange={setSearch}
        />
      </div>
      {filtered.length === 0 ? (
        <CapabilitiesEmptyState
          title={search.trim() === '' ? '还没有执行配置' : '没有匹配的执行配置'}
          description={search.trim() === ''
            ? '执行配置固定专属执行容器的镜像、运行时与限额；会话环境从中选择后才能派发脚本执行。'
            : '换个关键词，或清空过滤查看全部执行配置。'}
        />
      ) : (
        <div role="region" aria-label="执行配置列表" className="overflow-x-auto panel-surface">
          <table className="w-full min-w-[58rem] table-fixed border-separate border-spacing-0 text-left text-sm">
            <colgroup>
              <col className="w-[15%]" />
              <col className="w-[9%]" />
              <col className="w-[26%]" />
              <col className="w-[22%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
            </colgroup>
            <thead>
              <tr>
                {['名称', '运行时', '镜像（SHA-256 摘要固定）', '限额', '修订', '状态', '操作'].map((label) => (
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
                    <p className="truncate text-xs text-fg-subtle tabular-nums" title={item.id}>{item.id}</p>
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
                    <StatusTag label={item.runtime === 'python' ? 'Python' : item.runtime === 'node' ? 'Node' : 'Bash'} tone="info" />
                  </td>
                  <td className="border-b border-line px-3 py-2.5 font-mono text-xs" title={item.image}>
                    <span className="block truncate">{item.image}</span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 text-xs tabular-nums text-fg-muted">
                    <span className="block">{item.timeoutSeconds}s · {item.cpuMillis}m CPU</span>
                    <span className="block">{formatBytes(item.memoryBytes)} · {item.pids} PID</span>
                  </td>
                  <td className="border-b border-line px-3 py-2.5 tabular-nums text-fg-muted">{item.revision}</td>
                  <td className="border-b border-line px-3 py-2.5">
                    {item.enabled ? <StatusTag label="已启用" tone="success" /> : <StatusTag label="已停用" tone="neutral" />}
                  </td>
                  <td className="border-b border-line px-3 py-2.5">
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
                          void loadRevisionDetail(gateway, 'execution', item.id)
                        }}
                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg"
                      >
                        <History aria-hidden size={13} />
                        修订
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing !== undefined ? <ExecutionProfileDialog profile={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} /> : null}
      {detailTarget !== undefined ? <RevisionDetailDialog latestRevision={detailTarget.revision} /> : null}
    </div>
  )
}

function ExecutionProfileDialog({ profile, onClose }: { profile?: AgentExecutionProfile; onClose(): void }) {
  const gateway = useGateway()
  const saveExecutionProfile = useAgentCapabilitiesStore((state) => state.saveExecutionProfile)
  const latest = useAgentCapabilitiesStore((state) => state.executionProfiles.find((item) => item.id === profile?.id))
  const { submitting, inFlightOnly } = useInFlightSubmit()
  const [baseRevision, setBaseRevision] = useState(profile?.revision ?? 0)
  const [name, setName] = useState(profile?.name ?? '')
  const [image, setImage] = useState(profile?.image ?? '')
  const [runtime, setRuntime] = useState<AgentExecutionProfile['runtime']>(profile?.runtime ?? 'python')
  const [commandText, setCommandText] = useState(JSON.stringify(profile?.command ?? ['python3', '-'], null, 2))
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(profile?.timeoutSeconds ?? 60))
  const [cpuMillis, setCpuMillis] = useState(String(profile?.cpuMillis ?? 500))
  const [memoryMiB, setMemoryMiB] = useState(String(Math.round((profile?.memoryBytes ?? 256 * 1024 * 1024) / (1024 * 1024))))
  const [pids, setPids] = useState(String(profile?.pids ?? 64))
  const [enabled, setEnabled] = useState(profile?.enabled ?? true)
  const [errorMessage, setErrorMessage] = useState<string>()

  useEffect(() => {
    if (profile === undefined) return
    setName(profile.name)
    setBaseRevision(profile.revision)
    setImage(profile.image)
    setRuntime(profile.runtime)
    setCommandText(JSON.stringify(profile.command, null, 2))
    setTimeoutSeconds(String(profile.timeoutSeconds))
    setCpuMillis(String(profile.cpuMillis))
    setMemoryMiB(String(Math.round(profile.memoryBytes / (1024 * 1024))))
    setPids(String(profile.pids))
    setEnabled(profile.enabled)
    setErrorMessage(undefined)
  }, [profile])

  const submit = async () => {
    let command: string[]
    try {
      command = parseCommandArgs(commandText)
    } catch (error) {
      setErrorMessage(error instanceof SyntaxError ? '容器命令必须是有效的 JSON 字符串数组' : error instanceof Error ? error.message : '容器命令格式无效')
      return
    }
    const timeout = Number.parseInt(timeoutSeconds, 10)
    const cpu = Number.parseInt(cpuMillis, 10)
    const memory = Number.parseInt(memoryMiB, 10)
    const pidLimit = Number.parseInt(pids, 10)
    if (![timeout, cpu, memory, pidLimit].every((value) => Number.isSafeInteger(value))) {
      setErrorMessage('限额各项必须是整数')
      return
    }
    const ok = await inFlightOnly(() => saveExecutionProfile(gateway, {
      enabled, name, image, runtime, command,
      timeoutSeconds: timeout,
      cpuMillis: cpu,
      memoryBytes: memory * 1024 * 1024,
      pids: pidLimit,
      expectedRevision: baseRevision,
    }, profile === undefined ? undefined : { id: profile.id, revision: baseRevision }))
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
              {profile === undefined ? '新建执行配置' : `编辑「${profile.name}」（修订 ${profile.revision}）`}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="关闭执行配置表单" className="rounded-md p-1 text-fg-muted transition-colors hover:bg-surface-raised hover:text-fg">
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
            <p className="rounded-lg border border-line bg-surface px-2.5 py-2 text-xs text-fg-muted">
              限额只能收紧：上限为 5 分钟（{EXECUTION_LIMITS.timeoutSeconds} 秒）、1 CPU（{EXECUTION_LIMITS.cpuMillis} 毫秒）、512 MiB 内存与 {EXECUTION_LIMITS.pids} PID；脚本仍受运行时限约束。
            </p>
            <div>
              <label htmlFor="agent-execution-name" className="block text-xs text-fg-muted">名称</label>
              <input id="agent-execution-name" value={name} onChange={(event) => setName(event.target.value)} required className={`${CTL_FIELD} mt-1 h-9 w-full`} />
            </div>
            <div>
              <label htmlFor="agent-execution-image" className="block text-xs text-fg-muted">镜像（仓库名＋完整 SHA-256 摘要）</label>
              <input id="agent-execution-image" value={image} onChange={(event) => setImage(event.target.value)} required placeholder="registry.example.com/name@sha256:…" className={`${CTL_FIELD} mt-1 h-9 w-full font-mono text-xs`} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="agent-execution-runtime" className="block text-xs text-fg-muted">运行时</label>
                <SelectDropdown
                  id="agent-execution-runtime"
                  ariaLabel="运行时"
                  value={runtime}
                  onSelect={setRuntime}
                  items={[{ value: 'python', label: 'Python' }, { value: 'node', label: 'Node' }, { value: 'bash', label: 'Bash' }]}
                  fullWidth className="mt-1"
                />
              </div>
              <div>
                <label htmlFor="agent-execution-timeout" className="block text-xs text-fg-muted">执行时限（秒，上限 {EXECUTION_LIMITS.timeoutSeconds}）</label>
                <input id="agent-execution-timeout" type="number" min={1} max={EXECUTION_LIMITS.timeoutSeconds} step={1} value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} required className={`${CTL_FIELD} mt-1 h-9 w-full tabular-nums`} />
              </div>
            </div>
            <div>
              <label htmlFor="agent-execution-command" className="block text-xs text-fg-muted">容器命令（JSON 字符串数组，1 至 64 个参数）</label>
              <textarea id="agent-execution-command" value={commandText} onChange={(event) => setCommandText(event.target.value)} rows={3} required className={`${CTL_FIELD} mt-1 w-full font-mono text-xs`} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label htmlFor="agent-execution-cpu" className="block text-xs text-fg-muted">CPU（毫秒，上限 {EXECUTION_LIMITS.cpuMillis}）</label>
                <input id="agent-execution-cpu" type="number" min={1} max={EXECUTION_LIMITS.cpuMillis} step={1} value={cpuMillis} onChange={(event) => setCpuMillis(event.target.value)} required className={`${CTL_FIELD} mt-1 h-9 w-full tabular-nums`} />
              </div>
              <div>
                <label htmlFor="agent-execution-memory" className="block text-xs text-fg-muted">内存（MiB，上限 512）</label>
                <input id="agent-execution-memory" type="number" min={1} max={512} step={1} value={memoryMiB} onChange={(event) => setMemoryMiB(event.target.value)} required className={`${CTL_FIELD} mt-1 h-9 w-full tabular-nums`} />
              </div>
              <div>
                <label htmlFor="agent-execution-pids" className="block text-xs text-fg-muted">进程数（上限 {EXECUTION_LIMITS.pids}）</label>
                <input id="agent-execution-pids" type="number" min={1} max={EXECUTION_LIMITS.pids} step={1} value={pids} onChange={(event) => setPids(event.target.value)} required className={`${CTL_FIELD} mt-1 h-9 w-full tabular-nums`} />
              </div>
            </div>
            <label className="inline-flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4" />
              启用（停用后不能用于新的操作）
            </label>
            {errorMessage ? <p role="alert" className="text-xs text-danger">{errorMessage}</p> : null}
            {profile !== undefined ? <RevisionConflictNotice latest={latest} baseRevision={baseRevision} onAccept={setBaseRevision} /> : null}
            <div className="mt-1 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={CTL_SECONDARY}>取消</button>
              <button type="submit" disabled={submitting} className={CTL_PRIMARY}>
                {profile === undefined ? '创建执行配置' : '保存执行配置'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
