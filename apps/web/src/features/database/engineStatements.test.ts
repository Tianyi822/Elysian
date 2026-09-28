import { describe, expect, it } from 'vitest'
import { SQLITE_READ_PRAGMAS } from '@elysian/contracts'
import { ENGINE_STATEMENTS } from './engineStatements'

describe('SQLite 补全词表与只读 PRAGMA 白名单同源', () => {
  it('SQLite 词表的 PRAGMA 候选全部来自契约白名单，且白名单逐项都有候选', () => {
    const pragmas = ENGINE_STATEMENTS.SQLite.filter((statement) => statement.startsWith('PRAGMA '))
    for (const statement of pragmas) {
      const name = statement.slice('PRAGMA '.length).toUpperCase()
      expect((SQLITE_READ_PRAGMAS as readonly string[]).includes(name), statement).toBe(true)
    }
    expect(pragmas).toHaveLength(SQLITE_READ_PRAGMAS.length)
  })

  it('前端推荐的 page_size 与 journal_mode 裸查询在白名单内', () => {
    expect((SQLITE_READ_PRAGMAS as readonly string[]).includes('PAGE_SIZE')).toBe(true)
    expect((SQLITE_READ_PRAGMAS as readonly string[]).includes('JOURNAL_MODE')).toBe(true)
  })
})
