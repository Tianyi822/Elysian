import type {
  AgentExecutionGrant,
  AgentExecutionGrantInput,
  AgentExecutionProfile,
  AgentExecutionProfileInput,
  AgentExecutionRuntime,
  AgentResourceRule,
  AgentResourceRuleInput,
} from '@elysian/contracts'
import { create } from 'zustand'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import type { ElysianGateway } from '../contracts/adapters'
import { useNotificationStore } from './notificationStore'

/*
 * Ely 执行配置域 store：四域列表（服务端全量、无分页）＋写操作单飞锁＋
 * expectedRevision 冲突的回读合并。写端点全部无 requestId——连点由 saving 单飞
 * 锁只发一次；CAS 冲突不盲目重试，重拉列表让服务端事实回到屏上，表单留在原处
 * 由用户基于最新修订重新提交。凭据只在提交路径上经过内存，不进日志与持久化。
 */

export type AgentCapabilitiesTab = 'execution' | 'grants' | 'rules' | 'runtimes'
type DomainStatus = { status: 'loading' | 'ready' | 'error'; errorMessage?: string }
type DomainStates = Record<AgentCapabilitiesTab, DomainStatus>

const initialDomainStates = (): DomainStates => ({
execution: { status: 'loading' }, grants: { status: 'loading' },
  rules: { status: 'loading' }, runtimes: { status: 'loading' },
})

export const AGENT_CAPABILITIES_TABS: readonly { value: AgentCapabilitiesTab; label: string }[] = [
  { value: 'execution', label: '执行配置' },
  { value: 'grants', label: '目录与网络授权' },
  { value: 'rules', label: '资源规则' },
  { value: 'runtimes', label: '执行器运行时' },
]

/** Docker 真实模式下写入真实配置文件；宿主机本地开发（内存演示）保留标注。 */
const DEMO_SUFFIX = isDockerRuntime() ? '' : '（演示数据）'

/** 服务端 CAS 冲突 code：模型/资源规则与执行域两族（AgentHttpError 与 mock 错误都带 code）。 */
export function isRevisionConflict(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) return false
  const code = (error as { code?: unknown }).code
  return code === 'revision-conflict' || code === 'execution_revision_conflict'
}

/** 执行配置前端校验上限（与服务端 execconfig 上限同口径：300s / 1000 millis / 512 MiB / 128 PID）。 */
export const EXECUTION_LIMITS = {
  timeoutSeconds: 300,
  cpuMillis: 1000,
  memoryBytes: 512 * 1024 * 1024,
  pids: 128,
} as const

export function validateExecutionProfileInput(input: AgentExecutionProfileInput): string | undefined {
  if (!input.name.trim()) return '执行配置名称不能为空'
  if (!input.image.trim()) return '镜像必须固定为仓库名与完整 SHA-256 摘要'
  if (input.command.length < 1 || input.command.length > 64 || input.command[0] === '') return '容器命令必须包含 1 至 64 个参数，首个参数不能为空'
  if (input.command.some((part) => typeof part !== 'string' || part.includes('\0') || new TextEncoder().encode(part).length > 4096)) {
    return '容器命令参数不能包含 NUL，且每个参数不能超过 4096 字节'
  }
  if (new TextEncoder().encode(input.command.join('')).length > 16 * 1024) return '容器命令参数总长度不能超过 16 KiB'
  if (!Number.isSafeInteger(input.timeoutSeconds) || input.timeoutSeconds < 1 || input.timeoutSeconds > EXECUTION_LIMITS.timeoutSeconds) {
    return `执行时限必须是 1 到 ${EXECUTION_LIMITS.timeoutSeconds} 秒的整数（上限 5 分钟）`
  }
  if (!Number.isSafeInteger(input.cpuMillis) || input.cpuMillis < 1 || input.cpuMillis > EXECUTION_LIMITS.cpuMillis) {
    return `CPU 配额必须是 1 到 ${EXECUTION_LIMITS.cpuMillis} 毫秒的整数（上限 1 CPU）`
  }
  if (!Number.isSafeInteger(input.memoryBytes) || input.memoryBytes < 1 || input.memoryBytes > EXECUTION_LIMITS.memoryBytes) {
    return `内存配额不能超过 512 MiB`
  }
  if (!Number.isSafeInteger(input.pids) || input.pids < 1 || input.pids > EXECUTION_LIMITS.pids) {
    return `进程数上限必须是 1 到 ${EXECUTION_LIMITS.pids} 的整数（上限 ${EXECUTION_LIMITS.pids} PID）`
  }
  return undefined
}

