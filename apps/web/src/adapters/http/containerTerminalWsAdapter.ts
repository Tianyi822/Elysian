import { createRawTerminalTransport, type TerminalSocketFactory } from './terminalWsAdapter'

/** 容器与本机使用同一原始 PTY 协议；这里只选择目标和中文错误。 */
export function createContainerTerminalWsAdapter(socketFactory?: TerminalSocketFactory) {
  const transport = createRawTerminalTransport({
    path: target => `/api/docker/containers/${encodeURIComponent(target ?? '')}/terminal`,
    statusPath: '/api/docker/status', fallback: '连接容器终端失败', socketFactory,
  })
  return {
    terminalMode: 'pty' as const,
    connectTerminal: (containerId: string, handlers: Parameters<typeof transport.connect>[0]) => transport.connect(handlers, containerId),
    sendTerminalInput: transport.sendInput,
    resizeTerminal: transport.resize,
    acknowledgeTerminal: transport.acknowledge,
    disconnectTerminal: transport.disconnect,
    cancelTerminalConnect: transport.cancelConnect,
    reset: transport.reset,
  }
}
