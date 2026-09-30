import { afterEach, describe, vi } from 'vitest'
import { runSessionAdapterContract } from './sessionAdapterContract'
import { createHttpSessionAdapter } from './http/sessionHttpAdapter'
import { MockSessionAdapter } from './mock/mockAdapters'

/*
 * 契约断言集合的双实现复跑：mock（演示放行）与 http（真实 /api/auth，fetch stub 成功路径）
 * 跑同一套断言。未来换真实 gateway 实现时对同一套断言再跑一次。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MockSessionAdapter', () => {
  runSessionAdapterContract(() => new MockSessionAdapter(), 'demo')
})

describe('createHttpSessionAdapter', () => {
  runSessionAdapterContract(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ authenticated: true, devAccount: false }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    return createHttpSessionAdapter()
  }, 'real')
})