export function validateGrantInput(input: AgentExecutionGrantInput): string | undefined {
  if (!input.name.trim()) return '授权名称不能为空'
  for (const directory of input.directories) {
    if (!directory.path.trim()) return '授权目录路径不能为空'
  }
  for (const endpoint of input.network) {
    if (!endpoint.host.trim()) return '网络授权域名不能为空'
    if (!Number.isSafeInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535) {
      return '网络授权端口必须是 1 到 65535 的整数'
    }
  }
  for (const cidr of input.privateCidrs) {
    if (!cidr.trim()) return '私网网段不能为空'
  }
  return undefined
}

export function validateResourceRuleInput(input: AgentResourceRuleInput): string | undefined {
  if (!input.name.trim()) return '规则名称不能为空'
  if (!input.selector.ref.id.trim()) return '选择器引用编号不能为空'
  if (!Number.isSafeInteger(input.selector.ref.revision) || input.selector.ref.revision < 1) {
    return '选择器引用修订必须是正整数'
  }
  if (input.selector.source !== 'script' && !input.selector.originalName?.trim()) {
    return 'MCP 来源必须填写原始能力名'
  }
  if (input.selector.source !== 'script' && !input.selector.catalogDigest?.trim()) {
    return 'MCP 来源必须填写目录摘要'
  }
  if (input.mappings.length < 1 || input.mappings.length > 32) {
    return '资源映射必须是 1 到 32 条'
  }
  for (const mapping of input.mappings) {
    if (!mapping.kind.trim()) return '资源映射类型不能为空'
    if (!mapping.authority.trim()) return '资源映射来源不能为空'
    const hasLiteral = mapping.literal !== undefined && mapping.literal !== ''
    const hasPointer = mapping.pointer !== undefined && mapping.pointer !== ''
    if (hasLiteral === hasPointer) return '资源映射的固定值（literal）与 JSON Pointer（pointer）必须二选一'
    if (hasPointer && !mapping.pointer.startsWith('/')) return 'JSON Pointer 必须以 / 开头'
  }
  return undefined
}

export type AgentRevisionDetailKind = 'execution' | 'grant' | 'rule'

export type AgentRevisionDetail = {
  kind: AgentRevisionDetailKind
  id: string
  /** 当前查看的修订；省略＝最新。 */
  revision?: number
  status: 'loading' | 'ready' | 'error'
  errorMessage?: string
  execution?: AgentExecutionProfile
  grant?: AgentExecutionGrant
  rule?: AgentResourceRule
}

