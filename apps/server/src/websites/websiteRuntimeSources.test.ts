import { describe, expect, it, vi } from 'vitest'
import { fetchWebsiteRuntimeCatalog } from './websiteRuntimeSources.ts'

function officialSources() {
  const json = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status, headers })
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname === 'auth.docker.io') return json({ token: 'test-token' })
    if (url.hostname === 'registry-1.docker.io') {
      const repository = url.pathname.split('/')[3]
      const tags: Record<string, string[]> = {
        node: ['30.2.1', '26.10.0', '26.0.0', '14.17.6', '27.0.0-rc.1', '99.0.0'],
        golang: ['1.29.1', '1.27.1', '1.16.7', '1.15.0', '1.28rc1', '1.26.9'],
        python: ['2.7.18-slim', '3.17.1-slim', '3.14.7-slim', '3.9.7-slim', '3.15.0-slim', '3.15.0rc1-slim', '3.14.8-slim'],
        'eclipse-temurin': ['29.0.1_1-jre', '11.0.32.1_1-jre', '11.0.32_9-jre', '17.0.1_12-jre', '17_35-jre', '16.0.2_7-jdk', '28-ea-jdk'],
      }
      return json({ tags: tags[repository!] })
    }
    if (url.hostname === 'nodejs.org') return json([
      { version: 'v30.2.1', date: '2029-06-01' }, { version: 'v26.10.0', date: '2026-09-21' },
      { version: 'v26.0.0', date: '2026-05-05' }, { version: 'v14.17.6', date: '2021-08-30' },
      { version: 'v27.0.0-rc.1', date: '2026-09-20' }, { version: 'v99.0.0', date: '2032-01-01' },
    ])
    if (url.hostname === 'raw.githubusercontent.com') return json({ v26: { start: '2026-05-05', end: '2029-04-30' } })
    if (url.hostname === 'go.dev') return json([
      { version: 'go1.29.1', stable: true }, { version: 'go1.27.1', stable: true }, { version: 'go1.16.7', stable: true },
      { version: 'go1.15', stable: true }, { version: 'go1.28rc1', stable: false }, { version: 'go1.26.9', stable: false },
    ])
    if (url.hostname === 'www.python.org') return json([
      { name: 'Python 2.7.18', pre_release: false, is_published: true, release_date: '2020-04-20' },
      { name: 'Python 3.17.1', pre_release: false, is_published: true, release_date: '2029-10-01' },
      { name: 'Python 3.14.7', pre_release: false, is_published: true, release_date: '2026-08-01' },
      { name: 'Python 3.9.7', pre_release: false, is_published: true, release_date: '2021-08-30' },
      { name: 'Python 3.14.0', pre_release: false, is_published: true, release_date: '2025-10-07' },
      { name: 'Python 3.15.0', pre_release: true, is_published: true, release_date: '2026-09-20' },
      { name: 'Python 3.15.0rc1', pre_release: true, is_published: true, release_date: '2026-09-20' },
      { name: 'Python 3.14.8', pre_release: false, is_published: false, release_date: '2026-09-20' },
    ])
    if (url.pathname.endsWith('/available_releases')) return json({ available_lts_releases: [8, 11, 17, 21, 25, 29], most_recent_feature_release: 29 })
    if (url.pathname.endsWith('/release_names')) {
      return url.searchParams.get('page') === '0' ? json({ releases: ['jdk-29.0.1+1', 'jdk-11.0.32.1+1', 'jdk-11.0.32+9', 'jdk-17.0.1+12', 'jdk-17+35', 'jdk-16.0.2+7', 'jdk-28-ea'] }) : json({}, 404)
    }
    throw new Error(`未预期的官方请求：${url.hostname}`)
  })
  return fetcher as unknown as typeof globalThis.fetch
}

describe('网站版本从官方自动取得', () => {
  it('保留五年前的历史正式补丁，只接纳正式发布记录与官方镜像的交集', async () => {
    const catalog = await fetchWebsiteRuntimeCatalog(officialSources(), '2026-09-30')
    expect(catalog.node.map((entry) => entry.version)).toEqual(['26.10.0', '26.0.0', '14.17.6'])
    expect(catalog.go.map((entry) => entry.version)).toContain('1.15.0')
    expect(catalog.python.map((entry) => entry.version)).toEqual(['3.14.7', '3.9.7'])
    expect(catalog.java.find((entry) => entry.version === '11.0.32.1+1')?.image).toBe('eclipse-temurin:11.0.32.1_1-jre')
    expect(catalog.java.find((entry) => entry.version === '17.0.0+35')?.image).toBe('eclipse-temurin:17_35-jre')
    expect(catalog.java.some((entry) => /^\d+$/.test(entry.version))).toBe(false)
    expect(catalog.java.find((entry) => entry.version === '16.0.2+7')?.image).toBe('eclipse-temurin:16.0.2_7-jdk')
    for (const entries of Object.values(catalog)) for (const entry of entries) expect(entry.image).not.toMatch(/rc|beta|ea/i)
  })

  it('未来正式版本自动进入目录，无需修改版本列表', async () => {
    const catalog = await fetchWebsiteRuntimeCatalog(officialSources(), '2030-09-30')
    expect(catalog.node.some((entry) => entry.version === '30.2.1')).toBe(true)
    expect(catalog.go.some((entry) => entry.version === '1.29.1')).toBe(true)
    expect(catalog.python.some((entry) => entry.version === '3.17.1')).toBe(true)
    expect(catalog.java.some((entry) => entry.version === '29.0.1+1')).toBe(true)
  })
})
