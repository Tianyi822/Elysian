import { create } from 'zustand'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import {
  hostTerminalCloseMessage,
  pushHistory,
  type TerminalLine,
} from '../components/terminal/terminalSession'
import type {
  ElysianGateway,
  HostTerminalCloseInfo,
  HostTerminalFrame,
  HostTerminalHandlers,
} from '../contracts/adapters'

/** 窗口顶栏徽章与日志横幅共用的标注：仅 mock 运行时标注演示（对齐 MOCK_NOTE 先例），Docker 运行时是真实本机终端。 */
export function hostTerminalBanner(): string {
  return isDockerRuntime() ? '本机终端' : '演示终端 · 待接入真实执行'
}

/** 全部关闭后的空态说明：mock 说明演示求值，Docker 说明真实 Shell 语义。 */
export function hostTerminalEmptyDescription(): string {
  return isDockerRuntime()
    ? '新建一条本机终端会话，命令在容器内的真实 Shell 中执行。'
    : '新建一条本机演示终端。命令在浏览器内求值，待接入真实执行。'
}

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
  /** Ctrl+C：本地外观由视口内核负责，这里把 interrupt 帧发到适配层（真实 PTY 写 \x03，mock no-op）。 */
  interruptCommand: (gateway: ElysianGateway) => Promise<void>
  /** 适配层下行帧的落点：output/truncated 追加到该会话，prompt 更新提示符，exit 置错误态。 */
  applyFrame: (sessionId: string, frame: HostTerminalFrame) => void
  /** 连接关闭（含 4000 空闲超时、1008 拒绝、1006 中断）按关闭码映射中文错误态。 */
  handleClose: (sessionId: string, info: HostTerminalCloseInfo) => void
  /** 把行追加到指定会话：后台标签的流式输出也落在自己的标签里。 */
  appendSessionOutput: (sessionId: string, lines: readonly string[]) => void
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
      const info = await gateway.terminals.connect(terminalHandlers)
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
      const info = await gateway.terminals.connect(terminalHandlers)
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

    // 回显与历史在提交时落定（流式模型没有同步的「执行成功」回执）；输出由 output 帧异步追加。
    set((state) => ({
      sessions: state.sessions.map((candidate) =>
        candidate.id === session.id
          ? {
              ...candidate,
              lines: [...candidate.lines, { kind: 'input', text: trimmed }],
              history: pushHistory(candidate.history, trimmed),
            }
          : candidate,
      ),
    }))
    try {
      await gateway.terminals.sendInput(session.id, trimmed)
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

  async interruptCommand(gateway) {
    const activeId = get().activeId
    const session = get().sessions.find((candidate) => candidate.id === activeId)
    if (!session || session.status !== 'connected') return
    try {
      await gateway.terminals.interrupt(session.id)
    } catch {
      // 会话已断开时错误态由关闭路径接管；本地 ^C 外观已经落定。
    }
  },

  applyFrame(sessionId, frame) {
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session
        switch (frame.type) {
          case 'output':
            return { ...session, lines: [...session.lines, ...asOutput(frame.lines)] }
          case 'prompt':
            return { ...session, prompt: frame.prompt }
          case 'truncated':
            return {
              ...session,
              lines: [
                ...session.lines,
                { kind: 'output', text: `输出超出单轮上限，已丢弃 ${frame.droppedBytes} 字节` },
              ],
            }
          case 'exit':
            return {
              ...session,
              status: 'error',
              errorMessage: `会话已退出（退出码 ${frame.exitCode}）`,
            }
        }
      }),
    }))
  },

  handleClose(sessionId, info) {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId && session.status !== 'error'
          ? {
              ...session,
              status: 'error',
              errorMessage: hostTerminalCloseMessage(info.code, info.reason),
            }
          : session,
      ),
    }))
  },

  appendSessionOutput(sessionId, lines) {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === sessionId
          ? { ...session, lines: [...session.lines, ...asOutput(lines)] }
          : session,
      ),
    }))
  },

  appendOutput(lines) {
    const activeId = get().activeId
    if (!activeId) return
    get().appendSessionOutput(activeId, lines)
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

/**
 * 流式回调的唯一注册点：所有会话共用同一对处理器，帧与关闭事件按 sessionId
 * 路由回 store。在 store 创建之后定义（引用 useTerminalsStore），connect 时才求值。
 */
const terminalHandlers: HostTerminalHandlers = {
  onFrame: (sessionId, frame) => {
    useTerminalsStore.getState().applyFrame(sessionId, frame)
  },
  onClose: (sessionId, info) => {
    useTerminalsStore.getState().handleClose(sessionId, info)
  },
}
