import { SQLITE_READ_PRAGMAS, type DatabaseEngine } from '@elysian/contracts'

/*
 * 各引擎的语句词表：SQL 会话行首 Tab 补全的候选来源，纯常量、无依赖。
 * 真实（Docker 协议终端）会话与本地会话共用同一份词表。
 */

/** SQL 引擎共用的语句清单，供行首 Tab 补全使用。 */
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
 * PRAGMA 候选由契约的只读白名单 SQLITE_READ_PRAGMAS 派生（与服务器校验同源），
 * 补全只推荐服务端会放行的语句，不得在此手写 PRAGMA 清单。
 */
const SQLITE_STATEMENTS = [
  'help',
  "SELECT name FROM sqlite_master WHERE type='table'",
  ...SQLITE_READ_PRAGMAS.map((name) => `PRAGMA ${name.toLowerCase()}`),
  'SELECT sqlite_version()',
  'SELECT * FROM',
  'SELECT COUNT(*) FROM',
  'clear',
]

/** 各引擎可用的语句，供行首 Tab 补全共用一处。 */
export const ENGINE_STATEMENTS: Record<DatabaseEngine, readonly string[]> = {
  MariaDB: SQL_STATEMENTS,
  MySQL: SQL_STATEMENTS,
  Redis: ['help', 'KEYS *', 'TYPE', 'GET', 'INFO clients', 'clear'],
  SQLite: SQLITE_STATEMENTS,
}
