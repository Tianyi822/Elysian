import type { DatabaseEngine, DatabaseInstance } from '@elysian/contracts'
import type { MockQueryResult } from '../../contracts/adapters'
import { DATABASE_CATALOG } from './databaseCatalog'
import type { CatalogTable, DatabaseCatalog } from './databaseCatalog'

/**
 * 演示会话的语句引擎：纯函数、确定性输出、无 IO、不引入随机。
 * 所有行、列都从 `DATABASE_CATALOG[database.id]` 取，连接数取实例自身
 * 的 `connections.active`（与卡片同源）；未知语句与缺表如实说明。
 *
 * 归一化策略（对全部引擎一致）：去首尾空白、连续空白压成单个空格、
 * 去掉结尾一个分号；关键字与表名、键名一律按小写比较。
 */

/** SQL 引擎共用的语句清单，供 help 输出与后续 Tab 补全共用一处。 */
const SQL_STATEMENTS = [
  'help',
  'SHOW TABLES',
  'DESCRIBE',
  'SELECT * FROM',
  'SELECT COUNT(*) FROM',
  "SHOW STATUS LIKE 'Threads_connected'",
  'clear',
] as const

/**
 * SQLite 的语句集：SQLite 的 SQL 方言里没有 SHOW 系列——
 * 表清单查 sqlite_master，文件事实查 PRAGMA，版本查 sqlite_version()。
 */
const SQLITE_STATEMENTS = [
  'help',
  "SELECT name FROM sqlite_master WHERE type='table'",
  'PRAGMA page_size',
  'PRAGMA journal_mode',
  'SELECT sqlite_version()',
  'SELECT * FROM',
  'SELECT COUNT(*) FROM',
  'clear',
] as const

/** 各引擎可用的语句，供 help 与 Tab 补全共用一处。 */
export const ENGINE_STATEMENTS: Record<DatabaseEngine, readonly string[]> = {
  MariaDB: SQL_STATEMENTS,
  MySQL: SQL_STATEMENTS,
  Redis: ['help', 'KEYS *', 'TYPE', 'GET', 'INFO clients', 'clear'],
  SQLite: SQLITE_STATEMENTS,
}

const SQL_ENGINES: readonly DatabaseEngine[] = ['MariaDB', 'MySQL']

const UNKNOWN_LINES = ['演示会话：该语句不在演示集内，输入 help 查看可用语句']

/** 结果集行数的口径与 mysql 客户端一致：1 行用单数，0 行是 Empty set。 */
function rowsInSet(count: number): string {
  if (count === 0) return 'Empty set'
  return `${count} row${count === 1 ? '' : 's'} in set`
}

function catalogOf(database: DatabaseInstance): DatabaseCatalog {
  return DATABASE_CATALOG[database.id] ?? { engine: database.engine, tables: [], keys: [] }
}

function findTable(catalog: DatabaseCatalog, name: string): CatalogTable | undefined {
  return catalog.tables.find((table) => table.name.toLowerCase() === name.toLowerCase())
}

function missingTable(name: string): MockQueryResult {
  return { kind: 'text', lines: [`演示会话：目录里没有表 ${name}`] }
}

