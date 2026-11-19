import type {
  AgentMCPCatalogProjection,
  AgentMCPServer,
  AgentMCPServerInput,
  AgentUpdateMCPServerInput,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentHttpError } from '../contracts/agentHttpError'
import { messageOf, MOCK_SUFFIX, notify } from './agentExtensionsFeedback'
import { createRequestGuard } from './requestGuard'
import { tableBatchFailure as batchFailure, type TableBatchOutcome as BatchMutationResult } from '../utils/tableBatch'

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

type McpDisplay = {
  mcpStatus: 'idle' | 'loading' | 'ready' | 'error'
  mcpServers: readonly AgentMCPServer[]
  mcpErrorMessage?: string
  mcpRefreshing: boolean
  mcpSaving: boolean
  mcpSaveError: string | null
  probe: ProbeState | null
  catalog: CatalogState | null
}

export type AgentExtensionMcpState = McpDisplay & {
  loadMcpServers(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  createMcpServer(gateway: ElysianGateway, input: AgentMCPServerInput): Promise<boolean>
  updateMcpServer(gateway: ElysianGateway, serverId: string, input: AgentUpdateMCPServerInput): Promise<boolean>
  setMcpActive(gateway: ElysianGateway, server: AgentMCPServer, active: boolean): Promise<BatchMutationResult>
  clearMcpSaveError(): void
  probeMcpServer(gateway: ElysianGateway, serverId: string, revision: number): Promise<void>
  loadMcpCatalog(gateway: ElysianGateway, serverId: string, revision: number, digest?: string): Promise<void>
  closeProbe(): void
  closeCatalog(): void
}

const blankMcp = (): McpDisplay => ({
  mcpStatus: 'idle',
  mcpErrorMessage: undefined,
  mcpServers: [],
  mcpRefreshing: false,
  mcpSaving: false,
  mcpSaveError: null,
  probe: null,
  catalog: null,
})

export function createAgentExtensionMcp(set: (state: Partial<McpDisplay>) => void, get: () => AgentExtensionMcpState) {
  const requests = createRequestGuard()
  let pendingList: { gateway: ElysianGateway; isCurrent: () => boolean; snapshot: readonly AgentMCPServer[]; promise: Promise<void> } | undefined
  const probeRequest = createRequestGuard()
  const catalogRequest = createRequestGuard()
  const pendingProbes = new Map<string, Promise<AgentMCPCatalogProjection>>()

  const state: AgentExtensionMcpState = {
    ...blankMcp(),
    loadMcpServers(gateway, options) {
      const previous = pendingList
      if (previous?.gateway === gateway && previous.isCurrent() && previous.snapshot === get().mcpServers) {
        if (!options?.silent) set({ mcpRefreshing: true })
        return previous.promise
      }
      const inPlace = get().mcpStatus === 'ready'
      const operation = { gateway, isCurrent: requests.capture(), snapshot: get().mcpServers, promise: Promise.resolve() }
      pendingList = operation
      const current = () => operation.isCurrent() && pendingList === operation
      set({ mcpStatus: inPlace ? 'ready' : 'loading', mcpRefreshing: inPlace && !options?.silent, mcpErrorMessage: undefined })
      operation.promise = (async () => {
        try {
          const items = await gateway.agentExtensions.listMcpServers()
          if (current() && operation.snapshot === get().mcpServers) set({ mcpStatus: 'ready', mcpServers: items, mcpErrorMessage: undefined })
        } catch (error) {
          if (current()) set({ mcpStatus: inPlace ? 'ready' : 'error', mcpErrorMessage: messageOf(error) })
        } finally {
          if (pendingList === operation) {
            pendingList = undefined
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
  }

  return {
    state,
    reset() {
      pendingList = undefined
      requests.invalidate()
      pendingProbes.clear()
      probeRequest.invalidate()
      catalogRequest.invalidate()
      return blankMcp()
    },
  }
}
