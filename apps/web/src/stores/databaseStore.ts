import { create } from 'zustand'
import { DATABASE_ENGINES, type Container, type ContainerImage, type DatabaseEngine, type DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway, DatabaseCreateInput } from '../contracts/adapters'
import { pushHistory, type TerminalLine } from '../components/terminal/terminalSession'
import { useNotificationStore } from './notificationStore'
import { notifyFirewallPortSync } from './firewallPortNotice'

/** SQL 会话的界面状态：输出行与历史只存内存，关闭即清空（不伪装成持久会话）。 */
export type SqlSession = {
  databaseId: string
  lines: readonly TerminalLine[]
  history: readonly string[]
}

/** 窗口顶栏徽章的常驻标注；日志区不再重复这一行。 */
export const SESSION_BANNER = '数据库协议会话'

let liveSession: { execute(input: string): Promise<readonly string[]>; close(): void } | undefined

function asOutput(lines: readonly string[]): readonly TerminalLine[] {
  return lines.map((text): TerminalLine => ({ kind: 'output', text }))
}

export type DatabaseState = {
  engine: DatabaseEngine
  status: 'idle' | 'loading' | 'ready' | 'error'
  databases: readonly DatabaseInstance[]
  /** 卡片的来源容器行要从容器数据集现取名与镜像，因此与数据库一起取。 */
  containers: readonly Container[]
  images: readonly ContainerImage[]
  errorMessage?: string
  /** 列表刷新在途：旧卡片留在屏上，只由实例区自身盖一层浅色遮罩。 */
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
  interruptSession(gateway: ElysianGateway): void
  submitStatement(gateway: ElysianGateway, line: string): Promise<void>
  /** 终端内核的旁路输出：补全候选列表走这里追加。 */
  appendSessionOutput(lines: readonly string[]): void
  /** 终端内核的 Ctrl+L 清屏：清空日志区，标注由窗口顶栏徽章常驻。 */
  clearSessionScreen(): void
  openCreate(): void
  closeCreate(): void
  createDatabase(gateway: ElysianGateway, input: DatabaseCreateInput): Promise<void>
  removeDatabase(gateway: ElysianGateway, databaseId: string): Promise<void>
}

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
  async load(gateway) {
    set({ status: 'loading', errorMessage: undefined })
    try {
      const [databases, containers, images] = await Promise.all([
        gateway.databases.list(),
        gateway.containers.list(),
        gateway.containers.listImages(),
      ])
      set({ status: 'ready', databases, containers, images })
    } catch (error) {
      set({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : '读取数据库数据失败',
      })
    }
  },
  /**
   * 重新取回列表。默认静默——15 秒轮询与动作后的回读都走这条，不闪指示；
   * 只有用户按下刷新才传 showIndicator，让按钮转起来、卡片盖遮罩。
   */
  async refresh(gateway, showIndicator = false) {
    if (showIndicator) set({ refreshing: true })
    try {
      const [databases, containers, images] = await Promise.all([
        gateway.databases.list(), gateway.containers.list(), gateway.containers.listImages(),
      ])
      set({ databases, containers, images, refreshing: false, errorMessage: undefined })
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误'
      if (get().errorMessage !== message) {
        useNotificationStore.getState().notify({ tone: 'danger', message: `数据库状态刷新失败：${message}` })
      }
      set({ refreshing: false, errorMessage: message })
    }
  },

  openSession(databaseId, gateway) {
    liveSession?.close()
    liveSession = undefined
    // 日志区从空开始：标注由窗口顶栏徽章常驻，不在日志里重复一行。
    set({ session: { databaseId, lines: [], history: [] } })
    if (gateway?.databases.openTerminal) {
      void gateway.databases.openTerminal(databaseId).then((connection) => {
        if (get().session?.databaseId !== databaseId) { connection.close(); return }
        liveSession = connection
        get().appendSessionOutput(['已连接数据库。'])
        useNotificationStore.getState().notify({ tone: 'success', message: '已连接数据库。' })
      }).catch((error: unknown) => {
        if (get().session?.databaseId !== databaseId) return
        const message = `数据库连接失败：${error instanceof Error ? error.message : '未知错误'}`
        get().appendSessionOutput([message])
        useNotificationStore.getState().notify({ tone: 'danger', message })
      })
    }
  },
  closeSession() {
    liveSession?.close()
    liveSession = undefined
    set({ session: undefined })
  },
  interruptSession(gateway) {
    const id = get().session?.databaseId
    if (!id || !gateway.databases.openTerminal) return
    liveSession?.close()
    liveSession = undefined
    get().appendSessionOutput(['^C 执行已中断，正在重新连接…'])
    void gateway.databases.openTerminal(id).then((connection) => {
      if (get().session?.databaseId !== id) { connection.close(); return }
      liveSession = connection
      get().appendSessionOutput(['已重新连接数据库。'])
      useNotificationStore.getState().notify({ tone: 'success', message: '已重新连接数据库。' })
    }).catch((error: unknown) => {
      if (get().session?.databaseId !== id) return
      const message = `数据库重新连接失败：${error instanceof Error ? error.message : '未知错误'}`
      get().appendSessionOutput([message])
      useNotificationStore.getState().notify({ tone: 'danger', message })
    })
  },

  async submitStatement(gateway, line) {
    const session = get().session
    const statement = line.trim()
    if (!session || !statement) return

    // input 行只存裸语句：提示符由终端壳渲染时拼在行首（提示符只有一个家）。
    set({ session: { ...session, lines: [...session.lines, { kind: 'input', text: statement }] } })
    try {
      // 语句只在协议终端上执行：连接未建立（或已断开）时如实报错，不再有演示引擎回退。
      if (!liveSession) throw new Error('数据库连接尚未建立')
      const output = await liveSession.execute(statement)
      set((state) => {
        // 等待结果期间会话可能被关闭或换过实例：结果只落回同一实例的会话。
        const current = state.session
        if (!current || current.databaseId !== session.databaseId) return state
        return {
          session: { ...current, lines: [...current.lines, ...asOutput(output)], history: pushHistory(current.history, statement) },
        }
      })
      void get().refresh(gateway)
    } catch (error) {
      get().appendSessionOutput([`错误：${error instanceof Error ? error.message : '未知错误'}`])
      useNotificationStore.getState().notify({
        tone: 'danger',
        message: `数据库会话执行失败：${error instanceof Error ? error.message : '未知错误'}`,
      })
    }
  },

  appendSessionOutput(lines) {
    set((state) => ({
      session: state.session && {
        ...state.session,
        lines: [...state.session.lines, ...asOutput(lines)],
      },
    }))
  },

  clearSessionScreen() {
    set((state) => ({
      session: state.session && { ...state.session, lines: [] },
    }))
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
      useNotificationStore
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
      useNotificationStore.getState().notify({ tone: 'danger', message: `创建数据库失败：${detail}` })
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
      useNotificationStore
        .getState()
        .notify({ tone: 'success', message: database.engine === 'Redis' ? 'Redis DB 0 已清空，容器与持久卷仍保留' : `数据库 ${database.name} 已删除` })
      // 删除是真实变更：关掉关联会话并向服务端核对，列表以服务端状态为准。
      if (get().session?.databaseId === databaseId) get().closeSession()
      await get().refresh(gateway)
      set((state) => ({ removingDatabaseIds: state.removingDatabaseIds.filter((id) => id !== databaseId) }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      useNotificationStore.getState().notify({ tone: 'danger', message: `删除数据库失败：${detail}` })
      set((state) => ({
        removingDatabaseIds: state.removingDatabaseIds.filter((id) => id !== databaseId),
      }))
    }
  },
}))
