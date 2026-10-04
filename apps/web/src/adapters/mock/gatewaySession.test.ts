import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from './gateway'
import { MockFilesAdapter, MockSessionAdapter } from './mockAdapters'

/*
 * gateway 会话片的分流断言：缺省与显式 'mock' 都是演示放行（不强制登录），
 * 'http' 才换真实 /api/auth adapter——防「GatewayProvider 接线漏改导致唯一真实运行时拿不到会话」的回归。
 */

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createMockGateway 会话片分流', () => {
  it('缺省装配：会话是演示放行实现', async () => {
    const gateway = createMockGateway({ eventStream: 'memory' })
    expect(gateway.session).toBeInstanceOf(MockSessionAdapter)
    await expect(gateway.session.status()).resolves.toEqual({
      mode: 'demo',
      authenticated: true,
      devAccount: false,
    })
  })

  it("显式 session: 'mock' 与缺省同款", () => {
    const gateway = createMockGateway({ eventStream: 'memory', session: 'mock' })
    expect(gateway.session).toBeInstanceOf(MockSessionAdapter)
  })

  it("session: 'http' 只把会话换成 HTTP adapter，其余片不受影响", () => {
    const gateway = createMockGateway({ eventStream: 'memory', session: 'http' })
    expect(gateway.session).not.toBeInstanceOf(MockSessionAdapter)
    expect(gateway.files).toBeInstanceOf(MockFilesAdapter)
  })

  it("session: 'http'：探测落到同源 /api/auth/session", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ authenticated: false, devAccount: false }), {
          headers: { 'content-type': 'application/json' },
        }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const gateway = createMockGateway({ eventStream: 'memory', session: 'http' })

    expect(await gateway.session.status()).toEqual({
      mode: 'real',
      authenticated: false,
      devAccount: false,
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { cache: 'no-store', signal: expect.any(AbortSignal) })
  })
})
