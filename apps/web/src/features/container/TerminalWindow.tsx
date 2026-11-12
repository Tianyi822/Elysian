import { useCallback, useState } from 'react'
import { useGateway } from '../../adapters/GatewayProvider'
import { TerminalShell } from '../../components/terminal/TerminalShell'
import { CommandTerminal } from '../../components/terminal/CommandTerminal'
import { RawTerminalViewport } from '../../components/terminal/RawTerminalViewport'
import { clampTerminalFontSize, TERMINAL_FONT_SIZE_DEFAULT } from '../../components/terminal/terminalFontSize'
import { useContainersStore } from '../../stores/containersStore'

export function TerminalWindow() {
  const gateway = useGateway()
  const terminal = useContainersStore(state => state.terminal)
  const container = useContainersStore(state => state.containers.find(candidate => candidate.id === state.terminal?.containerId))
  const closeTerminal = useContainersStore(state => state.closeTerminal)
  const [fontSize, setFontSize] = useState(TERMINAL_FONT_SIZE_DEFAULT)
  const zoom = useCallback((delta: number) => setFontSize(size => clampTerminalFontSize(size + delta)), [])
  if (!terminal || !container) return null
  const real = gateway.containers.terminalMode === 'pty'
  return <TerminalShell title={`${container.name} 终端`} banner={real ? '容器终端' : '演示终端 · 待接入真实执行'} subject={container.name} onClose={() => void closeTerminal(gateway)} interactive={terminal.status === 'connected'} labels={{ close: '关闭终端', confirmTitle: '确认关闭终端？', confirmDescription: '会话历史将不再保留。', confirmCancel: '继续使用', confirmAccept: '确认关闭' }}>
    {terminal.status === 'connecting' && <p role="status" className="p-4 text-sm text-fg-muted">正在连接容器终端…</p>}
    {terminal.errorMessage && <p role="alert" className="px-4 py-2 text-xs text-danger">{terminal.errorMessage}</p>}
    {terminal.status !== 'connecting' && (real
      ? <RawTerminalViewport sessionKey={`container:${terminal.sessionId}`} interactive={terminal.status === 'connected'} fontSize={fontSize} onFontZoom={zoom} />
      : <CommandTerminal sessionKey={`container:${terminal.sessionId}`} prompt={terminal.prompt ?? '$ '} interactive={terminal.status === 'connected'} fontSize={fontSize} onFontZoom={zoom} inputLabel="命令输入" execute={command => gateway.containers.executeTerminalCommand!(terminal.sessionId, command)} completions={input => gateway.containers.terminalCompletions?.(terminal.sessionId, input) ?? []} />)}
  </TerminalShell>
}
