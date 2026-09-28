import { InvalidRequestError } from '../shared/errors.ts'

const MAX_SQL_BYTES = 64 * 1024
const FORBIDDEN = new Set([
  'ATTACH', 'DETACH', 'VACUUM', 'LOAD_EXTENSION', 'READFILE', 'WRITEFILE',
  'VIRTUAL', 'TRIGGER', 'ANALYZE', 'REINDEX',
])
const READ_PRAGMAS = new Set(['TABLE_INFO', 'TABLE_XINFO', 'INDEX_LIST', 'INDEX_INFO', 'INDEX_XINFO', 'FOREIGN_KEY_LIST', 'DATABASE_LIST', 'USER_VERSION'])

/** 只识别 SQL 的词法边界；字符串和注释里的分号、关键字不参与权限判定。 */
export function validateSqliteStatement(sql: string): void {
  if (!sql.trim()) throw new InvalidRequestError(400, '请输入 SQL 语句')
  if (Buffer.byteLength(sql) > MAX_SQL_BYTES) throw new InvalidRequestError(413, 'SQL 超过 64 KiB')
  const words: string[] = []
  let hasAssignment = false
  let hasCall = false
  let semicolon = false
  let afterEnd = false
  for (let i = 0; i < sql.length;) {
    const char = sql[i]!
    if (/\s/.test(char)) { i++; continue }
    if (char === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < sql.length && sql[i] !== '\n') i++
      continue
    }
    if (char === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      if (end < 0) throw new InvalidRequestError(400, 'SQL 注释未闭合')
      i = end + 2
      continue
    }
    if (char === ';') {
      if (semicolon) throw new InvalidRequestError(403, '一次只能执行一条 SQL')
      semicolon = true
      i++
      continue
    }
    if (semicolon) afterEnd = true
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      i++
      let closed = false
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) { i += 2; continue }
          i++; closed = true; break
        }
        i++
      }
      if (!closed) throw new InvalidRequestError(400, 'SQL 引号未闭合')
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = i++
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i]!)) i++
      words.push(sql.slice(start, i).toUpperCase())
      continue
    }
    if (char === '=') hasAssignment = true
    if (char === '(') hasCall = true
    i++
  }
  if (afterEnd || !words.length) throw new InvalidRequestError(403, '一次只能执行一条 SQL')
  if (words.some((word) => FORBIDDEN.has(word))) throw new InvalidRequestError(403, '数据库终端禁止文件、扩展与系统操作')
  const [first, second, third] = words
  const basic = ['SELECT', 'WITH', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']
  if (basic.includes(first!)) return
  if (first === 'CREATE' && (second === 'TABLE' || second === 'INDEX' || second === 'VIEW' || (second === 'UNIQUE' && third === 'INDEX'))) return
  if (first === 'DROP' && ['TABLE', 'INDEX', 'VIEW'].includes(second!)) return
  if (first === 'ALTER' && second === 'TABLE') return
  if (first === 'PRAGMA' && READ_PRAGMAS.has(second!) && !hasAssignment &&
      (second !== 'USER_VERSION' || !hasCall)) return
  throw new InvalidRequestError(403, '该 SQL 类型不允许在数据库终端执行')
}
