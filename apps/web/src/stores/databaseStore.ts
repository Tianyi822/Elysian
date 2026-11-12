import { captureAuthGeneration } from '../adapters/http/unauthorized'
import { create } from 'zustand'
import { DATABASE_ENGINES, type Container, type ContainerImage, type DatabaseEngine, type DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway, DatabaseCreateInput } from '../contracts/adapters'
import { useMessageStore } from './messageStore'
import { notifyFirewallPortSync } from './firewallPortNotice'

/** 命令编辑、历史与显示由第三方终端持有，store 只保存连接身份与状态。 */
export type SqlSession = {
  id: string
  databaseId: string
  status: 'connecting' | 'connected' | 'error'
  errorMessage?: string
}

export const SESSION_BANNER = '数据库协议会话'
let sessionSequence = 0
let connectionGeneration = 0
let liveSession: { execute(input: string): Promise<readonly string[]>; close(): void } | undefined

export type DatabaseState = {
  engine: DatabaseEngine
  status: 'idle' | 'loading' | 'ready' | 'error'
  databases: readonly DatabaseInstance[]
  /** 卡片的来源容器行要从容器数据集现取名与镜像，因此与数据库一起取。 */
  containers: readonly Container[]
  images: readonly ContainerImage[]
  errorMessage?: string
  /** 列表手动刷新在途：仅驱动对应刷新按钮。 */
  refreshing: boolean
  /** SQL 会话；同一时刻最多一个，undefined 表示没有打开。 */
  session?: SqlSession
  /** 添加数据库弹窗的开关与提交中标记。 */
  createOpen: boolean
  creating: boolean
  createError?: string
  uploadPercent?: number
  /** 正在执行删除的数据库 id：卡片动作行据此禁用。 */
  removingDatabaseIds: readonly string[]
  setEngine(engine: DatabaseEngine): void
  load(gateway: ElysianGateway): Promise<void>
  refresh(gateway: ElysianGateway, showIndicator?: boolean): Promise<void>
  openSession(databaseId: string, gateway?: ElysianGateway): void
  closeSession(): void
  interruptSession(gateway: ElysianGateway): Promise<void>
  submitStatement(gateway: ElysianGateway, line: string): Promise<readonly string[]>
  openCreate(): void
  closeCreate(): void
  createDatabase(gateway: ElysianGateway, input: DatabaseCreateInput): Promise<void>
  removeDatabase(gateway: ElysianGateway, databaseId: string): Promise<void>
}

let pendingLoad: { gateway: ElysianGateway; auth: number; snapshot: readonly DatabaseInstance[]; promise: Promise<void> } | undefined