type AgentCapabilitiesState = {
  tab: AgentCapabilitiesTab
  status: 'idle' | 'loading' | 'ready' | 'error'
  errorMessage?: string
  domainStates: DomainStates
  /** 就绪后的再读取：旧内容留在屏上，页面只盖 BusyVeil。 */
  reloading: boolean
  executionProfiles: readonly AgentExecutionProfile[]
  grants: readonly AgentExecutionGrant[]
  resourceRules: readonly AgentResourceRule[]
  executionRuntimes: readonly AgentExecutionRuntime[]
  /** 名称过滤（各页签独立）。 */
  search: string
  /** 全部写操作共用的单飞锁：进行中忽略后续提交，防止连点重复派发。 */
  saving: boolean
  togglingIds: readonly string[]
  detail: AgentRevisionDetail | undefined
  load(gateway: ElysianGateway): Promise<void>
  refresh(gateway: ElysianGateway): Promise<void>
  refreshExecutionRuntimes(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  setTab(tab: AgentCapabilitiesTab): void
  setSearch(search: string): void
  saveExecutionProfile(gateway: ElysianGateway, input: AgentExecutionProfileInput, editing?: { id: string; revision: number }): Promise<boolean>
  toggleExecutionProfileEnabled(gateway: ElysianGateway, profile: AgentExecutionProfile, enabled: boolean): Promise<void>
  saveGrant(gateway: ElysianGateway, input: AgentExecutionGrantInput, editing?: { id: string; revision: number }): Promise<boolean>
  toggleGrantEnabled(gateway: ElysianGateway, grant: AgentExecutionGrant, enabled: boolean): Promise<void>
  saveResourceRule(gateway: ElysianGateway, input: AgentResourceRuleInput, editing?: { id: string; revision: number }): Promise<boolean>
  loadRevisionDetail(gateway: ElysianGateway, kind: AgentRevisionDetailKind, id: string, revision?: number): Promise<void>
  closeRevisionDetail(): void
  reset(): void
}

function notify(message: string, tone: 'success' | 'danger' = 'success'): void {
  useNotificationStore.getState().notify({ tone, message })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败'
}

async function readAll(gateway: ElysianGateway) {
  const [executionProfiles, grants, resourceRules, executionRuntimes] = await Promise.allSettled([
    gateway.agentCapabilities.listExecutionProfiles(),
    gateway.agentCapabilities.listGrants(),
    gateway.agentCapabilities.listResourceRules(),
    gateway.agentCapabilities.listExecutionRuntimes(),
  ])
  return { executionProfiles, grants, resourceRules, executionRuntimes }
}

const domains = [
  ['execution', 'executionProfiles'], ['grants', 'grants'],
  ['rules', 'resourceRules'], ['runtimes', 'executionRuntimes'],
] as const

function applyReadResults(results: Awaited<ReturnType<typeof readAll>>, previous: AgentCapabilitiesState) {
  const update: Partial<AgentCapabilitiesState> = {}
  const domainStates = { ...previous.domainStates }
  for (const [domain, key] of domains) {
    const result = results[key]
    if (result.status === 'fulfilled') {
      // Lists are independent; preserve already loaded siblings when one endpoint fails.
      Object.assign(update, { [key]: result.value })
      domainStates[domain] = { status: 'ready' }
    } else {
      domainStates[domain] = { status: 'error', errorMessage: messageOf(result.reason) }
    }
  }
  return { ...update, domainStates }
}

let revisionDetailRequest = 0

export const useAgentCapabilitiesStore = create<AgentCapabilitiesState>((set, get) => ({
  tab: 'execution',
  status: 'idle',
  domainStates: initialDomainStates(),
  reloading: false,
  executionProfiles: [],
  grants: [],
  resourceRules: [],
  executionRuntimes: [],
  search: '',
  saving: false,
  togglingIds: [],
  detail: undefined,

  async load(gateway) {
    if (get().status === 'loading') return
    set({ status: 'loading', errorMessage: undefined })
    const results = await readAll(gateway)
    set({ ...applyReadResults(results, get()), status: 'ready', errorMessage: undefined })
  },

  async refresh(gateway) {
    // 静默重拉：不动 status，面板不闪加载态；失败以通知提示，旧内容保留。
    set({ reloading: true })
    const results = await readAll(gateway)
    set({ ...applyReadResults(results, get()), reloading: false })
    const errors = Object.values(get().domainStates).filter((item) => item.status === 'error')
    if (errors.length > 0) notify(`部分配置列表同步失败：${errors[0]?.errorMessage}`, 'danger')
  },

  async refreshExecutionRuntimes(gateway, signal) {
    try {
      const executionRuntimes = await gateway.agentCapabilities.listExecutionRuntimes(signal)
      if (signal?.aborted) return
      set({ executionRuntimes, domainStates: { ...get().domainStates, runtimes: { status: 'ready' } } })
    } catch (error) {
      if (signal?.aborted) return
      throw error
    }
  },

  setTab(tab) {
    // 过滤词随页签切换清空：四域的名称互不通用。
    set({ tab, search: '' })
  },

  setSearch(search) {
    set({ search })
  },

  async saveExecutionProfile(gateway, input, editing) {
    const invalid = validateExecutionProfileInput(input)
    if (invalid !== undefined) {
      notify(invalid, 'danger')
      return false
    }
    if (editing !== undefined && input.id !== undefined && input.id !== '' && input.id !== editing.id) {
      notify('执行配置编号与路径不一致，请重新打开编辑', 'danger')
      return false
    }
    if (get().saving) return false
    set({ saving: true })
    try {
      if (editing === undefined) {
        const created = await gateway.agentCapabilities.createExecutionProfile({ ...input, id: undefined })
        notify(`执行配置「${created.name}」已创建（修订 ${created.revision}）${DEMO_SUFFIX}`)
      } else {
        const updated = await gateway.agentCapabilities.updateExecutionProfile(editing.id, { ...input, id: editing.id, expectedRevision: editing.revision })
        notify(`执行配置「${updated.name}」已更新到修订 ${updated.revision}${DEMO_SUFFIX}`)
      }
      await get().refresh(gateway)
      return true
    } catch (error) {
      if (isRevisionConflict(error)) {
        await get().refresh(gateway)
        notify('执行配置已被其他修改更新，已重新读取最新修订，请基于最新内容重试', 'danger')
      } else {
        notify(messageOf(error), 'danger')
      }
      return false
    } finally {
      set({ saving: false })
    }
  },

  async toggleExecutionProfileEnabled(gateway, profile, enabled) {
    if (get().togglingIds.includes(profile.id)) return
    set((current) => ({ togglingIds: [...current.togglingIds, profile.id] }))
    try {
      const updated = await gateway.agentCapabilities.setExecutionProfileEnabled(profile.id, profile.revision, enabled)
      notify(`执行配置「${updated.name}」已${updated.enabled ? '启用' : '停用'}（修订 ${updated.revision}）${DEMO_SUFFIX}`)
      await get().refresh(gateway)
    } catch (error) {
      if (isRevisionConflict(error)) {
        await get().refresh(gateway)
        notify('执行配置已被其他修改更新，已重新读取最新修订，请再次切换', 'danger')
      } else {
        notify(messageOf(error), 'danger')
      }
    } finally {
      set((current) => ({ togglingIds: current.togglingIds.filter((id) => id !== profile.id) }))
    }
  },

  async saveGrant(gateway, input, editing) {
    const invalid = validateGrantInput(input)
    if (invalid !== undefined) {
      notify(invalid, 'danger')
      return false
    }
    if (editing !== undefined && input.id !== undefined && input.id !== '' && input.id !== editing.id) {
      notify('执行授权编号与路径不一致，请重新打开编辑', 'danger')
      return false
    }
    if (get().saving) return false
    set({ saving: true })
    try {
      if (editing === undefined) {
        const created = await gateway.agentCapabilities.createGrant({ ...input, id: undefined })
        notify(`授权「${created.name}」已创建（修订 ${created.revision}）${DEMO_SUFFIX}`)
      } else {
        const updated = await gateway.agentCapabilities.updateGrant(editing.id, { ...input, id: editing.id, expectedRevision: editing.revision })
        notify(`授权「${updated.name}」已更新到修订 ${updated.revision}${DEMO_SUFFIX}`)
      }
      await get().refresh(gateway)
      return true
    } catch (error) {
      if (isRevisionConflict(error)) {
        await get().refresh(gateway)
        notify('执行授权已被其他修改更新，已重新读取最新修订，请基于最新内容重试', 'danger')
      } else {
        notify(messageOf(error), 'danger')
      }
      return false
    } finally {
      set({ saving: false })
    }
  },

  async toggleGrantEnabled(gateway, grant, enabled) {
    if (get().togglingIds.includes(grant.id)) return
    set((current) => ({ togglingIds: [...current.togglingIds, grant.id] }))
    try {
      const updated = await gateway.agentCapabilities.setGrantEnabled(grant.id, grant.revision, enabled)
      notify(`授权「${updated.name}」已${updated.enabled ? '启用' : '停用'}（修订 ${updated.revision}）${DEMO_SUFFIX}`)
      await get().refresh(gateway)
    } catch (error) {
      if (isRevisionConflict(error)) {
        await get().refresh(gateway)
        notify('执行授权已被其他修改更新，已重新读取最新修订，请再次切换', 'danger')
      } else {
        notify(messageOf(error), 'danger')
      }
    } finally {
      set((current) => ({ togglingIds: current.togglingIds.filter((id) => id !== grant.id) }))
    }
  },

  async saveResourceRule(gateway, input, editing) {
    const invalid = validateResourceRuleInput(input)
    if (invalid !== undefined) {
      notify(invalid, 'danger')
      return false
    }
    if (get().saving) return false
    set({ saving: true })
    try {
      if (editing === undefined) {
        const created = await gateway.agentCapabilities.createResourceRule(input)
        notify(`资源规则「${created.name}」已创建（修订 ${created.revision}，摘要已更新）${DEMO_SUFFIX}`)
      } else {
        const updated = await gateway.agentCapabilities.updateResourceRule(editing.id, { ...input, expectedRevision: editing.revision })
        notify(`资源规则「${updated.name}」已更新到修订 ${updated.revision}，摘要已随之变化${DEMO_SUFFIX}`)
      }
      await get().refresh(gateway)
      return true
    } catch (error) {
      if (isRevisionConflict(error)) {
        await get().refresh(gateway)
        notify('资源规则已被其他修改更新，已重新读取最新修订，请基于最新内容重试', 'danger')
      } else {
        notify(messageOf(error), 'danger')
      }
      return false
    } finally {
      set({ saving: false })
    }
  },

  async loadRevisionDetail(gateway, kind, id, revision) {
    const request = ++revisionDetailRequest
    set({ detail: { kind, id, revision, status: 'loading' } })
    try {
      if (kind === 'execution') {
        const execution = await gateway.agentCapabilities.getExecutionProfile(id, revision)
        if (request !== revisionDetailRequest) return
        set({ detail: { kind, id, revision, status: 'ready', execution } })
      } else if (kind === 'grant') {
        const grant = await gateway.agentCapabilities.getGrant(id, revision)
        if (request !== revisionDetailRequest) return
        set({ detail: { kind, id, revision, status: 'ready', grant } })
      } else {
        const rule = await gateway.agentCapabilities.getResourceRule(id, revision)
        if (request !== revisionDetailRequest) return
        set({ detail: { kind, id, revision, status: 'ready', rule } })
      }
    } catch (error) {
      if (request !== revisionDetailRequest) return
      set({ detail: { kind, id, revision, status: 'error', errorMessage: messageOf(error) } })
    }
  },

  closeRevisionDetail() {
    revisionDetailRequest += 1
    set({ detail: undefined })
  },

  reset() {
    revisionDetailRequest += 1
    set({
      tab: 'execution',
      status: 'idle',
      domainStates: initialDomainStates(),
      errorMessage: undefined,
      reloading: false,
          executionProfiles: [],
      grants: [],
      resourceRules: [],
      executionRuntimes: [],
      search: '',
      saving: false,
      togglingIds: [],
      detail: undefined,
    })
  },
}))
