import { create } from 'zustand'
import type {
  AgentMCPCatalogProjection,
  AgentMCPServer,
  AgentMCPServerInput,
  AgentUpdateMCPServerInput,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentHttpError } from '../contracts/agentHttpError'
import { messageOf, MOCK_SUFFIX, notify } from './agentExtensionsFeedback'
import { createAgentExtensionImports, type AgentExtensionImportsState } from './agentExtensionImports'
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

export { selectImportsActive } from './agentExtensionImports'
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

export type AgentExtensionsState = AgentExtensionSkillsState & AgentExtensionImportsState & {
  mcpStatus: 'idle' | 'loading' | 'ready' | 'error'
  mcpServers: readonly AgentMCPServer[]
  mcpErrorMessage?: string
  mcpRefreshing: boolean
  mcpSaving: boolean
  mcpSaveError: string | null
  probe: ProbeState | null
  catalog: CatalogState | null

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
  const imports = createAgentExtensionImports(set, get)
  const probeRequest = createRequestGuard()
  const catalogRequest = createRequestGuard()
  const pendingProbes = new Map<string, Promise<AgentMCPCatalogProjection>>()

  return {
    ...skills.state,

    ...imports.state,

    mcpStatus: 'idle',
    mcpServers: [],
    mcpRefreshing: false,
    mcpSaving: false,
    mcpSaveError: null,
    probe: null,
    catalog: null,

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
        ...imports.reset(),
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
