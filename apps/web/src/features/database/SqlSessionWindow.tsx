import { useGateway } from '../../adapters/GatewayProvider'
import { TerminalShell } from '../../components/terminal/TerminalShell'
import { CommandTerminal } from '../../components/terminal/CommandTerminal'
import { SESSION_BANNER, useDatabaseStore } from '../../stores/databaseStore'
import { ENGINE_STATEMENTS } from './engineStatements'

export function SqlSessionWindow() {
  const gateway = useGateway()
  const session = useDatabaseStore((state) => state.session)
  const databases = useDatabaseStore((state) => state.databases)
  const containers = useDatabaseStore((state) => state.containers)
  const closeSession = useDatabaseStore((state) => state.closeSession)
  const database = databases.find((candidate) => candidate.id === session?.databaseId)
  if (!session || !database) return null
  const containerName = containers.find((container) => container.id === database.containerId)?.name
  const subject = containerName && containerName !== database.name ? `${database.name} · ${containerName}` : database.name
  return <TerminalShell title={`${database.name} SQL 会话`} banner={SESSION_BANNER} subject={subject}
    onClose={closeSession} interactive={session.status === 'connected'}
    labels={{ close: '关闭会话', confirmTitle: '确认关闭会话？', confirmDescription: '未执行的语句将丢失。', confirmCancel: '继续使用', confirmAccept: '确认关闭' }}>
    {session.status === 'connecting' && <p role="status" className="px-3 pt-3 text-xs text-fg-muted">正在连接数据库…</p>}
    {session.errorMessage && <p role="alert" className="px-3 pt-3 text-xs text-danger">{session.errorMessage}<button type="button" className="ml-2 underline" onClick={() => void useDatabaseStore.getState().interruptSession(gateway)}>重新连接</button></p>}
    <CommandTerminal sessionKey={session.id} prompt={`${database.name}> `} inputLabel="SQL 输入"
      interactive={session.status === 'connected'} completions={ENGINE_STATEMENTS[database.engine]}
      execute={(statement) => useDatabaseStore.getState().submitStatement(gateway, statement)}
      onInterrupt={() => useDatabaseStore.getState().interruptSession(gateway)} />
  </TerminalShell>
}
