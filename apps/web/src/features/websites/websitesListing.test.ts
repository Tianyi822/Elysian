import { describe, expect, it } from 'vitest'
import type { WebsiteProject } from '@elysian/contracts'
import { filterWebsiteProjects } from './websitesListing'

/*
 * 网站列表的过滤是纯函数：面板把 store 里的原始列表交给它，
 * 得到当前筛选下要呈现的卡片列表。这里用手工夹具逐条断言口径。
 */

function project(overrides: Partial<WebsiteProject>): WebsiteProject {
  return {
    id: 'p',
    kind: 'java',
    name: 'app',
    pid: null,
    containerId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    port: 8080,
    runtimeVersion: '17',
    rootDir: '/www/wwwroot/app',
    runState: 'stopped',
    domain: null,
    expiryAt: null,
    note: null,
    cert: 'none',
    category: 'production',
    deployCommand: null,
    gitUrl: null,
    traffic: { todayMb: 0, totalGb: 0 },
    ...overrides,
  }
}

const FIXTURES: readonly WebsiteProject[] = [
  project({ id: 'a', name: '订单中心-api', note: '商城核心', category: 'production' }),
  project({ id: 'b', name: '老网关', category: 'development' }),
  project({ id: 'c', kind: 'node', name: 'marketing-site', note: '官网与落地页', category: 'production' }),
  project({ id: 'd', kind: 'html', name: 'company-portal', category: 'testing' }),
]

describe('filterWebsiteProjects', () => {
  it('按分类过滤', () => {
    const rows = filterWebsiteProjects(FIXTURES, { category: 'production', search: '' })
    expect(rows.map((row) => row.id)).toEqual(['a', 'c'])
  })

  it('all 表示不过滤分类', () => {
    const rows = filterWebsiteProjects(FIXTURES, { category: 'all', search: '' })
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('搜索按名称做大小写不敏感的子串匹配', () => {
    const rows = filterWebsiteProjects(FIXTURES, { category: 'all', search: 'MARKET' })
    expect(rows.map((row) => row.id)).toEqual(['c'])
  })

  it('搜索按备注匹配，无备注的项目不受影响地参与匹配', () => {
    const byNote = filterWebsiteProjects(FIXTURES, { category: 'all', search: '落地页' })
    expect(byNote.map((row) => row.id)).toEqual(['c'])
    const noHit = filterWebsiteProjects(FIXTURES, { category: 'all', search: '不存在的关键词' })
    expect(noHit).toEqual([])
  })

  it('分类与搜索叠加生效', () => {
    const rows = filterWebsiteProjects(FIXTURES, { category: 'production', search: '订单' })
    expect(rows.map((row) => row.id)).toEqual(['a'])
  })

  it('不改传入数组', () => {
    const original = [...FIXTURES]
    filterWebsiteProjects(FIXTURES, { category: 'testing', search: 'portal' })
    expect(FIXTURES).toEqual(original)
  })
})
