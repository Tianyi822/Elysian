import { create } from 'zustand'
import { pushHistory, type TerminalLine } from '../components/terminal/terminalSession'
import type { ElysianGateway } from '../contracts/adapters'

/** 窗口顶栏徽章与日志横幅共用的演示标注。 */
export const HOST_TERMINAL_BANNER = '演示终端 · 待接入真实执行'

const FALLBACK_USER = 'ops'
const FALLBACK_HOST = 'elysian-demo'
const FALLBACK_PROMPT = `${FALLBACK_USER}@${FALLBACK_HOST}:~$ `

export type HostTerminalStatus = 'connecting' | 'connected' | 'error'

export type HostTerminalSession = {
  id: string
  user: string
  hostLabel: string
  prompt: string
  status: HostTerminalStatus
  errorMessage?: string
  lines: readonly TerminalLine[]
  history: readonly string[]
}

export function tabLabel(
  session: Pick<HostTerminalSession, 'id' | 'user' | 'hostLabel'>,
  sessions: readonly Pick<HostTerminalSession, 'id' | 'user' | 'hostLabel'>[],
): string {
  const base = `${session.user}@${session.hostLabel}`
  const same = sessions.filter(
    (candidate) => candidate.user === session.user && candidate.hostLabel === session.hostLabel,
  )
  if (same.length <= 1) return base
  return `${base} ${same.findIndex((candidate) => candidate.id === session.id) + 1}`
}

function asOutput(lines: readonly string[]): readonly TerminalLine[] {
  return lines.map((text): TerminalLine => ({ kind: 'output', text }))
}

type TerminalsState = {
  sessions: readonly HostTerminalSession[]
  activeId?: string
  opening: boolean
  hasUserDismissed: boolean
  seedGeneration: number
  openSession: (gateway: ElysianGateway) => Promise<void>
  selectSession: (id: string) => void
  closeSession: (gateway: ElysianGateway, id: string) => Promise<void>
  reconnect: (gateway: ElysianGateway, id: string) => Promise<void>
  submitCommand: (gateway: ElysianGateway, command: string) => Promise<void>
  appendOutput: (lines: readonly string[]) => void
  clearScreen: () => void
  /** 演示数据重置：清会话，允许页面再自动开一条。 */
  resetLocal: () => void
}

let pendingSeq = 1

function nextPendingId(): string {
  const id = `pending-${pendingSeq}`
  pendingSeq += 1
  return id
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  sessions: [],
  activeId: undefined,
  opening: false,
  hasUserDismissed: false,
  seedGeneration: 0,

  resetLocal() {
    pendingSeq = 1
    set((state) => ({
      sessions: [],
      activeId: undefined,
      opening: false,
      hasUserDismissed: false,
      seedGeneration: state.seedGeneration + 1,
    }))
  },

  selectSession(id) {
    if (!get().sessions.some((session) => session.id === id)) return
    set({ activeId: id })
  },

  async openSession(gateway) {
    if (get().opening) return
    const pendingId = nextPendingId()
    set((state) => ({
      opening: true,
      hasUserDismissed: false,
      activeId: pendingId,
      sessions: [
        ...state.sessions,
        {
          id: pendingId,
          user: FALLBACK_USER,
          hostLabel: FALLBACK_HOST,
          prompt: FALLBACK_PROMPT,
          status: 'connecting',
          lines: [],
          history: [],
        },
      ],
    }))
    try {
      const info = await gateway.terminals.connect()
      set((state) => ({
        opening: false,
        activeId: state.activeId === pendingId ? info.id : state.activeId,
        sessions: state.sessions.map((session) =>
          session.id === pendingId
            ? {
                ...session,
                id: info.id,
                user: info.user,
                hostLabel: info.hostLabel,
                prompt: info.prompt,
                status: 'connected',
                errorMessage: undefined,
              }
            : session,
        ),
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接本机终端失败'
      set((state) => ({
        opening: false,
        sessions: state.sessions.map((session) =>
          session.id === pendingId
            ? { ...session, status: 'error', errorMessage: message }
            : session,
        ),
      }))
    }
  },

  async reconnect(gateway, id) {
    const current = get().sessions.find((session) => session.id === id)
    if (!current || get().opening) return
    set((state) => ({
      opening: true,
      sessions: state.sessions.map((session) =>
        session.id === id
          ? { ...session, status: 'connecting', errorMessage: undefined }
          : session,
      ),
    }))
    try {
      const info = await gateway.terminals.connect()
      set((state) => ({
        opening: false,
        activeId: state.activeId === id ? info.id : state.activeId,
        sessions: state.sessions.map((session) =>
          session.id === id
            ? {
                ...session,
                id: info.id,
                user: info.user,
                hostLabel: info.hostLabel,
                prompt: info.prompt,
                status: 'connected',
                errorMessage: undefined,
                lines: [],
                history: [],
              }
            : session,
        ),
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接本机终端失败'
      set((state) => ({
        opening: false,
        sessions: state.sessions.map((session) =>
          session.id === id ? { ...session, status: 'error', errorMessage: message } : session,
        ),
      }))
    }
  },

  async closeSession(gateway, id) {
    const current = get().sessions.find((session) => session.id === id)
    if (!current) return
    if (current.status === 'connected') {
      try {
        await gateway.terminals.disconnect(id)
      } catch {
        // 适配层已无此会话时界面仍要关掉标签。
      }
    }
    set((state) => {
      const sessions = state.sessions.filter((session) => session.id !== id)
      const activeId =
        state.activeId === id ? sessions[sessions.length - 1]?.id : state.activeId
      return {
        sessions,
        activeId,
        hasUserDismissed: sessions.length === 0,
      }
    })
  },

  async submitCommand(gateway, command) {
    const trimmed = command.trim()
    const activeId = get().activeId
    const session = get().sessions.find((candidate) => candidate.id === activeId)
    if (!session || session.status !== 'connected' || !trimmed) return

    if (trimmed === 'clear') {
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === session.id
            ? { ...candidate, lines: [], history: pushHistory(candidate.history, trimmed) }
            : candidate,
        ),
      }))
      return
    }

    set((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === session.id
          ? { ...candidate, lines: [...candidate.lines, { kind: 'input', text: trimmed }] }
          : candidate,
      ),
    }))
    try {
      const result = await gateway.terminals.execMockCommand(session.id, trimmed)
      set((state) => ({
        sessions: state.sessions.map((candidate) => {
          if (candidate.id !== session.id) return candidate
          if (result.clear) {
            return { ...candidate, lines: [], history: pushHistory(candidate.history, trimmed) }
          }
          return {
            ...candidate,
            lines: [...candidate.lines, ...asOutput(result.lines)],
            history: pushHistory(candidate.history, trimmed),
          }
        }),
      }))
    } catch (error) {
      const text = error instanceof Error ? error.message : '命令执行失败'
      set((state) => ({
        sessions: state.sessions.map((candidate) =>
          candidate.id === session.id
            ? { ...candidate, lines: [...candidate.lines, { kind: 'output', text }] }
            : candidate,
        ),
      }))
    }
  },

  appendOutput(lines) {
    const activeId = get().activeId
    if (!activeId) return
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === activeId
          ? { ...session, lines: [...session.lines, ...asOutput(lines)] }
          : session,
      ),
    }))
  },

  clearScreen() {
    const activeId = get().activeId
    if (!activeId) return
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === activeId ? { ...session, lines: [] } : session,
      ),
    }))
  },
}))
