import { describe, expect, it } from 'vitest'
import type { DatabaseInstance } from '@elysian/contracts'
import { completeSqlStatement } from './SqlSessionWindow'

// 补全只消费实例的引擎：fixture 内联在测试里，不再依赖演示数据集。
const mariadb: DatabaseInstance = {
  id: 'db-mariadb-primary',
  engine: 'MariaDB',
  name: 'mariadb-primary',
  version: '10.11.8',
  status: 'running',
  updatedAt: '2026-09-12T08:00:00.000Z',
}

describe('SQL Tab 补全', () => {
  it('行首唯一命中语句：补齐并补一个空格', () => {
    expect(completeSqlStatement(mariadb, 'hel', 3)).toEqual({ draft: 'help ', cursor: 5 })
  })

  it('行首多命中收敛到最长公共前缀：SH 补成 SHOW（含空格）', () => {
    // 'SHOW TABLES' 与 "SHOW STATUS LIKE 'Threads_connected'" 同时命中，
    // 不可唯一补全，收敛到公共前缀 'SHOW '——末尾空格保留。
    expect(completeSqlStatement(mariadb, 'SH', 2)).toEqual({ draft: 'SHOW ', cursor: 5 })
  })

  it('没有命中时原样返回，不带候选', () => {
    expect(completeSqlStatement(mariadb, 'DROP', 4)).toEqual({ draft: 'DROP', cursor: 4 })
    expect(completeSqlStatement(mariadb, 'DROP', 4).candidates).toBeUndefined()
  })

  it('行中不补目录名：与真实会话一致，返回原样且不带候选', () => {
    expect(completeSqlStatement(mariadb, 'SELECT * FROM us', 16)).toEqual({
      draft: 'SELECT * FROM us',
      cursor: 16,
    })
    expect(completeSqlStatement(mariadb, 'SELECT * FROM us', 16).candidates).toBeUndefined()
  })
})
