import type { ElysianGateway, HostTerminalCloseInfo, HostTerminalFrame } from '../contracts/adapters'
import { hostTerminalCloseMessage } from '../terminal/terminalCloseMessage'
import { deactivateRawTerminal, disposeRawTerminal, rawTerminalRuntime } from '../terminal/rawTerminalRuntime'
import { CONTAINER_TERMINAL_CLOSE_FALLBACK } from '../utils/containerCopy'
import { captureAuthGeneration } from '../utils/authGeneration'
import { messageOf } from '../utils/errorMessage'
import { useMessageStore } from './messageStore'

export type ContainerTerminalStatus = 'connecting' | 'connected' | 'error'

export type ContainerTerminalSession = {
  containerId: string
  sessionId: string
  openId?: string
  prompt?: string
  status: ContainerTerminalStatus
  errorMessage?: string
}

type TerminalDisplay = { terminal?: ContainerTerminalSession }

export type ContainerTerminalState = TerminalDisplay & {
  openTerminal(gateway: ElysianGateway, containerId: string): Promise<void>
  closeTerminal(gateway: ElysianGateway): Promise<void>
  applyTerminalFrame(sessionId: string, frame: HostTerminalFrame): void
  handleTerminalClose(sessionId: string, info: HostTerminalCloseInfo): void
}

let pendingTerminalSeq = 1

function nextPendingTerminalId(): string {
  const id = `pending-ctr-term-${pendingTerminalSeq}`
  pendingTerminalSeq += 1
  return id
}

function releaseTerminalSession(gateway: ElysianGateway | undefined, session: ContainerTerminalSession): void {
  disposeRawTerminal(`container:${session.sessionId}`)
  if (!gateway) return
  if (session.status === 'connected') {
    void gateway.containers.disconnectTerminal(session.sessionId).catch(() => {
      // 适配层已无此会话时界面仍要关掉窗口。
    })
    return
  }
  if (session.status === 'connecting') gateway.containers.cancelTerminalConnect?.()
}

export function createContainerTerminal(
  get: () => TerminalDisplay,
  set: (update: Partial<TerminalDisplay> | ((state: TerminalDisplay) => Partial<TerminalDisplay>)) => void,
) {
  function handleTerminalClose(sessionId: string, info: HostTerminalCloseInfo): void {
    const session = get().terminal
    if (!session || session.sessionId !== sessionId || session.status === 'error') return
    deactivateRawTerminal(`container:${sessionId}`)
    const errorMessage = info.reason || hostTerminalCloseMessage(info.code, info.reason, CONTAINER_TERMINAL_CLOSE_FALLBACK)
    set({ terminal: { ...session, status: 'error', errorMessage } })
    useMessageStore.getState().notify({ tone: 'danger', message: errorMessage })
  }

  function applyTerminalFrame(sessionId: string, frame: HostTerminalFrame): void {
    if (get().terminal?.sessionId !== sessionId) return
    if (frame.type === 'output') {
      rawTerminalRuntime(`container:${sessionId}`).write(frame.data)
      return
    }
    handleTerminalClose(sessionId, { code: 1008, reason: `会话已退出（退出码 ${frame.exitCode}）` })
  }

  async function openTerminal(gateway: ElysianGateway, containerId: string): Promise<void> {
    const current = get().terminal
    if (current?.status === 'connecting') return
    if (current) releaseTerminalSession(gateway, current)
    const pendingId = nextPendingTerminalId()
    const generation = captureAuthGeneration()
    set({ terminal: { containerId, sessionId: pendingId, openId: pendingId, prompt: '$ ', status: 'connecting' } })
    const earlyFrames: Array<{ id: string; frame: HostTerminalFrame }> = []
    let accepted = false
    let earlyClose: { id: string; info: HostTerminalCloseInfo } | undefined
    try {
      const info = await gateway.containers.connectTerminal(containerId, {
        onFrame(id, frame) {
          if (get().terminal?.openId !== pendingId) return
          if (accepted) applyTerminalFrame(id, frame)
          else earlyFrames.push({ id, frame })
        },
        onClose(id, closeInfo) {
          if (get().terminal?.openId !== pendingId) return
          if (accepted) handleTerminalClose(id, closeInfo)
          else earlyClose = { id, info: closeInfo }
        },
      })
      if (generation !== captureAuthGeneration() || get().terminal?.sessionId !== pendingId) {
        await gateway.containers.disconnectTerminal(info.id).catch(() => {})
        return
      }
      if (gateway.containers.terminalMode === 'pty') rawTerminalRuntime(`container:${info.id}`).configure({
        send: data => gateway.containers.sendTerminalInput(info.id, data),
        resize: (cols, rows) => gateway.containers.resizeTerminal(info.id, cols, rows),
        acknowledge: bytes => gateway.containers.acknowledgeTerminal(info.id, bytes),
        onError: message => {
          handleTerminalClose(info.id, { code: 1006, reason: message })
          void gateway.containers.disconnectTerminal(info.id).catch(() => {})
        },
      })
      set(state => ({ terminal: state.terminal?.sessionId === pendingId ? { ...state.terminal, sessionId: info.id, prompt: info.prompt, status: 'connected' } : state.terminal }))
      accepted = true
      for (const { id, frame } of earlyFrames) applyTerminalFrame(id, frame)
      if (earlyClose) handleTerminalClose(earlyClose.id, earlyClose.info)
    } catch (error) {
      if (generation !== captureAuthGeneration() || get().terminal?.sessionId !== pendingId) return
      const errorMessage = messageOf(error, '连接容器终端失败')
      set(state => ({ terminal: state.terminal && { ...state.terminal, status: 'error', errorMessage } }))
      useMessageStore.getState().notify({ tone: 'danger', message: errorMessage })
    }
  }

  async function closeTerminal(gateway: ElysianGateway): Promise<void> {
    const session = get().terminal
    if (session) releaseTerminalSession(gateway, session)
    set({ terminal: undefined })
  }

  return {
    state: { terminal: undefined, openTerminal, closeTerminal, applyTerminalFrame, handleTerminalClose } as ContainerTerminalState,
    releaseTerminal: releaseTerminalSession,
  }
}
