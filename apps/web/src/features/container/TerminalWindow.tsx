import { useCallback, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { isDockerRuntime } from '../../app/runtime/isDockerRuntime'
import { TerminalShell } from '../../components/terminal/TerminalShell'
import type { TerminalCompletion } from '../../components/terminal/terminalSession'
import {
  clampTerminalFontSize,
  TERMINAL_FONT_SIZE_DEFAULT,
} from '../../components/terminal/terminalFontSize'
import { useContainersStore } from '../../stores/containersStore'

const MOCK_BANNER = '演示终端 · 待接入真实执行'
const DOCKER_BANNER = '容器终端'

/**
 * 容器终端的薄壳：交互内核在 TerminalShell，这里只把容器域的东西接上去——
 * 会话状态来自 containersStore，命令经容器 adapter 流式下发，提示符由会话帧更新。
 */
export function TerminalWindow() {
  const gateway = useGateway()
  const terminal = useContainersStore((s) => s.terminal)
  const container = useContainersStore((s) =>
    s.containers.find((candidate) => candidate.id === s.terminal?.containerId),
  )
  const submitCommand = useContainersStore((s) => s.submitCommand)
  const interruptTerminal = useContainersStore((s) => s.interruptTerminal)
  const appendTerminalOutput = useContainersStore((s) => s.appendTerminalOutput)
  const clearTerminalScreen = useContainersStore((s) => s.clearTerminalScreen)
  const closeTerminal = useContainersStore((s) => s.closeTerminal)
  // 字号是弹窗级视图状态：与平台终端页同一口径（terminalFontSize 像素连续值），不持久化。
  const [fontSize, setFontSize] = useState(TERMINAL_FONT_SIZE_DEFAULT)
  const zoomFont = useCallback(
    (deltaPx: number) => setFontSize((prev) => clampTerminalFontSize(prev + deltaPx)),
    [],
  )

  if (!terminal || !container) return null

  const complete = (draft: string, cursor: number): TerminalCompletion => {
    if (terminal.status === 'connected') {
      return gateway.containers.completeTerminal(terminal.sessionId, draft, cursor)
    }
    return { draft, cursor }
  }

  return (
    <TerminalShell
      title={`${container.name} 终端`}
      banner={isDockerRuntime() ? DOCKER_BANNER : MOCK_BANNER}
      subject={container.name}
      prompt={terminal.prompt}
      awaitingPrompt={terminal.awaitingPrompt}
      sessionKey={terminal.sessionId}
      lines={terminal.lines}
      interactive={terminal.status === 'connected'}
      history={terminal.history}
      onSubmit={(command) => void submitCommand(gateway, command)}
      complete={complete}
      onAppendOutput={appendTerminalOutput}
      onClear={clearTerminalScreen}
      onClose={() => void closeTerminal(gateway)}
      onInterrupt={() => void interruptTerminal(gateway)}
      fontSize={fontSize}
      onFontZoom={zoomFont}
      labels={{
        input: '命令输入',
        close: '关闭终端',
        confirmTitle: '确认关闭终端？',
        confirmDescription: '会话历史将不再保留。',
        confirmCancel: '继续使用',
        confirmAccept: '确认关闭',
      }}
    />
  )
}