function runSqlQuery(database: DatabaseInstance, statement: string): MockQueryResult {
  const catalog = catalogOf(database)

  if (/^show\s+tables$/i.test(statement)) {
    const rows = catalog.tables.map((table) => [table.name] as const)
    return {
      kind: 'table',
      columns: [`Tables_in_${database.name}`],
      rows,
      notice: rowsInSet(rows.length),
    }
  }

  const describe = /^describe\s+(\S+)$/i.exec(statement)
  if (describe) {
    const table = findTable(catalog, describe[1]!)
    if (!table) return missingTable(describe[1]!)
    const rows = table.columns.map((column) => [column] as const)
    return { kind: 'table', columns: ['Field'], rows, notice: rowsInSet(rows.length) }
  }

  const showStatus = /^show\s+status\s+like\s+['"]threads_connected['"]$/i.exec(statement)
  if (showStatus) {
    return {
      kind: 'table',
      columns: ['Variable_name', 'Value'],
      rows: [['Threads_connected', String(database.connections?.active)] as const],
      notice: rowsInSet(1),
    }
  }

  const count = /^select\s+count\(\*\)\s+from\s+(\S+)$/i.exec(statement)
  if (count) {
    const table = findTable(catalog, count[1]!)
    if (!table) return missingTable(count[1]!)
    return {
      kind: 'table',
      columns: ['COUNT(*)'],
      rows: [[String(table.rows.length)] as const],
      notice: rowsInSet(1),
    }
  }

  const selectAll = /^select\s+\*\s+from\s+(\S+)(?:\s+limit\s+(\d+))?$/i.exec(statement)
  if (selectAll) {
    const table = findTable(catalog, selectAll[1]!)
    if (!table) return missingTable(selectAll[1]!)
    const limit = selectAll[2] ? Number.parseInt(selectAll[2]!, 10) : undefined
    const rows = limit === undefined ? table.rows : table.rows.slice(0, limit)
    return { kind: 'table', columns: table.columns, rows, notice: rowsInSet(rows.length) }
  }

  return { kind: 'text', lines: UNKNOWN_LINES }
}

function runRedisQuery(database: DatabaseInstance, statement: string): MockQueryResult {
  const catalog = catalogOf(database)

  if (/^keys\s+\*$/i.test(statement)) {
    const rows = catalog.keys.map((key) => [key.name] as const)
    return { kind: 'table', columns: ['key'], rows, notice: rowsInSet(rows.length) }
  }

  if (/^info\s+clients$/i.test(statement)) {
    return {
      kind: 'table',
      columns: ['Variable_name', 'Value'],
      rows: [['connected_clients', String(database.connections?.active)] as const],
      notice: rowsInSet(1),
    }
  }

  const type = /^type\s+(\S+)$/i.exec(statement)
  if (type) {
    const key = catalog.keys.find(
      (candidate) => candidate.name.toLowerCase() === type[1]!.toLowerCase(),
    )
    if (!key) return { kind: 'text', lines: [`演示会话：目录里没有键 ${type[1]}`] }
    return { kind: 'text', lines: [key.type] }
  }

  const get = /^get\s+(\S+)$/i.exec(statement)
  if (get) {
    const key = catalog.keys.find(
      (candidate) => candidate.name.toLowerCase() === get[1]!.toLowerCase(),
    )
    if (!key) return { kind: 'text', lines: [`演示会话：目录里没有键 ${get[1]}`] }
    return { kind: 'text', lines: [key.value] }
  }

  return { kind: 'text', lines: UNKNOWN_LINES }
}

/**
 * SQLite 分支：只认 SQLite 自己的语句形态。
 * 版本、页大小、journal 模式都取自实例与文件事实，不编造。
 */
function runSqliteQuery(database: DatabaseInstance, statement: string): MockQueryResult {
  const catalog = catalogOf(database)

  if (/^select\s+name\s+from\s+sqlite_master\s+where\s+type\s*=\s*'table'$/i.test(statement)) {
    const rows = catalog.tables.map((table) => [table.name] as const)
    return { kind: 'table', columns: ['name'], rows, notice: rowsInSet(rows.length) }
  }

  if (/^pragma\s+page_size$/i.test(statement)) {
    // 4096 是 SQLite 的默认页大小；演示文件按默认值登记。
    return { kind: 'table', columns: ['page_size'], rows: [['4096']], notice: rowsInSet(1) }
  }

  if (/^pragma\s+journal_mode$/i.test(statement)) {
    return { kind: 'table', columns: ['journal_mode'], rows: [['wal']], notice: rowsInSet(1) }
  }

  if (/^select\s+sqlite_version\(\)$/i.test(statement)) {
    // 版本与卡片上显示的同一个值（同一个事实只有一个家）。
    return {
      kind: 'table',
      columns: ['sqlite_version()'],
      rows: [[database.version]],
      notice: rowsInSet(1),
    }
  }

  const select = /^select\s+\*\s+from\s+(\S+)(?:\s+limit\s+(\d+))?$/i.exec(statement)
  if (select) {
    const table = findTable(catalog, select[1]!)
    if (!table) return missingTable(select[1]!)
    const limit = select[2] ? Number(select[2]) : table.rows.length
    const rows = table.rows.slice(0, limit)
    return {
      kind: 'table',
      columns: table.columns,
      rows,
      notice: rowsInSet(rows.length),
    }
  }

  const count = /^select\s+count\(\*\)\s+from\s+(\S+)$/i.exec(statement)
  if (count) {
    const table = findTable(catalog, count[1]!)
    if (!table) return missingTable(count[1]!)
    return {
      kind: 'table',
      columns: ['count(*)'],
      rows: [[String(table.rows.length)]],
      notice: rowsInSet(1),
    }
  }

  return { kind: 'text', lines: UNKNOWN_LINES }
}

/** 在演示目录上求值一条语句；不执行任何真实 SQL 或 Redis 命令。 */
export function runMockQuery(database: DatabaseInstance, statement: string): MockQueryResult {
  const collapsed = statement.trim().replace(/\s+/g, ' ')
  const normalized = collapsed.endsWith(';') ? collapsed.slice(0, -1).trimEnd() : collapsed
  if (normalized === '') return { kind: 'text', lines: [] }
  if (/^clear$/i.test(normalized)) return { kind: 'clear' }

  const statements = ENGINE_STATEMENTS[database.engine]
  if (/^help$/i.test(normalized)) {
    if (statements.length === 0) {
      return { kind: 'text', lines: ['演示会话：该引擎暂未收录演示语句'] }
    }
    return { kind: 'text', lines: ['可用语句：' + statements.join('、')] }
  }

  if (database.engine === 'Redis') return runRedisQuery(database, normalized)
  if (database.engine === 'SQLite') return runSqliteQuery(database, normalized)
  if (SQL_ENGINES.includes(database.engine)) return runSqlQuery(database, normalized)
  return { kind: 'text', lines: UNKNOWN_LINES }
}
