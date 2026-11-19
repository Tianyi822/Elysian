import type { AgentSkillImportInput, AgentSkillImportTask } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import type { AgentExtensionSkillsState } from './agentExtensionSkills'
import { messageOf, MOCK_SUFFIX, notify } from './agentExtensionsFeedback'
import { createRequestGuard } from './requestGuard'

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

type ImportDisplay = {
  importsStatus: 'idle' | 'loading' | 'ready' | 'error'
  imports: readonly AgentSkillImportTask[]
  importsErrorMessage?: string
  importsRefreshing: boolean
  importsLoadingMore: boolean
  importsNextCursor: string
  importsHasMore: boolean
  importActingIds: readonly string[]
  importSubmitError: string | null
}

export type AgentExtensionImportsState = ImportDisplay & {
  loadImports(gateway: ElysianGateway, options?: { silent?: boolean }): Promise<void>
  loadMoreImports(gateway: ElysianGateway): Promise<void>
  pollImports(gateway: ElysianGateway, signal?: AbortSignal): Promise<void>
  acceptSkillImport(gateway: ElysianGateway, task: AgentSkillImportTask): void
  submitSkillImport(gateway: ElysianGateway, input: AgentSkillImportInput, archive?: Blob): Promise<boolean>
  cancelSkillImport(gateway: ElysianGateway, importId: string): Promise<void>
  deleteSkillImportRecord(gateway: ElysianGateway, importId: string): Promise<void>
  clearImportSubmitError(): void
}

const blankImports = (): ImportDisplay => ({
  importsStatus: 'idle',
  importsErrorMessage: undefined,
  imports: [],
  importsRefreshing: false,
  importsLoadingMore: false,
  importsNextCursor: '',
  importsHasMore: false,
  importActingIds: [],
  importSubmitError: null,
})

export function createAgentExtensionImports(set: (state: Partial<ImportDisplay>) => void, get: () => AgentExtensionImportsState & Pick<AgentExtensionSkillsState, 'loadSkills'>) {
  const requests = createRequestGuard()
  let pendingList: { gateway: ElysianGateway; isCurrent: () => boolean; snapshot: readonly AgentSkillImportTask[]; promise: Promise<void> } | undefined

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

  const state: AgentExtensionImportsState = {
    ...blankImports(),
    loadImports(gateway, options) {
      const previous = pendingList
      if (previous?.gateway === gateway && previous.isCurrent() && previous.snapshot === get().imports) {
        if (!options?.silent) set({ importsRefreshing: true })
        return previous.promise
      }
      const inPlace = get().importsStatus === 'ready'
      const operation = { gateway, isCurrent: requests.capture(), snapshot: get().imports, promise: Promise.resolve() }
      pendingList = operation
      const current = () => operation.isCurrent() && pendingList === operation
      set({ importsStatus: inPlace ? 'ready' : 'loading', importsRefreshing: inPlace && !options?.silent, importsErrorMessage: undefined })
      operation.promise = (async () => {
        try {
          const page = await gateway.agentExtensions.listSkillImports()
          if (current() && operation.snapshot === get().imports) applyImportPage(gateway, page)
        } catch (error) {
          if (current()) set({ importsStatus: inPlace ? 'ready' : 'error', importsErrorMessage: messageOf(error) })
        } finally {
          if (pendingList === operation) {
            pendingList = undefined
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
  }

  return {
    state,
    reset() {
      pendingList = undefined
      requests.invalidate()
      return blankImports()
    },
  }
}

/** 是否存在排队/执行中的导入任务：3 秒静默轮询的开关（无活跃任务即停）。 */
export function selectImportsActive(state: AgentExtensionImportsState): boolean {
  return state.imports.some((item) => ACTIVE_IMPORT_STATES.has(item.state))
}
