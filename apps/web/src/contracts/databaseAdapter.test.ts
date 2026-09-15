import { describe, expect, it } from 'vitest'
import type { DatabaseAdapter } from './adapters'
import { MockDatabaseAdapter } from '../adapters/mock/mockAdapters'

/**
 * 数据库适配器的共同契约。
 *
 * 只依赖 `DatabaseAdapter` 接口本身，不依赖任何 mock 细节——将来换成
 * HTTP adapter 时对同一套断言再跑一次，这就是「mock 可替换」的验证方式。
 */

export function createDatabaseAdapterContractTests(
  name: string,
  make: () => DatabaseAdapter,
): void {
  describe(`DatabaseAdapter 契约：${name}`, () => {
    it('list 返回非空且标识唯一，字段完整（含 containerId 与 credentials）', async () => {
      const databases = await make().list()
      expect(databases.length).toBeGreaterThan(0)
      expect(new Set(databases.map((database) => database.id)).size).toBe(databases.length)

      for (const database of databases) {
        expect(database.id).toBeTruthy()
        expect(database.engine).toBeTruthy()
        expect(database.name).toBeTruthy()
        expect(database.version).toBeTruthy()
        expect(database.containerId).toBeTruthy()
        expect(database.credentials.username).toBeTruthy()
        expect(database.credentials.password).toBeTruthy()
        expect(database.connections.active).toBeGreaterThanOrEqual(0)
        expect(database.connections.max).toBeGreaterThan(0)
        expect(Number.isNaN(Date.parse(database.updatedAt))).toBe(false)
      }
    })

    it('execMockQuery 对同一输入两次求值结果相同', async () => {
      const adapter = make()
      const [database] = await adapter.list()
      if (!database) return // 数据集为空时无法验证，不虚构前提

      const first = await adapter.execMockQuery(database.id, 'help')
      const second = await adapter.execMockQuery(database.id, 'help')
      expect(first).toEqual(second)
    })

    it('未知语句不抛错，如实给出文本说明', async () => {
      const adapter = make()
      const [database] = await adapter.list()
      if (!database) return

      const result = await adapter.execMockQuery(database.id, 'DROP TABLE users')
      expect(result.kind).toBe('text')
      if (result.kind !== 'text') return
      expect(result.lines.join(' ')).toContain('该语句不在演示集内')
    })

    it('不存在的实例以错误回应，而不是静默成功', async () => {
      await expect(make().execMockQuery('db-not-exist', 'help')).rejects.toThrow()
    })
  })
}

createDatabaseAdapterContractTests('mock 实现', () => new MockDatabaseAdapter())
