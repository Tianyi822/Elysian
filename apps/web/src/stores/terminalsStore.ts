import { create } from 'zustand'
import { useMessageStore } from './messageStore'
import { isDockerRuntime } from '../app/runtime/isDockerRuntime'
import { hostTerminalCloseMessage } from '../components/terminal/terminalCloseMessage'
import { deactivateRawTerminal, disposeRawTerminal, rawTerminalRuntime } from '../components/terminal/rawTerminalRuntime'
import { captureAuthGeneration } from '../adapters/http/unauthorized'
import type { ElysianGateway, HostTerminalCloseInfo, HostTerminalFrame, HostTerminalSessionInfo } from '../contracts/adapters'

export function hostTerminalBanner(): string { return isDockerRuntime() ? '本机终端' : '演示终端 · 待接入真实执行' }
export function hostTerminalEmptyDescription(): string { return isDockerRuntime() ? '新建一条本机终端会话，命令在真实 Shell 中执行。' : '新建一条本机演示终端。命令在浏览器内求值。' }
export type HostTerminalStatus = 'connecting' | 'connected' | 'error'
export type HostTerminalSession = HostTerminalSessionInfo & { status: HostTerminalStatus; errorMessage?: string }
export function tabLabel(session: Pick<HostTerminalSession, 'id' | 'user' | 'hostLabel'>, sessions: readonly Pick<HostTerminalSession, 'id' | 'user' | 'hostLabel'>[]): string {
  const base = `${session.user}@${session.hostLabel}`
  const same = sessions.filter(candidate => candidate.user === session.user && candidate.hostLabel === session.hostLabel)
  return same.length <= 1 ? base : `${base} ${same.findIndex(candidate => candidate.id === session.id) + 1}`
}
const runtimeKey = (id: string) => `host:${id}`
let nextId = 1
let activeGateway: ElysianGateway | undefined
let revision = 0

type State = {
  sessions: readonly HostTerminalSession[]
  activeId?: string
  opening: boolean
  hasUserDismissed: boolean
  seedGeneration: number
  openSession(gateway: ElysianGateway): Promise<void>
  selectSession(id: string): void
  closeSession(gateway: ElysianGateway, id: string): Promise<void>
  reconnect(gateway: ElysianGateway, id: string): Promise<void>
  applyFrame(id: string, frame: HostTerminalFrame): void
  handleClose(id: string, info: HostTerminalCloseInfo): void
  resetLocal(): void
}
export const useTerminalsStore = create<State>((set, get) => ({
  sessions: [], opening: false, hasUserDismissed: false, seedGeneration: 0,
  resetLocal() {
    revision++
    for (const session of get().sessions) {
      disposeRawTerminal(runtimeKey(session.id))
      if (session.status !== 'connecting') void activeGateway?.terminals.disconnect(session.id).catch(() => {})
    }
    activeGateway?.terminals.cancelConnect?.()
    set(state => ({ sessions: [], activeId: undefined, opening: false, hasUserDismissed: false, seedGeneration: state.seedGeneration + 1 }))
  },
  selectSession(id) { if (get().sessions.some(session => session.id === id)) set({ activeId: id }) },
  async openSession(gateway) {
    if (get().opening) return
    activeGateway = gateway
    const pendingId = `pending-${nextId++}`
    const generation = captureAuthGeneration()
    const operation = revision
    set(state => ({ opening: true, hasUserDismissed: false, activeId: pendingId, sessions: [...state.sessions, { id: pendingId, user: 'ops', hostLabel: 'elysian-demo', status: 'connecting' }] }))
    let earlyFrames: Array<{ id: string; frame: HostTerminalFrame }> = []
    let accepted = false
    let earlyClose: { id: string; info: HostTerminalCloseInfo } | undefined
    try {
      const info = await gateway.terminals.connect({
        onFrame(id, frame) { if (accepted) get().applyFrame(id, frame); else earlyFrames.push({ id, frame }) },
        onClose(id, info) { if (accepted) get().handleClose(id, info); else earlyClose = { id, info } },
      })
      if (operation !== revision || generation !== captureAuthGeneration() || !get().sessions.some(session => session.id === pendingId)) {
        await gateway.terminals.disconnect(info.id).catch(() => {}); return
      }
      if (gateway.terminals.mode === 'pty') rawTerminalRuntime(runtimeKey(info.id)).configure({
        send: data => gateway.terminals.sendInput(info.id, data),
        resize: (cols, rows) => gateway.terminals.resize(info.id, cols, rows),
        acknowledge: bytes => gateway.terminals.acknowledge(info.id, bytes),
        onError: errorMessage => { get().handleClose(info.id, { code: 1006, reason: errorMessage }); void gateway.terminals.disconnect(info.id).catch(() => {}) },
      })
      set(state => ({ opening: false, activeId: state.activeId === pendingId ? info.id : state.activeId, sessions: state.sessions.map(session => session.id === pendingId ? { ...info, status: 'connected' } : session) }))
      accepted = true
      for (const { id, frame } of earlyFrames) get().applyFrame(id, frame)
      earlyFrames = []
      if (earlyClose) get().handleClose(earlyClose.id, earlyClose.info)
    } catch (error) {
      if (operation !== revision || generation !== captureAuthGeneration() || !get().sessions.some(session => session.id === pendingId)) return
      const errorMessage = error instanceof Error ? error.message : '连接本机终端失败'
      set(state => ({ opening: false, sessions: state.sessions.map(session => session.id === pendingId ? { ...session, status: 'error', errorMessage } : session) }))
      useMessageStore.getState().notify({ tone: 'danger', message: `本机终端连接失败：${errorMessage}` })
    }
  },
  async closeSession(gateway, id) {
    const session = get().sessions.find(candidate => candidate.id === id)
    if (!session) return
    if (session.status === 'connecting') gateway.terminals.cancelConnect?.()
    else await gateway.terminals.disconnect(id).catch(() => {})
    disposeRawTerminal(runtimeKey(id))
    set(state => {
      const sessions = state.sessions.filter(candidate => candidate.id !== id)
      return { sessions, activeId: state.activeId === id ? sessions.at(-1)?.id : state.activeId, hasUserDismissed: sessions.length === 0, opening: sessions.some(candidate => candidate.status === 'connecting') }
    })
  },
  async reconnect(gateway, id) { await get().closeSession(gateway, id); await get().openSession(gateway) },
  applyFrame(id, frame) {
    if (!get().sessions.some(session => session.id === id)) return
    if (frame.type === 'output') { rawTerminalRuntime(runtimeKey(id)).write(frame.data); return }
    get().handleClose(id, { code: 1008, reason: `会话已退出（退出码 ${frame.exitCode}）` })
  },
  handleClose(id, info) {
    const current = get().sessions.find(session => session.id === id)
    if (!current || current.status === 'error') return
    deactivateRawTerminal(runtimeKey(id))
    const errorMessage = info.reason || hostTerminalCloseMessage(info.code, info.reason)
    set(state => ({ sessions: state.sessions.map(session => session.id === id ? { ...session, status: 'error', errorMessage } : session) }))
    useMessageStore.getState().notify({ tone: 'danger', message: `本机终端：${errorMessage}` })
  },
}))
