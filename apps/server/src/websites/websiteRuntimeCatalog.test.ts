import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileWebsiteRuntimeCatalogCache, createWebsiteRuntimeCatalogService } from './websiteRuntimeCatalog.ts'
import { runtimeReport } from './websiteRuntimeTestUtils.ts'

describe('网站版本缓存', () => {
  it('缓存中的 Java 主版本快捷项被移除，断网时仍能读取完整正式版本', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elysian-runtime-'))
    try {
      const path = join(directory, 'runtimes.json')
      const cached = runtimeReport()
      cached.catalog.java = [
        { ...cached.catalog.java[0]!, version: '17' },
        ...cached.catalog.java,
        { ...cached.catalog.java[0]!, version: '17+35', image: 'eclipse-temurin:17_35-jre' },
      ]
      await writeFile(path, JSON.stringify(cached))
      const fetchCatalog = vi.fn(async () => { throw new Error('网络不可用') })
      const service = createWebsiteRuntimeCatalogService({ cache: createFileWebsiteRuntimeCatalogCache(path), fetchCatalog, now: () => Date.parse(cached.fetchedAt) + 1 })
      expect((await service.get()).catalog.java.map((entry) => entry.version)).toEqual(['17.0.1+12', '17.0.0+35'])
      expect(fetchCatalog).not.toHaveBeenCalled()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('损坏或不可读的缓存不会阻止重新获取', async () => {
    const fetchCatalog = vi.fn(async () => runtimeReport().catalog)
    const cache = { load: async () => { throw new Error('缓存不可读') }, save: vi.fn(async () => {}) }
    expect((await createWebsiteRuntimeCatalogService({ fetchCatalog, cache }).get()).stale).toBe(false)
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    expect(cache.save).toHaveBeenCalledTimes(1)
  })

  it('合并并发读取，过期后自动取得新发布的正式版本', async () => {
    let now = Date.parse('2026-09-30T01:00:00Z')
    const fetchCatalog = vi.fn(async () => runtimeReport().catalog)
    const service = createWebsiteRuntimeCatalogService({ fetchCatalog, now: () => now, ttlMs: 1000 })
    await Promise.all([service.get(), service.get(), service.get()])
    expect(fetchCatalog).toHaveBeenCalledTimes(1)
    const next = runtimeReport().catalog
    next.node = [...next.node, { version: '24.22.0', image: 'node:24.22.0', checkedAt: '2026-09-30', maintenance: 'maintained' }]
    fetchCatalog.mockResolvedValue(next)
    now += 1001
    expect((await service.get()).catalog.node.some((entry) => entry.version === '24.22.0')).toBe(true)
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
  })

  it('刷新失败显示过期缓存，首次失败明确报错', async () => {
    let now = Date.parse('2026-09-30T00:00:00Z')
    const fetchCatalog = vi.fn(async () => runtimeReport().catalog)
    const service = createWebsiteRuntimeCatalogService({ fetchCatalog, now: () => now, ttlMs: 1000 })
    const first = await service.get()
    now += 1001
    fetchCatalog.mockRejectedValue(new Error('网络不可用'))
    expect(await service.get()).toMatchObject({ catalog: first.catalog, stale: true, detail: expect.stringContaining('上次获取的缓存') })
    await service.get()
    expect(fetchCatalog).toHaveBeenCalledTimes(2)
    await expect(createWebsiteRuntimeCatalogService({ fetchCatalog }).get()).rejects.toThrow('无法获取正式运行时版本')
  })

  it('持久缓存能跨实例复用，断网时已有版本仍可选择', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'elysian-runtime-'))
    try {
      const cache = createFileWebsiteRuntimeCatalogCache(join(directory, 'runtimes.json'))
      const report = runtimeReport()
      await cache.save(report)
      const fetchCatalog = vi.fn(async () => { throw new Error('网络不可用') })
      const fresh = createWebsiteRuntimeCatalogService({ cache, fetchCatalog, now: () => Date.parse(report.fetchedAt) + 1 })
      expect(await fresh.get()).toEqual(report)
      expect(fetchCatalog).not.toHaveBeenCalled()
      const stale = createWebsiteRuntimeCatalogService({ cache, fetchCatalog, now: () => Date.parse(report.fetchedAt) + 7 * 3600_000 })
      expect((await stale.get()).stale).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
