import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMockGateway } from '../adapters/mock/gateway'
import type { ElysianGateway, SessionAdapter } from '../contracts/adapters'
import { useSessionStore } from '../stores/sessionStore'
import { renderApp } from '../test/renderApp'

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
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false })
})

describe('RequireSession 会话闸门', () => {
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
    expect(screen.getByRole('banner')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '登录 Elysian' })).not.toBeInTheDocument()
  })
})
