import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { validateSqliteStatement } from './sqliteSqlPolicy.ts'

type Request = { id: number; kind: 'init' | 'probe' | 'validate' | 'execute' | 'export'; sql?: string; target?: string; limitBytes?: number }
const file = process.env.ELYSIAN_SQLITE_FILE
if (!file) process.exit(2)
const db = new Database(file, { create: process.env.ELYSIAN_SQLITE_CREATE === '1', strict: true })
db.run('PRAGMA trusted_schema=OFF')
db.run('PRAGMA hard_heap_limit=134217728')
db.run('PRAGMA busy_timeout=3000')
db.run('PRAGMA foreign_keys=ON')
const pageSize = Number((db.query('PRAGMA page_size').get() as { page_size: number }).page_size)
db.run(`PRAGMA max_page_count=${Math.floor(1024 ** 3 / pageSize)}`)

function probe(full = false) {
  if (full) {
    const check = db.query('PRAGMA quick_check').get() as { quick_check: string } | null
    if (check?.quick_check !== 'ok') throw new Error('SQLite 文件完整性校验失败')
  }
  const tables = db.query("SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { count: number }
  const version = db.query('SELECT sqlite_version() AS version').get() as { version: string }
  return { tableCount: tables.count, version: version.version, bytes: statSync(file!).size }
}

function execute(sql: string): string[] {
  validateSqliteStatement(sql)
  const statement = db.prepare(sql)
  try {
    if (statement.columnNames.length === 0) {
      const outcome = statement.run()
      return [`执行成功，影响 ${outcome.changes} 行。`]
    }
    const output: string[] = [statement.columnNames.join('\t')]
    let bytes = Buffer.byteLength(output[0]!)
    let count = 0
    for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
      let largeCell = false
      const line = statement.columnNames.map((column) => {
        const value = row[column]
        if (typeof value === 'string' && Buffer.byteLength(value) > 1024 * 1024) { largeCell = true; return '' }
        return value == null ? 'NULL' : value instanceof Uint8Array ? `[BLOB ${value.byteLength} 字节]` : String(value)
      }).join('\t')
      if (largeCell) { output.push('单元格超过 1 MiB，已截断。'); break }
      bytes += Buffer.byteLength(line)
      if (bytes > 1024 * 1024) { output.push('结果超过 1 MiB，已截断。'); break }
      output.push(line)
      count++
      if (count >= 500) { output.push('结果达到 500 行上限，已截断。'); break }
    }
    output.push(`返回 ${count} 行。`)
    return output
  } finally { statement.finalize() }
}

process.on('message', (message: unknown) => {
  const request = message as Request
  try {
    let value: unknown
    if (request.kind === 'init') {
      db.run('CREATE TABLE __elysian_init (id INTEGER)')
      db.run('DROP TABLE __elysian_init')
      value = probe(true)
    } else if (request.kind === 'probe') value = probe()
    else if (request.kind === 'validate') value = probe(true)
    else if (request.kind === 'execute' && typeof request.sql === 'string') {
      if (typeof request.limitBytes === 'number') db.run(`PRAGMA max_page_count=${Math.floor(Math.max(0, request.limitBytes) / pageSize)}`)
      value = execute(request.sql)
    }
    else if (request.kind === 'export' && typeof request.target === 'string') {
      db.prepare('VACUUM INTO ?').run(request.target)
      value = { bytes: statSync(request.target).size }
    } else throw new Error('SQLite 操作无效')
    process.send?.({ id: request.id, ok: true, value })
  } catch (error) {
    const code = (error as { code?: unknown } | null | undefined)?.code
    const frame: { id: number; ok: boolean; error: string; code?: string } = { id: request.id, ok: false, error: error instanceof Error ? error.message : 'SQLite 操作失败' }
    if (typeof code === 'string') frame.code = code
    process.send?.(frame)
  }
})
process.on('disconnect', () => { db.close(true); process.exit(0) })
process.send?.({ type: 'ready' })
