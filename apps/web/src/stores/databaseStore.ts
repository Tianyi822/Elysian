import { captureAuthGeneration } from '../utils/authGeneration'
import { create } from 'zustand'
import {
  DATABASE_TAB_ENGINES,
  type DatabaseContainerEngine,
  type DatabaseContainerInstance,
  type DatabaseInstance,
} from '@elysian/contracts'
import type { ElysianGateway, DatabaseCreateInput } from '../contracts/adapters'
import { useMessageStore } from './messageStore'
import { notifyFirewallPortSync } from './firewallPortNotice'
import { messageOf } from '../utils/errorMessage'
import { withBusyId, withoutBusyId } from './busyIds'
import { readContainerInventory } from './containersStore'
import { createRequestGuard } from './requestGuard'

type DatabaseKind = 'container' | 'file'
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export type DatabaseState = {
  /** 容器分区页签：只在三引擎词表内取值，SQLite 文件以固定分区呈现、不占页签。 */
  engine: DatabaseContainerEngine
  status: LoadStatus
  sqliteStatus: LoadStatus
  /** 数据库容器行（GET /api/databases）。 */
  databases: readonly DatabaseContainerInstance[]
  /** SQLite 文件行（GET /api/databases/sqlite）。 */
  sqliteFiles: readonly DatabaseInstance[]
  errorMessage?: string
  sqliteErrorMessage?: string
  /** 列表手动刷新在途：仅驱动对应刷新按钮。 */
  refreshing: boolean
  /** 创建弹窗的开关与目标（容器行或 SQLite 文件）。 */
  createOpen: boolean
  createKind: 'container' | 'file'
  creating: boolean
  createError?: string
  uploadPercent?: number
  /** 正在删除的容器行 id：卡片动作行据此禁用。 */
  removingContainerIds: readonly string[]
  /** 正在删除的 SQLite 文件行 id。 */
  removingSqliteIds: readonly string[]
  clearDisplay(): void
  setEngine(engine: DatabaseContainerEngine): void
  load(gateway: ElysianGateway): Promise<void>
  refresh(gateway: ElysianGateway, showIndicator?: boolean): Promise<void>
  refreshAfterMutation(gateway: ElysianGateway, kind: DatabaseKind): Promise<void>
  openCreate(kind: 'container' | 'file'): void
  closeCreate(): void
  createDatabase(gateway: ElysianGateway, input: DatabaseCreateInput): Promise<void>
  removeContainer(gateway: ElysianGateway, containerId: string): Promise<void>
  removeSqliteFile(gateway: ElysianGateway, fileId: string): Promise<void>
}

type PendingLoad = {
  gateway: ElysianGateway
  auth: number
  promise: Promise<void>
}

const pendingLoads: Partial<Record<DatabaseKind, PendingLoad>> = {}
const mutations = createRequestGuard()

const initialDisplay = {
  status: 'idle',
  sqliteStatus: 'idle',
  databases: [],
  sqliteFiles: [],
  errorMessage: undefined,
  sqliteErrorMessage: undefined,
  refreshing: false,
  createOpen: false,
  createKind: 'file',
  creating: false,
  createError: undefined,
  uploadPercent: undefined,
  removingContainerIds: [],
  removingSqliteIds: [],
} as const

function refreshDataset(gateway: ElysianGateway, kind: DatabaseKind, showIndicator = false, afterMutation = false) {
  const auth = captureAuthGeneration()
  const container = kind === 'container'
  const status = container ? 'status' : 'sqliteStatus'
  const errorMessage = container ? 'errorMessage' : 'sqliteErrorMessage'
  const label = container ? '数据库容器' : 'SQLite 文件'
  const { getState, setState } = useDatabaseStore
  const pending = pendingLoads[kind]
  const sameRequestContext = pending?.gateway === gateway && pending.auth === auth
  if (sameRequestContext && !afterMutation) {
    if (showIndicator && container) setState({ refreshing: true })
    return pending.promise
  }
  const state = getState()
  const hadData = state[status] === 'ready'
  const operation = { gateway, auth, promise: Promise.resolve() }
  pendingLoads[kind] = operation
  const current = () => pendingLoads[kind] === operation && auth === captureAuthGeneration()
  setState({
    [status]: hadData ? 'ready' : 'loading',
    ...(!hadData ? { [errorMessage]: undefined } : {}),
    ...(container ? { refreshing: showIndicator || (sameRequestContext && state.refreshing) } : {}),
  })
  operation.promise = (async () => {
    try {
      if (container) {
        const [databases] = await Promise.all([
          gateway.databases.list(), readContainerInventory(gateway, { fresh: afterMutation }),
        ])
        if (current()) setState({ status: 'ready', databases, errorMessage: undefined })
      } else {
        const sqliteFiles = await gateway.databases.listSqlite()
        if (current()) setState({ sqliteStatus: 'ready', sqliteFiles, sqliteErrorMessage: undefined })
      }
    } catch (error) {
      if (!current()) return
      const message = messageOf(error, `读取${label}失败`)
      if (hadData && getState()[errorMessage] !== message) {
        useMessageStore.getState().notify({ tone: 'danger', message: `${label}刷新失败。${message}` })
      }
      setState({ [status]: hadData ? 'ready' : 'error', [errorMessage]: message })
    } finally {
      if (pendingLoads[kind] === operation) {
        delete pendingLoads[kind]
        if (container && auth === captureAuthGeneration()) setState({ refreshing: false })
      }
    }
  })()
  return operation.promise
}

