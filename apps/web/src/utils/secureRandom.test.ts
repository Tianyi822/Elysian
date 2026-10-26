import { afterEach, describe, expect, it, vi } from 'vitest'
import { secureRandomInt, secureRandomString } from './secureRandom'

afterEach(() => vi.unstubAllGlobals())

function stubCrypto(values: number[]) {
  const remaining = [...values]
  vi.stubGlobal('crypto', {
    getRandomValues(array: Uint32Array) {
      const value = remaining.shift()
      if (value === undefined) throw new Error('测试随机值不足')
      array[0] = value
      return array
    },
  })
}

describe('安全随机取值', () => {
  it('缺失 WebCrypto 时明确失败，不回退可预测随机源', () => {
    vi.stubGlobal('crypto', undefined)
    expect(() => secureRandomInt(10)).toThrow('无法生成安全随机数')
  })

  it('拒绝落在取模偏差区间的取值', () => {
    // 2^32 % 10 = 6，limit = 4294967290；0xffffffff 必须重抽。
    stubCrypto([0xffffffff, 5])
    expect(secureRandomInt(10)).toBe(5)
  })

  it('按字符表生成长度固定的字符串', () => {
    stubCrypto([0, 1, 2])
    expect(secureRandomString(3, 'abc')).toBe('abc')
  })
})
