import type { DatabaseInstance } from '@elysian/contracts'
import { useGateway } from '../../adapters/GatewayProvider'
import { DATABASE_CATALOG } from '../../adapters/mock/databaseCatalog'
import { ENGINE_STATEMENTS } from '../../adapters/mock/databaseQuery'
import { TerminalShell } from '../../components/terminal/TerminalShell'
import type { TerminalCompletion } from '../../components/terminal/terminalSession'
import { SESSION_BANNER, useDatabaseStore } from '../../stores/databaseStore'

/**
 * 数据库演示会话的薄壳：交互内核在 TerminalShell，这里只接数据库域的东西——
 * 会话状态来自 databaseStore，语句引擎走 mock 适配层，提示符为实例名，
 * 演示标注由顶栏徽章常驻，日志区不重复一行。
 */

/** Tab 补全的行中词表：演示目录里的表名（SQL）或键名（Redis）。 */
function completionNames(database: DatabaseInstance): readonly string[] {
  const catalog = DATABASE_CATALOG[database.id]
  if (!catalog) return []
  return database.engine === 'Redis'
    ? catalog.keys.map((key) => key.name)
    : catalog.tables.map((table) => table.name)
}

/**
 * 前缀补全，语义与容器终端一致：行首补语句、行中补目录名；
 * 唯一命中补齐并补空格，多命中收敛到最长公共前缀，无法收敛时把候选列成输出行。
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
  const pool = previousWord ? completionNames(database) : ENGINE_STATEMENTS[database.engine]
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
