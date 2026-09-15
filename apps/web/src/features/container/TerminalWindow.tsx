import { useGateway } from '../../adapters/GatewayProvider'
import { completeTerminalCommand } from '../../adapters/mock/containerTerminal'
import { TerminalShell } from '../../components/terminal/TerminalShell'
import { useContainersStore } from '../../stores/containersStore'

/**
 * 容器终端的薄壳：交互内核在 TerminalShell，这里只把容器域的东西接上去——
 * 会话状态来自 containersStore，命令引擎走 mock 适配层，提示符固定 `$ `。
 */
export function TerminalWindow() {
  const gateway = useGateway()
  const terminal = useContainersStore((s) => s.terminal)
  const container = useContainersStore((s) =>
    s.containers.find((candidate) => candidate.id === s.terminal?.containerId),
  )
  const submitCommand = useContainersStore((s) => s.submitCommand)
  const appendTerminalOutput = useContainersStore((s) => s.appendTerminalOutput)
  const clearTerminalScreen = useContainersStore((s) => s.clearTerminalScreen)
  const closeTerminal = useContainersStore((s) => s.closeTerminal)

  if (!terminal || !container) return null

  return (
    <TerminalShell
      title={`${container.name} 终端`}
      banner="演示终端 · 待接入真实执行"
      subject={container.name}
      prompt="$ "
      sessionKey={terminal.containerId}
      lines={terminal.lines}
      history={terminal.history}
      onSubmit={(command) => void submitCommand(gateway, command)}
      complete={completeTerminalCommand}
      onAppendOutput={appendTerminalOutput}
      onClear={clearTerminalScreen}
      onClose={closeTerminal}
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
