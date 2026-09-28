import type { DatabaseInstance } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { TerminalShell } from '../../components/terminal/TerminalShell'
import type { TerminalCompletion } from '../../components/terminal/terminalSession'
import { SESSION_BANNER, useDatabaseStore } from '../../stores/databaseStore'
import { ENGINE_STATEMENTS } from './engineStatements'

/**
 * 数据库会话的薄壳：交互内核在 TerminalShell；Docker 走数据库协议终端。
 */

/**
 * 前缀补全，语义与容器终端一致：行首补语句，唯一命中补齐并补空格，
 * 多命中收敛到最长公共前缀，无法收敛时把候选列成输出行。
 * 行中不补目录名：表名与键名目录已随演示引擎移除，与真实会话行为一致（无候选）。
 */
export function completeSqlStatement(
  database: DatabaseInstance,
  draft: string,
  cursor: number,
): TerminalCompletion {
  const before = draft.slice(0, cursor)
  const token = /(\S*)$/.exec(before)?.[0] ?? ''
  const tokenStart = cursor - token.length
  const previousWord = before
    .slice(0, tokenStart)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .pop()
  const pool = previousWord ? [] : ENGINE_STATEMENTS[database.engine]
  const matches = pool.filter((candidate) => candidate.startsWith(token))

  if (matches.length === 0) return { draft, cursor }

  if (matches.length === 1) {
    const completed = `${matches[0]} `
    return {
      draft: before.slice(0, tokenStart) + completed + draft.slice(cursor),
      cursor: tokenStart + completed.length,
    }
  }

  const common = matches.reduce((acc, candidate) => {
    let i = 0
    while (i < acc.length && i < candidate.length && acc[i] === candidate[i]) i += 1
    return acc.slice(0, i)
  }, matches[0] ?? '')

  if (common.length > token.length) {
    return {
      draft: before.slice(0, tokenStart) + common + draft.slice(cursor),
      cursor: tokenStart + common.length,
    }
  }

  return { draft, cursor, candidates: matches }
}

export function SqlSessionWindow() {
  const gateway = useGateway()
  const session = useDatabaseStore((state) => state.session)
  const databases = useDatabaseStore((state) => state.databases)
  const containers = useDatabaseStore((state) => state.containers)
  const submitStatement = useDatabaseStore((state) => state.submitStatement)
  const appendSessionOutput = useDatabaseStore((state) => state.appendSessionOutput)
  const clearSessionScreen = useDatabaseStore((state) => state.clearSessionScreen)
  const closeSession = useDatabaseStore((state) => state.closeSession)
  const interruptSession = useDatabaseStore((state) => state.interruptSession)

  const database = databases.find((candidate) => candidate.id === session?.databaseId)
  if (!session || !database) return null

  // 容器缺失或与实例同名（compose 命名的常态）时主体只给实例名，不重复一遍。
  const containerName = containers.find((c) => c.id === database.containerId)?.name
  const subject =
    containerName && containerName !== database.name
      ? `${database.name} · ${containerName}`
      : database.name

  return (
    <TerminalShell
      title={`${database.name} SQL 会话`}
      banner={SESSION_BANNER}
      subject={subject}
      prompt={`${database.name}> `}
      sessionKey={session.databaseId}
      lines={session.lines}
      history={session.history}
      onSubmit={(command) => void submitStatement(gateway, command)}
      complete={(draft, cursor) => completeSqlStatement(database, draft, cursor)}
      onAppendOutput={appendSessionOutput}
      onClear={clearSessionScreen}
      onClose={closeSession}
      onInterrupt={gateway.databases.openTerminal ? () => interruptSession(gateway) : undefined}
      labels={{
        input: 'SQL 输入',
        close: '关闭会话',
        confirmTitle: '确认关闭会话？',
        confirmDescription: '未执行的语句将丢失。',
        confirmCancel: '继续使用',
        confirmAccept: '确认关闭',
      }}
    />
  )
}