/** 数据库区的界面状态：类型筛选不进 URL、不写界面偏好——store 是模块单例，页面未关闭时记住上次类型，重新打开面板回到第一个。 */
export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  engine: DATABASE_ENGINES[0],
  status: 'idle',
  databases: [],
  containers: [],
  images: [],
  refreshing: false,
  session: undefined,
  createOpen: false,
  creating: false,
  createError: undefined,
  uploadPercent: undefined,
  removingDatabaseIds: [],
  setEngine: (engine) => {
    set({ engine })
  },
  load(gateway) { return get().refresh(gateway) },
  /** 默认静默；手动刷新只驱动对应按钮，保留已读取的实例和会话。 */
  refresh(gateway, showIndicator = false) {
    const auth = captureAuthGeneration()
    if (pendingLoad?.gateway === gateway && pendingLoad.auth === auth && pendingLoad.snapshot === get().databases) {
      if (showIndicator) set({ refreshing: true })
      return pendingLoad.promise
    }
    const hadData = get().status === 'ready'
    const operation = { gateway, auth, snapshot: get().databases, promise: Promise.resolve() }
    pendingLoad = operation
    const current = () => pendingLoad === operation && auth === captureAuthGeneration()
    set({ status: hadData ? 'ready' : 'loading', refreshing: showIndicator, ...(!hadData ? { errorMessage: undefined } : {}) })
    operation.promise = (async () => {
      try {
        const [databases, containers, images] = await Promise.all([
          gateway.databases.list(), gateway.containers.list(), gateway.containers.listImages(),
        ])
        if (current() && operation.snapshot === get().databases) set({ status: 'ready', databases, containers, images, errorMessage: undefined })
      } catch (error) {
        if (!current()) return
        const message = error instanceof Error ? error.message : '读取数据库数据失败'
        if (hadData && get().errorMessage !== message) useMessageStore.getState().notify({ tone: 'danger', message: `数据库状态刷新失败：${message}` })
        set({ status: hadData ? 'ready' : 'error', errorMessage: message })
      } finally {
        if (pendingLoad === operation) {
          pendingLoad = undefined
          if (auth === captureAuthGeneration()) set({ refreshing: false })
        }
      }
    })()
    return operation.promise
  },

  openSession(databaseId, gateway) {
    connectionGeneration += 1
    const generation = connectionGeneration
    liveSession?.close()
    liveSession = undefined
    const id = `database-session-${++sessionSequence}`
    set({ session: { id, databaseId, status: 'connecting' } })
    if (!gateway?.databases.openTerminal) {
      set({ session: { id, databaseId, status: 'error', errorMessage: '数据库协议终端不可用' } })
      return
    }
    void gateway.databases.openTerminal(databaseId).then((connection) => {
      if (generation !== connectionGeneration || get().session?.id !== id) { connection.close(); return }
      liveSession = connection
      set({ session: { id, databaseId, status: 'connected' } })
    }).catch((error: unknown) => {
      if (generation !== connectionGeneration || get().session?.id !== id) return
      const errorMessage = `数据库连接失败：${error instanceof Error ? error.message : '未知错误'}`
      set({ session: { id, databaseId, status: 'error', errorMessage } })
    })
  },
  closeSession() {
    connectionGeneration += 1
    liveSession?.close()
    liveSession = undefined
    set({ session: undefined })
  },
  async interruptSession(gateway) {
    const session = get().session
    if (!session || !gateway.databases.openTerminal) return
    const generation = ++connectionGeneration
    liveSession?.close()
    liveSession = undefined
    set({ session: { ...session, status: 'connecting', errorMessage: undefined } })
    try {
      const connection = await gateway.databases.openTerminal(session.databaseId)
      if (generation !== connectionGeneration || get().session?.id !== session.id) { connection.close(); return }
      liveSession = connection
      set({ session: { ...session, status: 'connected', errorMessage: undefined } })
    } catch (error) {
      if (generation !== connectionGeneration || get().session?.id !== session.id) return
      const errorMessage = `数据库重新连接失败：${error instanceof Error ? error.message : '未知错误'}`
      set({ session: { ...session, status: 'error', errorMessage } })
    }
  },

  async submitStatement(gateway, statement) {
    const session = get().session
    const connection = liveSession
    const generation = connectionGeneration
    if (!session || session.status !== 'connected' || !connection) throw new Error('数据库连接尚未建立')
    if (!statement.trim()) return []
    try {
      const output = await connection.execute(statement)
      if (generation !== connectionGeneration || get().session?.id !== session.id || connection !== liveSession) {
        throw new DOMException('数据库会话已变更', 'AbortError')
      }
      void get().refresh(gateway)
      return output
    } catch (error) {
      if (generation !== connectionGeneration || get().session?.id !== session.id || connection !== liveSession) {
        throw new DOMException('数据库会话已变更', 'AbortError')
      }
      throw error
    }
  },

  openCreate() {
    set({ createOpen: true, createError: undefined })
  },
  closeCreate() {
    set({ createOpen: false, createError: undefined })
  },

  async createDatabase(gateway, input) {
    set({ creating: true, uploadPercent: undefined, createError: undefined })
    try {
      const { instance: created, firewallPort } = input.kind === 'file' && input.origin === 'uploaded'
        ? await gateway.databases.create(input, (percent) => set({ uploadPercent: percent }))
        : await gateway.databases.create(input)
      useMessageStore
        .getState()
        .notify({ tone: 'success', message: `数据库 ${created.name} 已创建` })
      notifyFirewallPortSync(firewallPort)
      set((state) => ({
        databases: [...state.databases, created],
        createOpen: false,
      }))
      // 创建是真实变更：立即向服务端核对列表，不用本地拼接的状态冒充服务端事实。
      void get().refresh(gateway)
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      set({ createError: detail })
      useMessageStore.getState().notify({ tone: 'danger', message: `创建数据库失败：${detail}` })
    } finally {
      set({ creating: false, uploadPercent: undefined })
    }
  },

  async removeDatabase(gateway, databaseId) {
    const database = get().databases.find((item) => item.id === databaseId)
    if (!database) return
    if (get().removingDatabaseIds.includes(databaseId)) return
    set((state) => ({ removingDatabaseIds: [...state.removingDatabaseIds, databaseId] }))
    try {
      await gateway.databases.remove(databaseId)
      useMessageStore
        .getState()
        .notify({ tone: 'success', message: database.engine === 'Redis' ? 'Redis DB 0 已清空，容器与持久卷仍保留' : `数据库 ${database.name} 已删除` })
      // 删除是真实变更：关掉关联会话并向服务端核对，列表以服务端状态为准。
      if (get().session?.databaseId === databaseId) get().closeSession()
      await get().refresh(gateway)
      set((state) => ({ removingDatabaseIds: state.removingDatabaseIds.filter((id) => id !== databaseId) }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      useMessageStore.getState().notify({ tone: 'danger', message: `删除数据库失败：${detail}` })
      set((state) => ({
        removingDatabaseIds: state.removingDatabaseIds.filter((id) => id !== databaseId),
      }))
    }
  },
}))
