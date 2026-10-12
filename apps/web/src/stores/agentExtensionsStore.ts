import { create } from 'zustand'
import type {
  AgentMCPCatalogProjection,
  AgentMCPServer,
  AgentMCPServerInput,
  AgentSkill,
  AgentSkillFilePreview,
  AgentSkillImportInput,
  AgentSkillImportTask,
  AgentUpdateMCPServerInput,
} from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentHttpError } from '../adapters/http/agent/agentShared'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { useNotificationStore } from './notificationStore'

/*
 * 技能与 MCP 域界面状态。数据一律经 gateway.agentExtensions 的 adapter 取，
 * 组件不碰数据来源。三个切片各自承担六态：技能目录、导入任务分页、MCP 服务与
 * 探测/固定目录。静默轮询只刷数据不驱动遮罩；导入任务由非终态转终态时顺带静默
 * 重读技能目录（导入成功的权威事实是服务端目录，不是任务回执）。启停、取消与
 * 记录删除按目标逐个记在途，连点单飞；探测结果未知（resource-busy）时保留服务
 * 端中文提示供页面深链治理中心。
 */

const MOCK_SUFFIX = isDockerRuntime() ? '' : '（演示数据）'

const TERMINAL_IMPORT_STATES = new Set(['succeeded', 'failed', 'cancelled', 'interrupted'])
const ACTIVE_IMPORT_STATES = new Set(['queued', 'running'])

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}

function notify(tone: 'success' | 'info' | 'danger', message: string): void {
  useNotificationStore.getState().notify({ tone, message })
}

/** 首页轮询合并：服务端首页（最新在前）覆盖同 ID 旧项，旧页里不在首页的项保序保留。 */
function mergeImportPage(existing: readonly AgentSkillImportTask[], page: readonly AgentSkillImportTask[]): readonly AgentSkillImportTask[] {
  const pageIds = new Set(page.map((item) => item.id))
  const merged = new Map<string, AgentSkillImportTask>()
  for (const item of existing) {
    if (!pageIds.has(item.id)) merged.set(item.id, item)
  }
  for (const item of page) merged.set(item.id, item)
  return [...merged.values()]
}

export type SkillDetailState = {
  skillId: string
  revision?: number
  loading: boolean
  item?: AgentSkill
  errorMessage?: string
  file: { path: string; status: 'loading' | 'ready' | 'error'; preview?: AgentSkillFilePreview; errorMessage?: string } | null
}

export type DeleteSkillTarget = { skillId: string; name: string; revision: number }

