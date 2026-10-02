import { describe, expect, it } from 'vitest'
import { parsePlatformMemoryResponse } from './types'
import { platformMemorySample } from '../../test/platformMemorySample'

describe('parsePlatformMemoryResponse', () => {
  it('保留 Go 分项、回收信息、系统来源和采样时间', () => {
    const sample = platformMemorySample({ rssMb: 62.125 })
    expect(parsePlatformMemoryResponse(sample)).toEqual(sample)
  })

  it('不是对象或缺字段时抛中文错误', () => {
    expect(() => parsePlatformMemoryResponse(null)).toThrow('平台内存响应格式无效')
    expect(() => parsePlatformMemoryResponse({ rssMb: 1, heapUsedMb: 2 })).toThrow('平台内存响应格式无效')
    expect(() => parsePlatformMemoryResponse(platformMemorySample({ rssMb: -1 }))).toThrow('平台内存响应格式无效')
  })

  it('接受明确标注的近似值，以及常驻不可用但 Go 分项可读的采样', () => {
    const approximate = platformMemorySample({ rssSource: 'statm' })
    const unavailable = platformMemorySample({ rssMb: null, rssSource: 'unavailable' })
    expect(parsePlatformMemoryResponse(approximate)).toEqual(approximate)
    expect(parsePlatformMemoryResponse(unavailable)).toEqual(unavailable)
  })

  it('没有系统容量的采样明确返回未知，不推断占比的参照总量', () => {
    const { systemTotalMb: _total, ...sample } = platformMemorySample()
    expect(parsePlatformMemoryResponse(sample).systemTotalMb).toBeNull()
    expect(parsePlatformMemoryResponse({ ...sample, systemTotalMb: null }).systemTotalMb).toBeNull()
  })

  it.each([
    { rssSource: 'unknown' }, { rssMb: null }, { rssSource: 'unavailable' },
    { heapReleasedMb: NaN }, { heapRetainedMb: Infinity }, { runtimeOtherMb: -1 },
    { heapLiveMb: undefined }, { gcCount: 1.5 }, { sampledAt: '无效时间' },
    { systemTotalMb: 0 }, { systemTotalMb: -1 }, { systemTotalMb: Infinity },
  ])('拒绝含义不一致或分项无效的采样 %j', (overrides) => {
    expect(() => parsePlatformMemoryResponse({ ...platformMemorySample(), ...overrides })).toThrow('平台内存响应格式无效')
  })
})