/** 数据库区的界面状态：引擎页签不进 URL、不写界面偏好——store 是模块单例，页面未关闭时记住上次引擎，重新打开面板回到第一个。 */
export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  engine: DATABASE_TAB_ENGINES[0],
  ...initialDisplay,
  clearDisplay() {
    delete pendingLoads.container
    delete pendingLoads.file
    mutations.invalidate()
    set(initialDisplay)
  },
  setEngine: (engine) => {
    set({ engine })
  },
  load(gateway) { return get().refresh(gateway) },
  /** 默认静默；手动刷新只驱动对应按钮，保留已读取的行。 */
  async refresh(gateway, showIndicator = false) {
    await Promise.all([refreshDataset(gateway, 'container', showIndicator), refreshDataset(gateway, 'file')])
  },
  refreshAfterMutation(gateway, kind) {
    return refreshDataset(gateway, kind, false, true)
  },

  openCreate(kind) {
    set({ createOpen: true, createKind: kind, createError: undefined })
  },
  closeCreate() {
    set({ createOpen: false, createError: undefined })
  },

  async createDatabase(gateway, input) {
    const current = mutations.capture()
    set({ creating: true, uploadPercent: undefined, createError: undefined })
    try {
      const { instance: created, firewallPort } = input.kind === 'file' && input.origin === 'uploaded'
        ? await gateway.databases.create(input, (percent) => {
          if (current()) set({ uploadPercent: percent })
        })
        : await gateway.databases.create(input)
      if (!current()) return
      useMessageStore
        .getState()
        .notify({ tone: 'success', message: `数据库 ${created.name} 已创建` })
      notifyFirewallPortSync(firewallPort)
      if (created.engine === 'SQLite') {
        set((state) => ({ sqliteFiles: [...state.sqliteFiles.filter((file) => file.id !== created.id), created], createOpen: false }))
      } else {
        set((state) => ({ databases: [...state.databases.filter((row) => row.id !== created.id), created], createOpen: false }))
      }
      // 创建是真实变更：立即向服务端核对列表，不用本地拼接的状态冒充服务端事实。
      void get().refreshAfterMutation(gateway, input.kind)
    } catch (error) {
      if (!current()) return
      const detail = messageOf(error)
      set({ createError: detail })
      useMessageStore.getState().notify({ tone: 'danger', message: `创建数据库失败：${detail}` })
    } finally {
      if (current()) set({ creating: false, uploadPercent: undefined })
    }
  },

  async removeContainer(gateway, containerId) {
    const row = get().databases.find((item) => item.id === containerId)
    if (!row) return
    const removingContainerIds = withBusyId(get().removingContainerIds, containerId)
    if (!removingContainerIds) return
    const current = mutations.capture()
    set({ removingContainerIds })
    try {
      const forget = row.status === 'missing' && (row.source !== 'managed' || !row.volumeName)
      if (forget) await gateway.databases.forget(containerId)
      else await gateway.databases.removeContainer(containerId)
      if (!current()) return
      useMessageStore
        .getState()
        .notify({ tone: 'success', message: forget ? `数据库容器 ${row.name} 的登记已清理` : `数据库容器 ${row.name} 已删除` })
    } catch (error) {
      if (!current()) return
      const detail = messageOf(error)
      useMessageStore.getState().notify({ tone: 'danger', message: `删除数据库容器失败：${detail}` })
    } finally {
      // 删除容器和删卷分两步；错误也可能留下待清理登记。
      if (current()) {
        await get().refreshAfterMutation(gateway, 'container')
        if (current()) set((state) => ({ removingContainerIds: withoutBusyId(state.removingContainerIds, containerId) }))
      }
    }
  },

  async removeSqliteFile(gateway, fileId) {
    const row = get().sqliteFiles.find((item) => item.id === fileId)
    if (!row) return
    const removingSqliteIds = withBusyId(get().removingSqliteIds, fileId)
    if (!removingSqliteIds) return
    const current = mutations.capture()
    set({ removingSqliteIds })
    try {
      await gateway.databases.removeSqlite(fileId)
      if (!current()) return
      useMessageStore
        .getState()
        .notify({ tone: 'success', message: `SQLite 文件 ${row.name} 已删除` })
      await get().refreshAfterMutation(gateway, 'file')
    } catch (error) {
      if (!current()) return
      const detail = messageOf(error)
      useMessageStore.getState().notify({ tone: 'danger', message: `删除 SQLite 文件失败：${detail}` })
    } finally {
      if (current()) set((state) => ({ removingSqliteIds: withoutBusyId(state.removingSqliteIds, fileId) }))
    }
  },
}))
