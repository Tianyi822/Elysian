import { create } from 'zustand'
import type {
  AgentMCPCatalogProjection,
  AgentMCPServer,
  AgentMCPServerInput,
  AgentSkillImportInput,
  AgentSkillImportTask,
  AgentUpdateMCPServerInput,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentHttpError } from '../contracts/agentHttpError'
import { messageOf, MOCK_SUFFIX, notify } from './agentExtensionsFeedback'
import { createAgentExtensionSkills, type AgentExtensionSkillsState } from './agentExtensionSkills'
import { createRequestGuard } from './requestGuard'
import { tableBatchFailure as batchFailure, type TableBatchOutcome as BatchMutationResult } from '../utils/tableBatch'

/*
 * 技能与 MCP 域界面状态。数据一律经 gateway.agentExtensions 的 adapter 取，
 * 组件不碰数据来源。三个切片各自承担六态：技能目录、导入任务分页、MCP 服务与
 * 探测/固定目录。静默轮询只刷数据不驱动刷新按钮；导入任务由非终态转终态时顺带静默
 * 重读技能目录（导入成功的权威事实是服务端目录，不是任务回执）。启停、取消与
 * 记录删除按目标逐个记在途，连点单飞；探测结果未知（resource-busy）时保留服务
 * 端中文提示，不自动重试或跳转治理页面。
 */

const TERMINAL_IMPORT_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const ACTIVE_IMPORT_STATES = new Set(['queued', 'running'])

