import { describe, expect, it } from 'vitest'
import { DATABASE_INSTANCES } from './databaseData'
import { DATABASE_CATALOG } from './databaseCatalog'
import { runMockQuery } from './databaseQuery'

const mariadb = DATABASE_INSTANCES.find((item) => item.engine === 'MariaDB')!
const redis = DATABASE_INSTANCES.find((item) => item.engine === 'Redis')!

describe('演示语句引擎', () => {
  it('SHOW TABLES 列出该实例目录里的表', () => {
    const result = runMockQuery(mariadb, 'SHOW TABLES')

    expect(result.kind).toBe('table')
    if (result.kind !== 'table') return
    expect(result.columns).toEqual(['Tables_in_mariadb-primary'])
    expect(result.rows.length).toBeGreaterThan(0)
  })

  it('SELECT * FROM 表 LIMIT n 取到该表的前 n 行', () => {
    const result = runMockQuery(mariadb, 'SELECT * FROM users LIMIT 2')

    expect(result.kind).toBe('table')
    if (result.kind !== 'table') return
    expect(result.rows).toHaveLength(2)
    expect(result.notice).toBe('2 rows in set')
  })

  it('连接数与卡片同源：SHOW STATUS LIKE Threads_connected 返回实例上的活跃连接数', () => {
    const result = runMockQuery(mariadb, "SHOW STATUS LIKE 'Threads_connected'")

    expect(result.kind).toBe('table')
    if (result.kind !== 'table') return
    expect(result.rows[0]?.[1]).toBe(String(mariadb.connections?.active))
  })

  it('SQLite 只认自己的方言：SHOW 系列在 SQLite 里不存在，如实说明', () => {
    const sqlite = DATABASE_INSTANCES.find((item) => item.engine === 'SQLite')
    if (!sqlite) throw new Error('演示集里应有 SQLite 实例')

    // SQLite 的表清单要查 sqlite_master，没有 SHOW TABLES 这个语句。
    const showTables = runMockQuery(sqlite, 'SHOW TABLES')
    expect(showTables.kind).toBe('text')
    if (showTables.kind !== 'text') return
    expect(showTables.lines[0]).toContain('该语句不在演示集内')

    const listing = runMockQuery(sqlite, "SELECT name FROM sqlite_master WHERE type='table'")
    expect(listing.kind).toBe('table')
    if (listing.kind !== 'table') return
    expect(listing.columns).toEqual(['name'])
    expect(listing.rows.map((row) => row[0])).toContain('notes')

    const version = runMockQuery(sqlite, 'SELECT sqlite_version()')
    expect(version.kind).toBe('table')
    if (version.kind !== 'table') return
    // 版本与卡片同源：同一个事实，两处显示一致。
    expect(version.rows[0]?.[0]).toBe(sqlite.version)
  })

  it('Redis 走键空间命令，不认 SQL 语句', () => {
    expect(runMockQuery(redis, 'INFO clients').kind).toBe('table')
    expect(runMockQuery(redis, 'SHOW TABLES').kind).toBe('text')
  })

  it('未知语句如实说明，且同一输入两次求值结果相同', () => {
    const first = runMockQuery(mariadb, 'DROP TABLE users')
    const second = runMockQuery(mariadb, 'DROP TABLE users')

    expect(first).toEqual(second)
    expect(first.kind).toBe('text')
    if (first.kind !== 'text') return
    expect(first.lines[0]).toContain('该语句不在演示集内')
  })

  it('clear 请求清屏', () => {
    expect(runMockQuery(mariadb, 'clear')).toEqual({ kind: 'clear' })
  })
})

describe('演示语句引擎的归一化与边界', () => {
  it('DESCRIBE 列出目录里该表的列名', () => {
    const result = runMockQuery(mariadb, 'DESCRIBE users')

    expect(result.kind).toBe('table')
    if (result.kind !== 'table') return
    expect(result.columns).toEqual(['Field'])
    expect(result.rows).toEqual([['id'], ['name'], ['created_at']])
    expect(result.notice).toBe('3 rows in set')
  })

  it('SELECT COUNT(*) FROM 返回该表行数', () => {
    const result = runMockQuery(mariadb, 'SELECT COUNT(*) FROM orders')

    expect(result.kind).toBe('table')
    if (result.kind !== 'table') return
    expect(result.columns).toEqual(['COUNT(*)'])
    expect(result.rows).toEqual([['3']])
    expect(result.notice).toBe('1 row in set')
  })

  it('大小写、多余空格与结尾分号都归一到同一语句', () => {
    const loose = runMockQuery(mariadb, '  select   * from USERS limit 2 ; ')
    const strict = runMockQuery(mariadb, 'SELECT * FROM users LIMIT 2')

    expect(loose).toEqual(strict)
  })

  it('目录里没有的表如实说明', () => {
    const result = runMockQuery(mariadb, 'DESCRIBE missing_table')

    expect(result.kind).toBe('text')
    if (result.kind !== 'text') return
    expect(result.lines[0]).toContain('目录里没有表 missing_table')
  })

  it('空串与纯空白语句返回空文本，不当作未知语句', () => {
    expect(runMockQuery(mariadb, '')).toEqual({ kind: 'text', lines: [] })
    expect(runMockQuery(mariadb, '   ')).toEqual({ kind: 'text', lines: [] })
  })

  it('help 按引擎列出可用语句', () => {
    const sql = runMockQuery(mariadb, 'help')
    expect(sql.kind).toBe('text')
    if (sql.kind === 'text') {
      expect(sql.lines[0]).toContain('可用语句：')
      expect(sql.lines[0]).toContain('SHOW TABLES')
    }

    const redisHelp = runMockQuery(redis, 'HELP')
    expect(redisHelp.kind).toBe('text')
    if (redisHelp.kind === 'text') {
      expect(redisHelp.lines[0]).toContain('KEYS *')
      expect(redisHelp.lines[0]).not.toContain('SHOW TABLES')
    }
  })

  it('Redis 的 KEYS、TYPE、GET 与缺键回应', () => {
    const keys = runMockQuery(redis, 'KEYS *')
    expect(keys.kind).toBe('table')
    if (keys.kind === 'table') {
      expect(keys.columns).toEqual(['key'])
      expect(keys.rows).toHaveLength(3)
    }

    const type = runMockQuery(redis, 'TYPE queue:emails')
    expect(type).toEqual({ kind: 'text', lines: ['list'] })

    const value = runMockQuery(redis, 'GET rate:api')
    expect(value).toEqual({ kind: 'text', lines: ['148'] })

    const missing = runMockQuery(redis, 'GET session:9999')
    expect(missing.kind).toBe('text')
    if (missing.kind === 'text') {
      expect(missing.lines[0]).toContain('目录里没有键 session:9999')
    }
  })

  it('目录覆盖全部实例，且引擎与实例一致', () => {
    for (const database of DATABASE_INSTANCES) {
      const catalog = DATABASE_CATALOG[database.id]
      expect(catalog, database.id).toBeDefined()
      expect(catalog?.engine, database.id).toBe(database.engine)
      if (database.engine === 'Redis') {
        expect(catalog?.keys.length, database.id).toBeGreaterThan(0)
        expect(catalog?.tables).toHaveLength(0)
      } else {
        expect(catalog?.tables.length, database.id).toBeGreaterThan(0)
        for (const table of catalog?.tables ?? []) {
          expect(table.rows.length, `${database.id}.${table.name}`).toBeGreaterThan(0)
          for (const row of table.rows) {
            expect(row, `${database.id}.${table.name}`).toHaveLength(table.columns.length)
          }
        }
      }
    }
  })
})
