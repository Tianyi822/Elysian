import { describe, expect, it } from 'vitest'
import { parsePlatformMemoryResponse, sampleFromUsage } from './types'

const MB = 1024 * 1024

describe('sampleFromUsage', () => {
  it('把 process.memoryUsage 的字节换成 MB', () => {
    expect(
      sampleFromUsage({ rss: 80 * MB, heapUsed: 40 * MB, heapTotal: 50 * MB }),
    ).toEqual({ rssMb: 80, heapUsedMb: 40, heapTotalMb: 50 })
  })
})

describe('parsePlatformMemoryResponse', () => {
  it('接受三项非负有限数字', () => {
    expect(parsePlatformMemoryResponse({ rssMb: 62.1, heapUsedMb: 40, heapTotalMb: 51.5 })).toEqual({
      rssMb: 62.1,
      heapUsedMb: 40,
      heapTotalMb: 51.5,
    })
  })

  it('不是对象或缺字段时抛中文错误', () => {
    expect(() => parsePlatformMemoryResponse(null)).toThrow('平台内存响应格式无效')
    expect(() => parsePlatformMemoryResponse({ rssMb: 1, heapUsedMb: 2 })).toThrow('平台内存响应格式无效')
    expect(() => parsePlatformMemoryResponse({ rssMb: -1, heapUsedMb: 1, heapTotalMb: 1 })).toThrow(
      '平台内存响应格式无效',
    )
  })
})
