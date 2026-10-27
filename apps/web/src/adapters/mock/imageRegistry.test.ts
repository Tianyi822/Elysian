import { describe, expect, it } from 'vitest'
import { customImageRegistries, invalidImageRegistries, officialImageRegistries } from '../../test/imageRegistryCases'
import { createMockGateway } from './gateway'

describe('镜像搜索 mock 的源地址识别', () => {
  it.each(officialImageRegistries)('官方地址 %j 与默认源提供相同搜索和标签', async (registry) => {
    const adapter = createMockGateway({ eventStream: 'memory' }).containers
    await expect(adapter.searchImageNames('redis', registry)).resolves.toEqual(await adapter.searchImageNames('redis'))
    await expect(adapter.imageTags('redis', registry)).resolves.toEqual(await adapter.imageTags('redis'))
  })

  it.each([...customImageRegistries, ...invalidImageRegistries])('非官方地址 %j 不回退官方数据', async (registry) => {
    const adapter = createMockGateway({ eventStream: 'memory' }).containers
    await expect(adapter.searchImageNames('redis', registry)).resolves.toEqual({ names: [], searchable: false })
    await expect(adapter.imageTags('redis', registry)).resolves.toEqual({ tags: [], searchable: false })
  })
})
