import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { GatewayProvider } from '../adapters/GatewayProvider'
import { createMockGateway } from '../adapters/mock/gateway'
import { createHttpSessionAdapter } from '../adapters/http/sessionHttpAdapter'
import type { ElysianGateway, SessionAdapter } from '../contracts/adapters'
import { useSessionStore } from '../stores/sessionStore'
import { renderApp } from '../test/renderApp'
import { RequireSession } from './RequireSession'
import { RequireArea } from './RequireArea'

/*
 * 会话闸门组件：unknown → 加载态；探测抛错 → 错误态且「重试」可重跑 probe；
 * anonymous + real → 重定向 /login 且 state.from 记住来源路径；demo 与 authed → 直接渲染 children。
 * 注入的 fake session 以真实 mock 网关为底、只替换 session 片。
 */

function gatewayWithSession(session: Partial<SessionAdapter>): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  // 注入的 fake session 是事实源：底座装配会同步落位演示放行，这里重置回 unknown 再交 probe。
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false })
  return { ...base, session: session as SessionAdapter }
}

beforeEach(() => {
  useSessionStore.getState().expire()
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false })
})

describe('RequireSession 后台会话检查', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function renderGate(status: SessionAdapter['status']) {
    const gateway = gatewayWithSession({ status })
    await act(async () => {
      render(
        <GatewayProvider gateway={gateway}>
          <MemoryRouter initialEntries={['/private']}>
            <Routes>
              <Route path="/private" element={<RequireSession><p>管理页面</p></RequireSession>} />
              <Route path="/login" element={<h1>重新登录</h1>} />
            </Routes>
          </MemoryRouter>
        </GatewayProvider>,
      )
    })
  }

  it('静止页面在下一轮检查发现失效后返回登录页，并停止轮询', async () => {
    vi.useFakeTimers()
    const status = vi.fn<SessionAdapter['status']>()
      .mockResolvedValueOnce({ mode: 'real', authenticated: true, devAccount: true })
      .mockResolvedValue({ mode: 'real', authenticated: false, devAccount: true })
    await renderGate(status)
    expect(screen.getByText('管理页面')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
    expect(screen.getByRole('heading', { name: '重新登录' })).toBeInTheDocument()
    expect(status).toHaveBeenLastCalledWith(undefined, { passive: true })
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('后台标签页暂停检查，切回时立即检查，在途请求不重复发送', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    let resolve!: (status: Awaited<ReturnType<SessionAdapter['status']>>) => void
    const status = vi.fn<SessionAdapter['status']>()
      .mockResolvedValueOnce({ mode: 'real', authenticated: true, devAccount: true })
      .mockImplementation(() => new Promise((done) => { resolve = done }))
    await renderGate(status)
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(status).toHaveBeenCalledTimes(1)
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    fireEvent(window, new Event('focus'))
    fireEvent(window, new Event('online'))
    expect(status).toHaveBeenCalledTimes(2)
    await act(async () => { resolve({ mode: 'real', authenticated: false, devAccount: true }) })
    expect(screen.getByRole('heading', { name: '重新登录' })).toBeInTheDocument()
    fireEvent(window, new Event('focus'))
    expect(status).toHaveBeenCalledTimes(2)
  })
})

describe('RequireSession 会话闸门', () => {
  it('StrictMode 刷新只发一次登录探测，页面权限检查不会额外请求会话', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ authenticated: true, devAccount: true }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const gateway = gatewayWithSession(createHttpSessionAdapter())
      render(<StrictMode><GatewayProvider gateway={gateway}><MemoryRouter>
        <RequireSession><RequireArea area="dashboard" title="仪表盘"><p>已鉴权的仪表盘</p></RequireArea></RequireSession>
      </MemoryRouter></GatewayProvider></StrictMode>)
      expect(await screen.findByText('已鉴权的仪表盘')).toBeInTheDocument()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { cache: 'no-store', signal: expect.any(AbortSignal) })
      expect(screen.queryByText(/无权限查看/)).not.toBeInTheDocument()
    } finally { vi.unstubAllGlobals() }
  })

  it('明确未登录时单管理员页面策略也不能绕过会话闸门', async () => {
    const canView = vi.fn(async () => true)
    const gateway = gatewayWithSession({
      status: async () => ({ mode: 'real', authenticated: false, devAccount: true }), canView,
    })
    render(<GatewayProvider gateway={gateway}><MemoryRouter initialEntries={['/agent']}><Routes>
      <Route path="/agent" element={<RequireSession><RequireArea area="agent" title="Ely"><p>私人会话内容</p></RequireArea></RequireSession>} />
      <Route path="/login" element={<h1>重新登录</h1>} />
    </Routes></MemoryRouter></GatewayProvider>)
    expect(await screen.findByRole('heading', { name: '重新登录' })).toBeInTheDocument()
    expect(canView).not.toHaveBeenCalled()
    expect(screen.queryByText('私人会话内容')).not.toBeInTheDocument()
  })

  it('探测期间渲染加载态（正在检查登录状态…）', () => {
    const never = new Promise<never>(() => {})
    const gateway = gatewayWithSession({
      status: () => never,
    })
    renderApp('/', { gateway })
    expect(screen.getByRole('status')).toHaveTextContent('正在检查登录状态…')
  })

  it('探测抛错渲染错误态，「重试」重新跑一次探测', async () => {
    let calls = 0
    const user = userEvent.setup()
    const gateway = gatewayWithSession({
      status: async () => {
        calls += 1
        if (calls === 1) throw new Error('登录状态检查失败：面板服务不可达')
        return { mode: 'real', authenticated: true, devAccount: false }
      },
    })
    renderApp('/', { gateway })

    expect(await screen.findByRole('alert')).toHaveTextContent('登录状态检查失败')
    await user.click(screen.getByRole('button', { name: '重试' }))
    // 重试成功后闸门放行，仪表盘出现。
    expect(await screen.findByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
    expect(calls).toBe(2)
  })

  it('真实模式未登录重定向 /login，state.from 记住来源路径与查询串', async () => {
    const gateway = gatewayWithSession({
      status: async () => ({ mode: 'real', authenticated: false, devAccount: false }),
    })
    const { router } = renderApp('/logs?tab=login', { gateway })

    expect(await screen.findByRole('heading', { level: 1, name: '登录 Elysian' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/login')
    expect((router.state.location.state as { from?: string } | null)?.from).toBe('/logs?tab=login')
  })

  it('真实模式已登录渲染 children（仪表盘可达）', async () => {
    const gateway = gatewayWithSession({
      status: async () => ({ mode: 'real', authenticated: true, devAccount: false }),
    })
    renderApp('/', { gateway })
    expect(await screen.findByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
  })

  it('演示模式（本地无后端）不强制登录：mock 网关首屏即渲染外壳', () => {
    renderApp('/')
    expect(screen.getByRole('navigation', { name: '主导航' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '登录 Elysian' })).not.toBeInTheDocument()
  })
})
