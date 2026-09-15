import { create } from 'zustand'
import type { Container, ContainerImage, DatabaseEngine, DatabaseInstance } from '@elysian/contracts'
import type { ElysianGateway, DatabaseCreateInput } from '../contracts/adapters'
import { pushHistory, type TerminalLine } from '../components/terminal/terminalSession'
import { formatResultTable } from '../features/database/formatResultTable'
import { useNotificationStore } from './notificationStore'

/** 演示 SQL 会话：只存在内存，关闭即清空（含历史，不伪装成持久会话）。 */
export type SqlSession = {
  databaseId: string
  lines: readonly TerminalLine[]
  history: readonly string[]
}

/** 窗口顶栏徽章的常驻演示标注；日志区不再重复这一行。 */
export const SESSION_BANNER = '演示 SQL 会话 · 待接入真实执行'

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
  /** 演示 SQL 会话；同一时刻最多一个，undefined 表示没有打开。 */
  session?: SqlSession
  /** 添加数据库弹窗的开关与提交中标记。 */
  createOpen: boolean
  creating: boolean
  setEngine(engine: DatabaseEngine): void
  load(gateway: ElysianGateway): Promise<void>
  openSession(databaseId: string): void
  closeSession(): void
  submitStatement(gateway: ElysianGateway, line: string): Promise<void>
  /** 终端内核的旁路输出：补全候选列表走这里追加。 */
  appendSessionOutput(lines: readonly string[]): void
  /** 终端内核的 Ctrl+L 清屏：清空日志区，演示标注由窗口顶栏徽章常驻。 */
  clearSessionScreen(): void
  openCreate(): void
  closeCreate(): void
  createDatabase(gateway: ElysianGateway, input: DatabaseCreateInput): Promise<void>
}

/** 数据库区的界面状态：类型筛选留在内存，数据由 adapter 提供。 */
export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  engine: 'MariaDB',
  status: 'idle',
  databases: [],
  containers: [],
  images: [],
  session: undefined,
  createOpen: false,
  creating: false,
  setEngine: (engine) => set({ engine }),
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

  openSession(databaseId) {
    // 日志区从空开始：演示标注由窗口顶栏徽章常驻，不在日志里重复一行。
    set({ session: { databaseId, lines: [], history: [] } })
  },
  closeSession() {
    set({ session: undefined })
  },

  async submitStatement(gateway, line) {
    const session = get().session
    const statement = line.trim()
    if (!session || !statement) return

    // input 行只存裸语句：提示符由终端壳渲染时拼在行首（提示符只有一个家）。
    set({ session: { ...session, lines: [...session.lines, { kind: 'input', text: statement }] } })
    try {
      const result = await gateway.databases.execMockQuery(session.databaseId, statement)
      set((state) => {
        // 等待结果期间会话可能被关闭或换过实例：结果只落回同一实例的会话。
        const current = state.session
        if (!current || current.databaseId !== session.databaseId) return state
        let lines: readonly TerminalLine[]
        if (result.kind === 'clear') {
          lines = []
        } else if (result.kind === 'table') {
          lines = [
            ...current.lines,
            ...asOutput(formatResultTable(result.columns, result.rows)),
            { kind: 'output', text: result.notice },
          ]
        } else {
          lines = [...current.lines, ...asOutput(result.lines)]
        }
        return { session: { ...current, lines, history: pushHistory(current.history, statement) } }
      })
    } catch (error) {
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
    set({ createOpen: true })
  },
  closeCreate() {
    set({ createOpen: false })
  },

  async createDatabase(gateway, input) {
    set({ creating: true })
    try {
      const created = await gateway.databases.create(input)
      useNotificationStore
        .getState()
        .notify({ tone: 'success', message: `数据库 ${created.name} 已创建（mock，待接入真实执行）` })
      set((state) => ({
        databases: [...state.databases, created],
        createOpen: false,
      }))
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误'
      useNotificationStore.getState().notify({ tone: 'danger', message: `创建数据库失败：${detail}` })
    } finally {
      set({ creating: false })
    }
  },
}))
