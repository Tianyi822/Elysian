import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileWebsiteRegistry, createMemoryWebsiteRegistry, type WebsiteRegistry, type WebsiteRecord } from './websitesRegistry.ts'

/*
 * 双实现行为一致（put/remove/list）+ 文件实现的原子写与串行队列。
 * 测试全部落在临时目录，不碰开发者真实的 ~/.Elysian。
 */

function row(id: string, overrides: Partial<WebsiteRecord> = {}): WebsiteRecord {
  return {
    id,
    kind: 'node',
    name: `站点-${id}`,
    port: 3000,
    runtimeVersion: '20.11.1',
    rootDir: `/srv/wwwroot/站点-${id}`,
    domain: null,
    containerName: 'elysian-site-0123456789ab',
    containerId: 'a'.repeat(64),
    imageRef: 'node:20.11.1',
    deployCommand: 'tail -f /dev/null',
    enabled: false,
    category: 'development',
    expiryAt: null,
    note: null,
    gitUrl: null,
    createdAt: '2026-09-29T00:00:00.000Z',
    ...overrides,
  }
}

/** 双实现共用的行为断言：两份实现对同一套行为各跑一遍，这就是「双实现一致」的验证方式。 */
async function assertRegistryBehaviors(registry: WebsiteRegistry): Promise<void> {
  await registry.put(row('w-1'))
  expect((await registry.list()).map((item) => item.id)).toEqual(['w-1'])
  await registry.put(row('w-2'))
  await registry.put({ ...row('w-1'), note: '更新备注' })
  const rows = await registry.list()
  expect(rows.map((item) => item.id).sort()).toEqual(['w-1', 'w-2'])
  expect(rows.find((item) => item.id === 'w-1')?.note).toBe('更新备注')
  await registry.remove('w-1')
  expect((await registry.list()).map((item) => item.id)).toEqual(['w-2'])
  // list 返回副本：外部改动不影响登记。
  const snapshot = await registry.list()
  snapshot[0]!.name = '外部改写'
  expect((await registry.list())[0]?.name).not.toBe('外部改写')
}

async function withTempDir(handler: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'elysian-websites-'))
  try {
    await handler(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('网站登记双实现', () => {
  it('memory 实现满足登记行为', async () => {
    await assertRegistryBehaviors(createMemoryWebsiteRegistry())
  })

  it('file 实现满足同一套登记行为', async () => {
    await withTempDir(async (dir) => {
      await assertRegistryBehaviors(createFileWebsiteRegistry(join(dir, 'websites.json')))
    })
  })

  it('文件实现：put 持久化为 JSON 数组，remove 后文件同步更新，重新打开仍可读', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'websites.json')
      const registry = createFileWebsiteRegistry(path)
      await registry.put(row('w-1', { name: '官网门户' }))
      const persisted = JSON.parse(await readFile(path, 'utf8')) as WebsiteRecord[]
      expect(persisted.map((item) => item.name)).toEqual(['官网门户'])
      await registry.remove('w-1')
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual([])
      expect(await createFileWebsiteRegistry(path).list()).toEqual([])
    })
  })

  it('文件实现：并发写经串行队列不交错，最终状态包含全部写入', async () => {
    await withTempDir(async (dir) => {
      const registry = createFileWebsiteRegistry(join(dir, 'websites.json'))
      await Promise.all(Array.from({ length: 20 }, (_, index) => registry.put(row(`w-${index}`))))
      const rows = await registry.list()
      expect(rows).toHaveLength(20)
      expect(new Set(rows.map((item) => item.id)).size).toBe(20)
    })
  })

  it('文件实现：损坏内容（非数组 JSON）在读取时显式报错，不静默清空', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'websites.json')
      await createFileWebsiteRegistry(path).put(row('w-1'))
      await writeFile(path, '{"corrupted":true}', 'utf8')
      await expect(createFileWebsiteRegistry(path).list()).rejects.toThrow('网站登记文件无效')
    })
  })
})
