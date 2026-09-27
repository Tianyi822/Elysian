import { describe, expect, it, vi } from 'vitest'
import { IMAGE_TAG_LIMIT, listRegistryTags, searchCatalog } from './dockerImageSearch.ts'

const target = { host: 'mirror.example.com', addresses: ['1.2.3.4'] }

describe('Distribution 仓库目录搜索', () => {
  it('只返回匹配的仓库名，并限制十条', async () => {
    const fetchCatalog = vi.fn(async () => ({
      status: 200,
      json: { repositories: ['other', ...Array.from({ length: 20 }, (_, i) => `redis-${i}`), 'redis-0'] },
    }))
    const result = await searchCatalog(target, 'redis', fetchCatalog)
    expect(result).toEqual({
      names: Array.from({ length: 10 }, (_, i) => `redis-${i}`), searchable: true,
    })
    expect(fetchCatalog).toHaveBeenCalledWith(target, '/v2/_catalog?n=100&last=redir')
  })

  it('目录拒绝访问、返回错误格式或超时都提示手动输入', async () => {
    await expect(searchCatalog(target, 're', async () => ({ status: 401, json: null }))).resolves.toEqual({ names: [], searchable: false })
    await expect(searchCatalog(target, 're', async () => ({ status: 200, json: {} }))).resolves.toEqual({ names: [], searchable: false })
    await expect(searchCatalog(target, 're', async () => { throw new Error('镜像源目录查询超时') })).resolves.toEqual({ names: [], searchable: false })
  })
})

describe('Distribution 镜像标签列表', () => {
  it('latest 优先、其余按数字版本倒序，并限制数量', async () => {
    const raw = ['bad tag', '7', '10', 'latest', '7', ...Array.from({ length: 60 }, (_, i) => `1.${i}`)]
    const result = await listRegistryTags(target, 'team/redis', async () => ({ status: 200, json: { tags: raw } }))
    expect(result.searchable).toBe(true)
    expect(result.tags.slice(0, 3)).toEqual(['latest', '10', '7'])
    expect(result.tags).toHaveLength(IMAGE_TAG_LIMIT)
    expect(result.tags).not.toContain('bad tag')
  })

  it('标签接口不可用时返回可手动输入状态', async () => {
    await expect(listRegistryTags(target, 'redis', async () => ({ status: 401, json: null })))
      .resolves.toEqual({ tags: [], searchable: false })
  })
})
