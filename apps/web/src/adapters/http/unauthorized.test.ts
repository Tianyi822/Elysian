import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  reportUnauthorized,
  reportUnauthorizedStatus,
  setUnauthorizedListener,
} from './unauthorized'

/*
 * 共享 401 拦截的单元语义：401 上报监听（每个 401 恰好一次），非 401 不上报。
 * 监听是模块级单例，用例之间重置为 noop，避免串到其他模块注册的监听。
 */

afterEach(() => {
  setUnauthorizedListener(() => {})
})

describe('reportUnauthorized', () => {
  it('401 响应上报监听一次并回 true', () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    const response = new Response('{"error":"未登录或会话已过期"}', { status: 401 })
    expect(reportUnauthorized(response)).toBe(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('多个 401 响应各自上报一次，不合并也不去重', () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    reportUnauthorized(new Response('', { status: 401 }))
    reportUnauthorized(new Response('', { status: 401 }))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('非 401（200、403、429、500、503）不上报并回 false', () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    for (const status of [200, 403, 429, 500, 503]) {
      expect(reportUnauthorized(new Response('', { status }))).toBe(false)
    }
    expect(listener).not.toHaveBeenCalled()
  })

  it('后注册的监听覆盖前者（单例语义）', () => {
    const first = vi.fn()
    const second = vi.fn()
    setUnauthorizedListener(first)
    setUnauthorizedListener(second)
    reportUnauthorized(new Response('', { status: 401 }))
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('reportUnauthorizedStatus', () => {
  it('XHR/SSE 等只有状态号的出口同样只对 401 上报', () => {
    const listener = vi.fn()
    setUnauthorizedListener(listener)
    expect(reportUnauthorizedStatus(401)).toBe(true)
    expect(reportUnauthorizedStatus(200)).toBe(false)
    expect(reportUnauthorizedStatus(403)).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