export type ProbeState = {
  serverId: string
  revision: number
  status: 'loading' | 'ready' | 'error'
  projection?: AgentMCPCatalogProjection
  errorMessage?: string
  /** 服务端 409 resource-busy：存在结果未知的租约，需先到治理中心核实。 */
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

export type AgentExtensionsState = {
  skillsStatus: 'idle' | 'loading' | 'ready' | 'error'
  skills: readonly AgentSkill[]
  skillsErrorMessage?: string
  skillsRefreshing: boolean
  togglingSkillIds: readonly string[]
  skillDetail: SkillDetailState | null
  deleteTarget: DeleteSkillTarget | null
  deletingSkill: boolean

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

  loadSkills(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  loadSkillDetail(gateway: ElysianGateway, skillId: string, revision?: number): Promise<void>
  loadSkillFile(gateway: ElysianGateway, skillId: string, revision: number, path: string): Promise<void>
  closeSkillDetail(): void
  setSkillEnabled(gateway: ElysianGateway, skillId: string, expectedRevision: number, enabled: boolean): Promise<void>
  requestDeleteSkill(target: DeleteSkillTarget): void
  cancelDeleteSkill(): void
  confirmDeleteSkill(gateway: ElysianGateway): Promise<void>

  loadImports(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  loadMoreImports(gateway: ElysianGateway): Promise<void>
  pollImports(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  submitSkillImport(gateway: ElysianGateway, input: AgentSkillImportInput, archive?: Blob): Promise<boolean>
  cancelSkillImport(gateway: ElysianGateway, importId: string): Promise<void>
  deleteSkillImportRecord(gateway: ElysianGateway, importId: string): Promise<void>
  clearImportSubmitError(): void

  loadMcpServers(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  createMcpServer(gateway: ElysianGateway, input: AgentMCPServerInput): Promise<boolean>
  updateMcpServer(gateway: ElysianGateway, serverId: string, input: AgentUpdateMCPServerInput): Promise<boolean>
  clearMcpSaveError(): void
  probeMcpServer(gateway: ElysianGateway, serverId: string, revision: number): Promise<void>
  loadMcpCatalog(gateway: ElysianGateway, serverId: string, revision: number, digest?: string): Promise<void>
  closeProbe(): void
  closeCatalog(): void

  reset(): void
}

export const useAgentExtensionsStore = create<AgentExtensionsState>((set, get) => {
  let skillDetailRequest = 0
  let skillFileRequest = 0
  let probeRequest = 0
  let catalogRequest = 0
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

  const applyImportPage = (gateway: ElysianGateway, page: { items: readonly AgentSkillImportTask[]; nextCursor: string; hasMore: boolean }): void => {
    const state = get()
    const items = state.importsStatus === 'ready' ? mergeImportPage(state.imports, page.items) : [...page.items]
    const skillsChanged = noteImportTransitions(state.imports, items)
    set({
      importsStatus: 'ready',
      imports: items,
      importsNextCursor: page.nextCursor,
      importsHasMore: page.hasMore,
      importsRefreshing: false,
      importsLoadingMore: false,
      importsErrorMessage: undefined,
    })
    if (skillsChanged) {
      void get().loadSkills(gateway, { silent: true })
    }
  }

  return {
    skillsStatus: 'idle',
    skills: [],
    skillsRefreshing: false,
    togglingSkillIds: [],
    skillDetail: null,
    deleteTarget: null,
    deletingSkill: false,

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

    async loadSkills(gateway, options) {
      const inPlace = get().skillsStatus === 'ready'
      if (!options?.silent) {
        set(inPlace ? { skillsRefreshing: true } : { skillsStatus: 'loading', skillsErrorMessage: undefined })
      }
      try {
        const items = await gateway.agentExtensions.listSkills()
        set({ skillsStatus: 'ready', skills: items, skillsRefreshing: false, skillsErrorMessage: undefined })
      } catch (error) {
        set({
          skillsStatus: get().skills.length > 0 ? get().skillsStatus : 'error',
          skillsRefreshing: false,
          skillsErrorMessage: messageOf(error),
        })
      }
    },
    async loadSkillDetail(gateway, skillId, revision) {
      const request = ++skillDetailRequest
      skillFileRequest += 1
      set({ skillDetail: { skillId, revision, loading: true, file: null } })
      try {
        const item = await gateway.agentExtensions.getSkill(skillId, revision)
        if (request === skillDetailRequest) set({ skillDetail: { skillId, revision: item.revision, loading: false, item, file: null } })
      } catch (error) {
        if (request === skillDetailRequest) set({ skillDetail: { skillId, revision, loading: false, errorMessage: messageOf(error), file: null } })
      }
    },
    async loadSkillFile(gateway, skillId, revision, path) {
      const request = ++skillFileRequest
      const current = get().skillDetail
      if (current === null || current.skillId !== skillId || current.revision !== revision || current.item === undefined) return
      set({ skillDetail: { ...current, file: { path, status: 'loading' } } })
      try {
        const preview = await gateway.agentExtensions.getSkillFile(skillId, revision, path)
        const latest = get().skillDetail
        if (request === skillFileRequest && latest?.skillId === skillId && latest.revision === revision && latest.file?.path === path) {
          set({ skillDetail: { ...latest, file: { path, status: 'ready', preview } } })
        }
      } catch (error) {
        const latest = get().skillDetail
        if (request === skillFileRequest && latest?.skillId === skillId && latest.revision === revision && latest.file?.path === path) {
          set({ skillDetail: { ...latest, file: { path, status: 'error', errorMessage: messageOf(error) } } })
        }
      }
    },
    closeSkillDetail() {
      skillDetailRequest += 1
      skillFileRequest += 1
      set({ skillDetail: null })
    },
    async setSkillEnabled(gateway, skillId, expectedRevision, enabled) {
      if (get().togglingSkillIds.includes(skillId)) return
      set({ togglingSkillIds: [...get().togglingSkillIds, skillId] })
      try {
        const item = await gateway.agentExtensions.setSkillEnabled(skillId, expectedRevision, enabled)
        set({
          skills: get().skills.map((entry) => (entry.id === item.id ? item : entry)),
          togglingSkillIds: get().togglingSkillIds.filter((id) => id !== skillId),
        })
        notify(enabled ? 'success' : 'info', `技能「${item.manifest.name}」已${enabled ? '启用' : '停用'}（修订 ${item.revision}）${MOCK_SUFFIX}`)
      } catch (error) {
        set({ togglingSkillIds: get().togglingSkillIds.filter((id) => id !== skillId) })
        notify('danger', messageOf(error))
      }
    },
    requestDeleteSkill(target) {
      set({ deleteTarget: target })
    },
    cancelDeleteSkill() {
      set({ deleteTarget: null })
    },
    async confirmDeleteSkill(gateway) {
      const target = get().deleteTarget
      if (target === null || get().deletingSkill) return
      set({ deletingSkill: true })
      try {
        await gateway.agentExtensions.deleteSkill(target.skillId, target.revision)
        set({
          deletingSkill: false,
          deleteTarget: null,
          skills: get().skills.filter((item) => item.id !== target.skillId),
        })
        notify('success', `技能「${target.name}」已删除，登记容量随登记文件收缩${MOCK_SUFFIX}`)
      } catch (error) {
        set({ deletingSkill: false })
        notify('danger', messageOf(error))
      }
    },

    async loadImports(gateway, options) {
      const inPlace = get().importsStatus === 'ready'
      if (!options?.silent) {
        set(inPlace ? { importsRefreshing: true } : { importsStatus: 'loading', importsErrorMessage: undefined })
      }
      try {
        const page = await gateway.agentExtensions.listSkillImports()
        applyImportPage(gateway, page)
      } catch (error) {
        set({
          importsStatus: get().imports.length > 0 ? get().importsStatus : 'error',
          importsRefreshing: false,
          importsErrorMessage: messageOf(error),
        })
      }
    },
    async loadMoreImports(gateway) {
      const state = get()
      if (state.importsLoadingMore || !state.importsHasMore) return
      set({ importsLoadingMore: true })
      try {
        const page = await gateway.agentExtensions.listSkillImports({ cursor: state.importsNextCursor })
        const merged = mergeImportPage(state.imports, page.items)
        set({
          importsLoadingMore: false,
          imports: merged,
          importsNextCursor: page.nextCursor,
          importsHasMore: page.hasMore,
          importsErrorMessage: undefined,
        })
      } catch (error) {
        set({ importsLoadingMore: false, importsErrorMessage: messageOf(error) })
      }
    },
    async pollImports(gateway, signal) {
      const page = await gateway.agentExtensions.listSkillImports({ limit: 50 }, signal)
      if (signal?.aborted) return
      applyImportPage(gateway, page)
    },
    async submitSkillImport(gateway, input, archive) {
      set({ importSubmitError: null })
      try {
        const task = await gateway.agentExtensions.createSkillImport(input, archive)
        set({
          importsStatus: 'ready',
          imports: mergeImportPage(get().imports, [task]),
          importSubmitError: null,
        })
        notify('info', `技能导入已受理（任务 ${task.id}，requestId ${task.requestId}）${MOCK_SUFFIX}`)
        return true
      } catch (error) {
        const message = messageOf(error)
        set({ importSubmitError: message })
        return false
      }
    },
    async cancelSkillImport(gateway, importId) {
      if (get().importActingIds.includes(importId)) return
      set({ importActingIds: [...get().importActingIds, importId] })
      try {
        const task = await gateway.agentExtensions.cancelSkillImport(importId)
        set({
          imports: get().imports.map((item) => (item.id === task.id ? task : item)),
          importActingIds: get().importActingIds.filter((id) => id !== importId),
        })
        if (task.state === 'cancelled') {
          notify('info', `导入任务 ${task.id} 已取消${MOCK_SUFFIX}`)
        } else {
          notify('info', `导入任务 ${task.id} 的取消请求已提交，等待任务停止${MOCK_SUFFIX}`)
        }
      } catch (error) {
        set({ importActingIds: get().importActingIds.filter((id) => id !== importId) })
        notify('danger', messageOf(error))
      }
    },
    async deleteSkillImportRecord(gateway, importId) {
      if (get().importActingIds.includes(importId)) return
      set({ importActingIds: [...get().importActingIds, importId] })
      try {
        await gateway.agentExtensions.deleteSkillImportRecord(importId)
        set({
          imports: get().imports.filter((item) => item.id !== importId),
          importActingIds: get().importActingIds.filter((id) => id !== importId),
        })
        notify('success', `导入记录 ${importId} 已删除${MOCK_SUFFIX}`)
      } catch (error) {
        set({ importActingIds: get().importActingIds.filter((id) => id !== importId) })
        notify('danger', messageOf(error))
      }
    },
    clearImportSubmitError() {
      set({ importSubmitError: null })
    },

    async loadMcpServers(gateway, options) {
      const inPlace = get().mcpStatus === 'ready'
      if (!options?.silent) {
        set(inPlace ? { mcpRefreshing: true } : { mcpStatus: 'loading', mcpErrorMessage: undefined })
      }
      try {
        const items = await gateway.agentExtensions.listMcpServers()
        set({ mcpStatus: 'ready', mcpServers: items, mcpRefreshing: false, mcpErrorMessage: undefined })
      } catch (error) {
        set({
          mcpStatus: get().mcpServers.length > 0 ? get().mcpStatus : 'error',
          mcpRefreshing: false,
          mcpErrorMessage: messageOf(error),
        })
      }
    },
    async createMcpServer(gateway, input) {
      if (get().mcpSaving) return false
      set({ mcpSaving: true, mcpSaveError: null })
      try {
        const item = await gateway.agentExtensions.createMcpServer(input)
        set({ mcpSaving: false, mcpServers: [...get().mcpServers, item] })
        notify('success', `MCP 服务「${item.name}」已创建（修订 ${item.revision}）${MOCK_SUFFIX}`)
        return true
      } catch (error) {
        set({ mcpSaving: false, mcpSaveError: messageOf(error) })
        return false
      }
    },
    async updateMcpServer(gateway, serverId, input) {
      if (get().mcpSaving) return false
      set({ mcpSaving: true, mcpSaveError: null })
      try {
        const item = await gateway.agentExtensions.updateMcpServer(serverId, input)
        set({
          mcpSaving: false,
          mcpServers: get().mcpServers.map((entry) => (entry.id === item.id ? item : entry)),
        })
        notify('success', `MCP 服务「${item.name}」已保存（修订 ${item.revision}）${MOCK_SUFFIX}`)
        return true
      } catch (error) {
        set({ mcpSaving: false, mcpSaveError: messageOf(error) })
        return false
      }
    },
    clearMcpSaveError() {
      set({ mcpSaveError: null })
    },
    async probeMcpServer(gateway, serverId, revision) {
      const key = `${serverId}@${revision}`
      const request = ++probeRequest
      set({ probe: { serverId, revision, status: 'loading' } })
      let pending = pendingProbes.get(key)
      if (pending === undefined) {
        pending = gateway.agentExtensions.probeMcpServer(serverId, revision)
        pendingProbes.set(key, pending)
      }
      try {
        const projection = await pending
        if (request === probeRequest) set({ probe: { serverId, revision, status: 'ready', projection } })
      } catch (error) {
        if (request !== probeRequest) return
        const resourceBusy = error instanceof AgentHttpError && error.code === 'resource-busy'
        set({ probe: { serverId, revision, status: 'error', errorMessage: messageOf(error), ...(resourceBusy ? { resourceBusy: true } : {}) } })
      } finally {
        if (pendingProbes.get(key) === pending) pendingProbes.delete(key)
      }
    },
    async loadMcpCatalog(gateway, serverId, revision, digest) {
      const request = ++catalogRequest
      set({ catalog: { serverId, revision, digest, status: 'loading' } })
      try {
        const projection = await gateway.agentExtensions.getMcpCatalog(serverId, revision, digest)
        if (request === catalogRequest) set({ catalog: { serverId, revision, digest, status: 'ready', projection } })
      } catch (error) {
        if (request === catalogRequest) set({ catalog: { serverId, revision, digest, status: 'error', errorMessage: messageOf(error) } })
      }
    },
    closeProbe() {
      probeRequest += 1
      set({ probe: null })
    },
    closeCatalog() {
      catalogRequest += 1
      set({ catalog: null })
    },

    reset() {
      skillDetailRequest += 1
      skillFileRequest += 1
      probeRequest += 1
      catalogRequest += 1
      set({
        skillsStatus: 'idle',
        skills: [],
        skillsRefreshing: false,
        togglingSkillIds: [],
        skillDetail: null,
        deleteTarget: null,
        deletingSkill: false,
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
      })
    },
  }
})

/** 是否存在排队/执行中的导入任务：3 秒静默轮询的开关（无活跃任务即停）。 */
export function selectImportsActive(state: AgentExtensionsState): boolean {
  return state.imports.some((item) => ACTIVE_IMPORT_STATES.has(item.state))
}
