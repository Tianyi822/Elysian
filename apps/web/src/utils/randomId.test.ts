import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomId } from './randomId'

afterEach(() => vi.unstubAllGlobals())

describe('浏览器请求标识', () => {
  it('安全上下文沿用浏览器的原生 UUID', () => {
    const native = vi.fn(() => '00000000-0000-4000-8000-000000000001')
    vi.stubGlobal('crypto', { randomUUID: native })
    expect(randomId()).toBe('00000000-0000-4000-8000-000000000001')
    expect(native).toHaveBeenCalledOnce()
  })
  it('HTTP IP 环境用安全随机字节生成不同的合法 UUID v4', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    const ids = Array.from({ length: 100 }, randomId)
    expect(new Set(ids).size).toBe(100)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
  it('无安全随机源时明确报错，不使用可预测的标识', () => {
    vi.stubGlobal('crypto', undefined)
    expect(randomId).toThrow('当前浏览器无法生成安全请求标识')
  })
  it('原生 UUID 存在但抛错时仍使用安全随机字节', () => {
    const getRandomValues = crypto.getRandomValues.bind(crypto)
    vi.stubGlobal('crypto', { randomUUID: () => { throw new DOMException('blocked', 'SecurityError') }, getRandomValues })
    expect(randomId()).toMatch(/^[0-9a-f-]{14}4[0-9a-f-]{21}$/)
  })
  it('安全随机字节接口被拒绝时给出中文错误', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => { throw new DOMException('blocked', 'SecurityError') } })
    expect(randomId).toThrow('当前浏览器无法生成安全请求标识')
  })
})
