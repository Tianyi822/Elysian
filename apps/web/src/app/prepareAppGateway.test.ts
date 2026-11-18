import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultGateway } from '../adapters/GatewayProvider'
import { useSessionStore } from '../stores/sessionStore'
import { prepareAppGateway } from './prepareAppGateway'

beforeEach(() => {
  useSessionStore.getState().expire()
  useSessionStore.setState(useSessionStore.getInitialState())
})
afterEach(() => vi.unstubAllGlobals())

describe('应用会话初始化', () => {
  it('构造演示 Gateway 不写会话，启动入口在渲染前经 adapter 读取演示身份', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    createDefaultGateway(false)
    expect(useSessionStore.getState().phase).toBe('unknown')
    await prepareAppGateway(false)
    expect(useSessionStore.getState()).toMatchObject({ phase: 'authed', mode: 'demo', username: 'admin' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('正式模式把首读留给会话闸门，不预设身份', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await prepareAppGateway(true)
    expect(useSessionStore.getState()).toMatchObject({ phase: 'unknown', username: undefined })
    expect(fetch).not.toHaveBeenCalled()
  })
})
