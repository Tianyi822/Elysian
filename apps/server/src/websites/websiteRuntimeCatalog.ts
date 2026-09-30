import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { normalizeWebsiteJavaReleaseVersion, parseWebsiteRuntimeCatalogReport, type WebsiteRuntimeCatalog, type WebsiteRuntimeCatalogReport } from '@elysian/contracts'
import { ELYSIAN_PATHS } from '../shared/elysianPaths.ts'
import { InvalidRequestError } from '../shared/errors.ts'
import { fetchWebsiteRuntimeCatalog } from './websiteRuntimeSources.ts'

const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const RETRY_DELAY_MS = 60_000
export type WebsiteRuntimeCatalogService = { get(): Promise<WebsiteRuntimeCatalogReport> }
export type WebsiteRuntimeCatalogCache = {
  load(): Promise<WebsiteRuntimeCatalogReport | undefined>
  save(report: WebsiteRuntimeCatalogReport): Promise<void>
}

export function createFileWebsiteRuntimeCatalogCache(path = ELYSIAN_PATHS.websiteRuntimeCatalog): WebsiteRuntimeCatalogCache {
  return {
    async load() {
      try {
        const cached = JSON.parse(await readFile(path, 'utf8')) as WebsiteRuntimeCatalogReport
        // 缓存只保留完整版本；移除主版本快捷项，并展开初始 GA 的零分量。
        // 复用已有正式补丁与准确镜像，断网时也无需等六小时刷新。
        if (Array.isArray(cached.catalog?.java)) {
          cached.catalog.java = cached.catalog.java
            .filter((entry) => typeof entry.version !== 'string' || !/^\d+$/.test(entry.version))
            .map((entry) => ({ ...entry, version: typeof entry.version === 'string' ? normalizeWebsiteJavaReleaseVersion(entry.version) : entry.version }))
        }
        return parseWebsiteRuntimeCatalogReport(cached)
      }
      catch { return undefined }
    },
    async save(report) {
      await mkdir(dirname(path), { recursive: true })
      const temporary = `${path}.tmp`
      await writeFile(temporary, JSON.stringify(report), { mode: 0o600 })
      await rename(temporary, path)
    },
  }
}

/** 懒获取、六小时缓存、并发合并；更新失败保留自动获取过的目录并明确标为过期。 */
export function createWebsiteRuntimeCatalogService(deps: {
  fetchCatalog?: () => Promise<WebsiteRuntimeCatalog>
  now?: () => number
  cache?: WebsiteRuntimeCatalogCache
  ttlMs?: number
} = {}): WebsiteRuntimeCatalogService {
  const now = deps.now ?? Date.now
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS
  const fetchCatalog = deps.fetchCatalog ?? (() => fetchWebsiteRuntimeCatalog(globalThis.fetch, new Date(now()).toISOString().slice(0, 10)))
  let current: WebsiteRuntimeCatalogReport | undefined
  let initialized: Promise<void> | undefined
  let inFlight: Promise<WebsiteRuntimeCatalogReport> | undefined
  let nextRefreshAt = 0
  async function initialize() {
    try {
      const saved = await deps.cache?.load()
      if (saved && Date.parse(saved.fetchedAt) <= now()) {
        current = parseWebsiteRuntimeCatalogReport(saved)
        nextRefreshAt = Date.parse(saved.fetchedAt) + ttlMs
      }
    } catch { /* 缓存不可读或无效时直接从官方重新获取。 */ }
  }
  async function refresh(): Promise<WebsiteRuntimeCatalogReport> {
    try {
      const catalog = await fetchCatalog()
      const report = parseWebsiteRuntimeCatalogReport({ catalog, fetchedAt: new Date(now()).toISOString(), stale: false, detail: null })
      current = report
      nextRefreshAt = now() + ttlMs
      try { await deps.cache?.save(report) }
      catch { report.detail = '版本目录已更新，持久缓存写入失败' }
      return report
    } catch (error) {
      const detail = error instanceof Error ? error.message : '官方版本目录获取失败'
      if (!current) throw new InvalidRequestError(503, `无法获取正式运行时版本：${detail}`)
      current = { ...current, stale: true, detail: `版本目录更新失败，正在使用上次获取的缓存：${detail}` }
      nextRefreshAt = now() + RETRY_DELAY_MS
      return current
    }
  }
  return {
    async get() {
      initialized ??= initialize()
      await initialized
      if (current && now() < nextRefreshAt) return current
      if (!inFlight) inFlight = refresh().finally(() => { inFlight = undefined })
      return inFlight
    },
  }
}