/** 首页轮询合并：服务端首页（最新在前）覆盖同 ID 旧项，旧页里不在首页的项保序保留。 */
function mergeImportPage(existing: readonly AgentSkillImportTask[], page: readonly AgentSkillImportTask[]): readonly AgentSkillImportTask[] {
  const pageIds = new Set(page.map((item) => item.id))
  const merged = new Map<string, AgentSkillImportTask>()
  for (const item of existing) {
    if (!pageIds.has(item.id)) merged.set(item.id, item)
  }
  for (const item of page) merged.set(item.id, item)
  return [...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}

export type { DeleteSkillTarget, SkillDetailState } from './agentExtensionSkills'

export type ProbeState = {
  serverId: string
  revision: number
  status: 'loading' | 'ready' | 'error'
  projection?: AgentMCPCatalogProjection
  errorMessage?: string
  /** 服务端 409 resource-busy：存在结果未知的租约，需由管理员核实。 */
  resourceBusy?: boolean
}

export type CatalogState = {
  serverId: string
  revision: number
  digest?: string
  status: 'loading' | 'ready' | 'error'
  projection?: AgentMCPCatalogProjection
  errorMessage?: string
}

export type AgentExtensionsState = AgentExtensionSkillsState & {
  importsStatus: 'idle' | 'loading' | 'ready' | 'error'
  imports: readonly AgentSkillImportTask[]
  importsErrorMessage?: string
  importsRefreshing: boolean
  importsLoadingMore: boolean
  importsNextCursor: string
  importsHasMore: boolean
  importActingIds: readonly string[]
  importSubmitError: string | null

  mcpStatus: 'idle' | 'loading' | 'ready' | 'error'
  mcpServers: readonly AgentMCPServer[]
  mcpErrorMessage?: string
  mcpRefreshing: boolean
  mcpSaving: boolean
  mcpSaveError: string | null
  probe: ProbeState | null
  catalog: CatalogState | null

  loadImports(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  loadMoreImports(gateway: ElysianGateway): Promise<void>
  pollImports(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  acceptSkillImport(gateway: ElysianGateway, task: AgentSkillImportTask): void
  submitSkillImport(gateway: ElysianGateway, input: AgentSkillImportInput, archive?: Blob): Promise<boolean>
  cancelSkillImport(gateway: ElysianGateway, importId: string): Promise<void>
  deleteSkillImportRecord(gateway: ElysianGateway, importId: string): Promise<void>
  clearImportSubmitError(): void

  loadMcpServers(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  createMcpServer(gateway: ElysianGateway, input: AgentMCPServerInput): Promise<boolean>
  updateMcpServer(gateway: ElysianGateway, serverId: string, input: AgentUpdateMCPServerInput): Promise<boolean>
  setMcpActive(gateway: ElysianGateway, server: AgentMCPServer, active: boolean): Promise<BatchMutationResult>
  clearMcpSaveError(): void
  probeMcpServer(gateway: ElysianGateway, serverId: string, revision: number): Promise<void>
  loadMcpCatalog(gateway: ElysianGateway, serverId: string, revision: number, digest?: string): Promise<void>
  closeProbe(): void
  closeCatalog(): void

  reset(): void
}

export const useAgentExtensionsStore = create<AgentExtensionsState>((set, get) => {
  const requests = createRequestGuard()
  const pendingLists = new Map<string, { gateway: ElysianGateway; isCurrent: () => boolean; snapshot: unknown; promise: Promise<void> }>()
  const skills = createAgentExtensionSkills(set, get)
  const probeRequest = createRequestGuard()
  const catalogRequest = createRequestGuard()
  const pendingProbes = new Map<string, Promise<AgentMCPCatalogProjection>>()
  /** 导入任务由非终态转终态时静默重读技能目录；成功/失败各给一次操作反馈。 */
  const noteImportTransitions = (previous: readonly AgentSkillImportTask[], next: readonly AgentSkillImportTask[]): boolean => {
    let changed = false
    const before = new Map(previous.map((item) => [item.id, item.state]))
    for (const item of next) {
      const oldState = before.get(item.id)
      if (oldState === undefined || oldState === item.state) continue
      if (!TERMINAL_IMPORT_STATES.has(item.state)) continue
      changed = true
      if (item.state === 'succeeded') {
        notify('success', `技能导入完成：${item.skillId ?? '新技能'}（修订 ${item.revision ?? 1}）${MOCK_SUFFIX}`)
      } else if (item.state === 'failed') {
        notify('danger', `技能导入失败：${item.error?.message ?? '服务端未返回原因'}`)
      }
    }
    return changed
  }

  const applyImportPage = (gateway: ElysianGateway, page: { items: readonly AgentSkillImportTask[]; nextCursor: string; hasMore: boolean }, preserveCursor = false): void => {
    const state = get()
    const items = state.importsStatus === 'ready' ? mergeImportPage(state.imports, page.items) : [...page.items]
    const skillsChanged = noteImportTransitions(state.imports, items)
    set({
      importsStatus: 'ready',
      imports: items,
      ...(!preserveCursor ? { importsNextCursor: page.nextCursor, importsHasMore: page.hasMore } : {}),
      importsRefreshing: false,
      importsLoadingMore: false,
      importsErrorMessage: undefined,
    })
    if (skillsChanged) {
      void get().loadSkills(gateway, { silent: true })
    }
  }

  return {
    ...skills.state,

    importsStatus: 'idle',
    imports: [],
    importsRefreshing: false,
    importsLoadingMore: false,
    importsNextCursor: '',
    importsHasMore: false,
    importActingIds: [],
    importSubmitError: null,

    mcpStatus: 'idle',
    mcpServers: [],
    mcpRefreshing: false,
    mcpSaving: false,
    mcpSaveError: null,
    probe: null,
    catalog: null,

    loadImports(gateway, options) {
      const previous = pendingLists.get('imports')
      if (previous?.gateway === gateway && previous.isCurrent() && previous.snapshot === get().imports) {
        if (!options?.silent) set({ importsRefreshing: true })
        return previous.promise
      }
      const inPlace = get().importsStatus === 'ready'
      const operation = { gateway, isCurrent: requests.capture(), snapshot: get().imports, promise: Promise.resolve() }
      pendingLists.set('imports', operation)
      const current = () => operation.isCurrent() && pendingLists.get('imports') === operation
      set({ importsStatus: inPlace ? 'ready' : 'loading', importsRefreshing: inPlace && !options?.silent, importsErrorMessage: undefined })
      operation.promise = (async () => {
        try {
          const page = await gateway.agentExtensions.listSkillImports()
          if (current() && operation.snapshot === get().imports) applyImportPage(gateway, page)
        } catch (error) {
          if (current()) set({ importsStatus: inPlace ? 'ready' : 'error', importsErrorMessage: messageOf(error) })
        } finally {
          if (pendingLists.get('imports') === operation) {
            pendingLists.delete('imports')
            if (operation.isCurrent()) set({ importsRefreshing: false })
          }
        }
      })()
      return operation.promise
    },
    async loadMoreImports(gateway) {
      const isCurrent = requests.capture()
      const state = get()
      if (state.importsLoadingMore || !state.importsHasMore) return
      set({ importsLoadingMore: true })
      try {
        const page = await gateway.agentExtensions.listSkillImports({ cursor: state.importsNextCursor })
        if (!isCurrent()) return
        const merged = mergeImportPage(get().imports, page.items)
        const skillsChanged = noteImportTransitions(get().imports, merged)
        set({
          importsLoadingMore: false,
          imports: merged,
          importsNextCursor: page.nextCursor,
          importsHasMore: page.hasMore,
          importsErrorMessage: undefined,
        })
        if (skillsChanged) void get().loadSkills(gateway, { silent: true })
      } catch (error) {
        if (!isCurrent()) return
        set({ importsLoadingMore: false, importsErrorMessage: messageOf(error) })
      }
    },
    async pollImports(gateway, signal) {
      const snapshot = get().imports
      const requestIsCurrent = requests.capture()
      const isCurrent = () => requestIsCurrent() && !signal?.aborted && snapshot === get().imports
      const page = await gateway.agentExtensions.listSkillImports({ limit: 50 }, signal)
      if (!isCurrent()) return
      const onPage = new Set(page.items.map(task => task.id))
      const older = get().imports.filter(task => ACTIVE_IMPORT_STATES.has(task.state) && !onPage.has(task.id))
      const refreshed = await Promise.all(older.map(task => gateway.agentExtensions.getSkillImport(task.id, signal)))
      if (!isCurrent()) return
      applyImportPage(gateway, { ...page, items: [...page.items, ...refreshed] }, get().importsStatus === 'ready')
    },
    acceptSkillImport(gateway, task) {
      set({
        importsStatus: 'ready',
        imports: mergeImportPage(get().imports, [task]),
        importSubmitError: null,
      })
      if (TERMINAL_IMPORT_STATES.has(task.state)) void get().loadSkills(gateway, { silent: true })
      notify('info', `Skill 导入已受理，可在导入记录查看进度${MOCK_SUFFIX}`)
    },
    async submitSkillImport(gateway, input, archive) {
      const isCurrent = requests.capture()
      set({ importSubmitError: null })
      try {
        const task = await gateway.agentExtensions.createSkillImport(input, archive)
        if (!isCurrent()) return false
        get().acceptSkillImport(gateway, task)
        return true
      } catch (error) {
        if (!isCurrent()) return false
        const message = messageOf(error)
        set({ importSubmitError: message })
        return false
      }
    },
    async cancelSkillImport(gateway, importId) {
      const isCurrent = requests.capture()
      if (get().importActingIds.includes(importId)) return
      set({ importActingIds: [...get().importActingIds, importId] })
      try {
        const task = await gateway.agentExtensions.cancelSkillImport(importId)
        if (!isCurrent()) return
        const skillsChanged = noteImportTransitions(get().imports, [task])
        set({
          imports: get().imports.map((item) => (item.id === task.id ? task : item)),
          importActingIds: get().importActingIds.filter((id) => id !== importId),
        })
        if (skillsChanged) void get().loadSkills(gateway, { silent: true })
        if (task.state === 'cancelled') {
          notify('info', `导入任务 ${task.id} 已取消${MOCK_SUFFIX}`)
        } else if (TERMINAL_IMPORT_STATES.has(task.state)) {
          notify('info', `导入任务 ${task.id} 已结束，请查看最终状态${MOCK_SUFFIX}`)
        } else {
          notify('info', `导入任务 ${task.id} 的取消请求已提交，等待任务停止${MOCK_SUFFIX}`)
        }
      } catch (error) {
        if (!isCurrent()) return
        set({ importActingIds: get().importActingIds.filter((id) => id !== importId) })
        notify('danger', messageOf(error))
      }
    },
    async deleteSkillImportRecord(gateway, importId) {
      const isCurrent = requests.capture()
      if (get().importActingIds.includes(importId)) return
      set({ importActingIds: [...get().importActingIds, importId] })
      try {
        await gateway.agentExtensions.deleteSkillImportRecord(importId)
        if (!isCurrent()) return
        set({
          imports: get().imports.filter((item) => item.id !== importId),
          importActingIds: get().importActingIds.filter((id) => id !== importId),
        })
        notify('success', `导入记录 ${importId} 已删除${MOCK_SUFFIX}`)
      } catch (error) {
        if (!isCurrent()) return
        set({ importActingIds: get().importActingIds.filter((id) => id !== importId) })
        notify('danger', messageOf(error))
      }
    },
    clearImportSubmitError() {
      set({ importSubmitError: null })
    },

    loadMcpServers(gateway, options) {
      const previous = pendingLists.get('mcp')
      if (previous?.gateway === gateway && previous.isCurrent() && previous.snapshot === get().mcpServers) {
        if (!options?.silent) set({ mcpRefreshing: true })
        return previous.promise
      }
      const inPlace = get().mcpStatus === 'ready'
      const operation = { gateway, isCurrent: requests.capture(), snapshot: get().mcpServers, promise: Promise.resolve() }
      pendingLists.set('mcp', operation)
      const current = () => operation.isCurrent() && pendingLists.get('mcp') === operation
      set({ mcpStatus: inPlace ? 'ready' : 'loading', mcpRefreshing: inPlace && !options?.silent, mcpErrorMessage: undefined })
      operation.promise = (async () => {
        try {
          const items = await gateway.agentExtensions.listMcpServers()
          if (current() && operation.snapshot === get().mcpServers) set({ mcpStatus: 'ready', mcpServers: items, mcpErrorMessage: undefined })
        } catch (error) {
          if (current()) set({ mcpStatus: inPlace ? 'ready' : 'error', mcpErrorMessage: messageOf(error) })
        } finally {
          if (pendingLists.get('mcp') === operation) {
            pendingLists.delete('mcp')
            if (operation.isCurrent()) set({ mcpRefreshing: false })
          }
        }
      })()
      return operation.promise
    },
    async createMcpServer(gateway, input) {
      const isCurrent = requests.capture()
      if (get().mcpSaving) return false
      set({ mcpSaving: true, mcpSaveError: null })
      try {
        const item = await gateway.agentExtensions.createMcpServer(input)
        if (!isCurrent()) return false
        set({ mcpSaving: false, mcpServers: [...get().mcpServers, item] })
        notify('success', `MCP 服务「${item.name}」已创建（修订 ${item.revision}）${MOCK_SUFFIX}`)
        return true
      } catch (error) {
        if (!isCurrent()) return false
        set({ mcpSaving: false, mcpSaveError: messageOf(error) })
        notify('danger', messageOf(error))
        if (error instanceof AgentHttpError && error.status === 409) void get().loadMcpServers(gateway, { silent: true })
        return false
      }
    },
    async updateMcpServer(gateway, serverId, input) {
      const isCurrent = requests.capture()
      if (get().mcpSaving) return false
      set({ mcpSaving: true, mcpSaveError: null })
      try {
        const item = await gateway.agentExtensions.updateMcpServer(serverId, input)
        if (!isCurrent()) return false
        set({
          mcpSaving: false,
          mcpServers: get().mcpServers.map((entry) => (entry.id === item.id ? item : entry)),
        })
        notify('success', `MCP 服务「${item.name}」已保存（修订 ${item.revision}）${MOCK_SUFFIX}`)
        return true
      } catch (error) {
        if (!isCurrent()) return false
        set({ mcpSaving: false, mcpSaveError: messageOf(error) })
        notify('danger', messageOf(error))
        if (error instanceof AgentHttpError && error.status === 409) void get().loadMcpServers(gateway, { silent: true })
        return false
      }
    },
    async setMcpActive(gateway, server, active) {
      const current = get().mcpServers.find(item => item.id === server.id)
      if (!current || current.revision !== server.revision) return { status: 'failed', error: 'MCP 服务修订已变化，请重新选择后重试' }
      if (current.revoked) return { status: 'failed', error: 'MCP 服务已永久撤销，不能启停' }
      if (get().mcpSaving) return { status: 'failed', error: 'MCP 配置正在保存，请稍后重试' }
      const input: AgentUpdateMCPServerInput = {
        name: current.name, transport: current.transport, active, revoked: current.revoked, expectedRevision: current.revision,
        ...(current.transport === 'streamable-http' ? { url: current.url } : { stdio: current.stdio && {
          image: current.stdio.image, command: current.stdio.command,
          ...(current.stdio.requestedAccess !== undefined ? { requestedAccess: current.stdio.requestedAccess } : {}),
          ...(current.stdio.grantId !== undefined ? { grantId: current.stdio.grantId } : {}),
          ...(current.stdio.grantRevision !== undefined ? { grantRevision: current.stdio.grantRevision } : {}),
        } }),
      }
      const isCurrent = requests.capture()
      set({ mcpSaving: true, mcpSaveError: null })
      try {
        const item = await gateway.agentExtensions.updateMcpServer(server.id, input)
        if (!isCurrent()) return { status: 'unknown', error: '登录状态已变化，请重新读取 MCP 服务核实结果' }
        set({ mcpServers: get().mcpServers.map(entry => entry.id === item.id && entry.revision <= item.revision ? item : entry) })
        return { status: 'succeeded' }
      } catch (error) {
        if (isCurrent()) {
          set({ mcpSaveError: messageOf(error) })
          if (error instanceof AgentHttpError && error.status === 409) void get().loadMcpServers(gateway, { silent: true })
        }
        return batchFailure(error)
      } finally { if (isCurrent()) set({ mcpSaving: false }) }
    },
    clearMcpSaveError() {
      set({ mcpSaveError: null })
    },
    async probeMcpServer(gateway, serverId, revision) {
      const isCurrent = probeRequest.replace()
      const key = `${serverId}@${revision}`
      set({ probe: { serverId, revision, status: 'loading' } })
      let pending = pendingProbes.get(key)
      if (pending === undefined) {
        pending = gateway.agentExtensions.probeMcpServer(serverId, revision)
        pendingProbes.set(key, pending)
      }
      try {
        const projection = await pending
        if (!isCurrent()) return
        set({ probe: { serverId, revision, status: 'ready', projection } })
      } catch (error) {
        if (!isCurrent()) return
        const resourceBusy = error instanceof AgentHttpError && error.code === 'resource-busy'
        set({ probe: { serverId, revision, status: 'error', errorMessage: messageOf(error), ...(resourceBusy ? { resourceBusy: true } : {}) } })
      } finally {
        if (pendingProbes.get(key) === pending) pendingProbes.delete(key)
      }
    },
    async loadMcpCatalog(gateway, serverId, revision, digest) {
      const isCurrent = catalogRequest.replace()
      set({ catalog: { serverId, revision, digest, status: 'loading' } })
      try {
        const projection = await gateway.agentExtensions.getMcpCatalog(serverId, revision, digest)
        if (!isCurrent()) return
        set({ catalog: { serverId, revision, digest, status: 'ready', projection } })
      } catch (error) {
        if (!isCurrent()) return
        set({ catalog: { serverId, revision, digest, status: 'error', errorMessage: messageOf(error) } })
      }
    },
    closeProbe() {
      probeRequest.invalidate()
      set({ probe: null })
    },
    closeCatalog() {
      catalogRequest.invalidate()
      set({ catalog: null })
    },

    reset() {
      pendingLists.clear()
      requests.invalidate()
      pendingProbes.clear()
      probeRequest.invalidate()
      catalogRequest.invalidate()
      set({
        ...skills.reset(),
        importsStatus: 'idle',
        importsErrorMessage: undefined,
        imports: [],
        importsRefreshing: false,
        importsLoadingMore: false,
        importsNextCursor: '',
        importsHasMore: false,
        importActingIds: [],
        importSubmitError: null,
        mcpStatus: 'idle',
        mcpErrorMessage: undefined,
        mcpServers: [],
        mcpRefreshing: false,
        mcpSaving: false,
        mcpSaveError: null,
        probe: null,
        catalog: null,
      })
    },
  }
})

/** 是否存在排队/执行中的导入任务：3 秒静默轮询的开关（无活跃任务即停）。 */
export function selectImportsActive(state: AgentExtensionsState): boolean {
  return state.imports.some((item) => ACTIVE_IMPORT_STATES.has(item.state))
}
