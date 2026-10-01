import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockGateway } from '../../adapters/mock/gateway'
import type { ElysianGateway, SessionAdapter, SessionStatus } from '../../contracts/adapters'
import { useSessionStore } from '../../stores/sessionStore'
import { renderApp } from '../../test/renderApp'

/*
 * 登录页：label 关联、空提交不发包、错误显示在 role="alert"、成功后按 from 回跳
 * （// 与 /\ 视为外站回落 /）、devAccount 提示出现/不出现、已登录访问 /login 重定向、
 * store 一次性提示（改密后需重新登录）在表单上方展示且登录成功即清除。
 * 注入的 fake session 是事实源：装配 mock 底座后重置会话 store（底座会同步落位演示放行）。
 * 回跳闭环按服务端裁决的三态分支：字符串=可用（离开 SPA 走 location.assign，只回显 origin）、
 * null=被拦截（提示后留在站内）、undefined=服务端未回答（不外跳，含演示模式与不带参数的老行为）。
 */

function gatewayWithSession(session: Partial<SessionAdapter>): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null, returnTo: undefined })
  return { ...base, session: session as SessionAdapter }
}

/**
 * 匿名会话的 fake：login 成功后 status 变为已登录（对齐真实语义——登录成功即下发
 * 有效会话 Cookie，后续探测回 authenticated:true），logout 再置回匿名。
 */
function anonymousSession(loginImpl?: (username: string, password: string) => void): SessionAdapter {
  let authenticated = false
  return {
    canView: async () => true,
    status: async () => ({ mode: 'real', authenticated, devAccount: false }),
    login: async (username, password) => {
      loginImpl?.(username, password)
      authenticated = true
    },
    logout: async () => {
      authenticated = false
    },
    listSessions: async () => [
      { createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-01T00:00:00.000Z', current: true },
      { createdAt: '2025-12-30T00:00:00.000Z', lastUsedAt: '2025-12-31T00:00:00.000Z', current: false },
    ],
    changePassword: async () => {
      throw new Error('演示模式不支持修改面板密码')
    },
    logoutOtherSessions: async () => {},
  }
}

/**
 * 带服务端回跳裁决的 session fake：status 原样回答裁决值，login 成功后转已登录。
 * authenticated 初值可控，用于「已登录直接回跳」与「登录后回跳」两条路径。
 */
function adjudicatedSession(
  returnTo: string | null | undefined,
  options: { authenticated?: boolean } = {},
): SessionAdapter {
  let authenticated = options.authenticated ?? false
  return {
    canView: async () => true,
    status: async () => ({ mode: 'real', authenticated, devAccount: false, returnTo }),
    login: async () => {
      authenticated = true
    },
    logout: async () => {
      authenticated = false
    },
    listSessions: async () => [{ createdAt: '2026-01-01T00:00:00.000Z', lastUsedAt: '2026-01-01T00:00:00.000Z', current: true }],
    changePassword: async () => {
      throw new Error('演示模式不支持修改面板密码')
    },
    logoutOtherSessions: async () => {},
  }
}

/**
 * 替换 window.location：jsdom 的 location.assign 不可重定义（vi.spyOn 抛 Cannot redefine property），
 * vi.stubGlobal 走 defineProperty 且由 afterEach 的 unstubAllGlobals 自动复原。
 */
function stubLocationAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn()
  vi.stubGlobal('location', {
    origin: 'http://127.0.0.1:48100',
    href: 'http://127.0.0.1:48100/login',
    pathname: '/login',
    search: '',
    assign,
  })
  return assign
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null, returnTo: undefined })
})

describe('LoginPage', () => {
  it('用户名与密码输入框有 label 关联，密码框不回显', async () => {
    renderApp('/login', { gateway: gatewayWithSession(anonymousSession()) })
    const username = await screen.findByLabelText('用户名')
    const password = screen.getByLabelText('密码')
    expect(username).toHaveAttribute('type', 'text')
    expect(username).toHaveAttribute('autocomplete', 'username')
    expect(password).toHaveAttribute('type', 'password')
    expect(password).toHaveAttribute('autocomplete', 'current-password')
  })

  it('空提交不发起登录请求，也不显示错误', async () => {
    const login = vi.fn(async () => {})
    const user = userEvent.setup()
    renderApp('/login', { gateway: gatewayWithSession(anonymousSession(login)) })

    await user.click(await screen.findByRole('button', { name: '登录' }))
    // 原生表单校验拦下空值：login 未被调、没有 alert。
    await waitFor(() => expect(screen.getByRole('button', { name: '登录' })).toBeEnabled())
    expect(login).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('登录失败把服务端中文错误显示在 role="alert"', async () => {
    const user = userEvent.setup()
    renderApp('/login', {
      gateway: gatewayWithSession(
        anonymousSession(() => {
          throw new Error('用户名或密码错误')
        }),
      ),
    })

    await user.type(await screen.findByLabelText('用户名'), 'admin')
    await user.type(screen.getByLabelText('密码'), 'wrong')
    await user.click(screen.getByRole('button', { name: '登录' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('用户名或密码错误')
    // 失败后表单可再次提交（登录中状态解除）。
    expect(screen.getByRole('button', { name: '登录' })).toBeEnabled()
  })

  it('登录成功回跳来源路径（含查询串）', async () => {
    const user = userEvent.setup()
    const gateway = gatewayWithSession(anonymousSession())
    const { router } = renderApp('/login', {
      gateway,
      // 预置来源：模拟 RequireSession 重定向时写入的 state。
    })
    // 先到达登录页，再以带 from 的 state 重新进入。
    await screen.findByRole('heading', { level: 1, name: '登录 Elysian' })
    await router.navigate('/login', { state: { from: '/docker?view=list' } })

    await user.type(screen.getByLabelText('用户名'), 'admin')
    await user.type(screen.getByLabelText('密码'), 'secret')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(router.state.location.pathname).toBe('/docker'))
    expect(router.state.location.search).toBe('?view=list')
  })

  it('from 为 // 与 /\\ 的外站形态一律回落首页', async () => {
    for (const evil of ['//evil.example', '/\\evil.example']) {
      const user = userEvent.setup()
      const gateway = gatewayWithSession(anonymousSession())
      const view = renderApp('/login', { gateway })
      await screen.findByRole('heading', { level: 1, name: '登录 Elysian' })
      await view.router.navigate('/login', { state: { from: evil } })

      await user.type(screen.getByLabelText('用户名'), 'admin')
      await user.type(screen.getByLabelText('密码'), 'secret')
      await user.click(screen.getByRole('button', { name: '登录' }))

      await waitFor(() => expect(view.router.state.location.pathname).toBe('/'))
      view.unmount()
    }
  })

  it('devAccount 为 true 时显示开发固定账号提示', async () => {
    renderApp('/login', {
      gateway: gatewayWithSession({
        ...anonymousSession(),
        status: async () => ({ mode: 'real', authenticated: false, devAccount: true }),
      }),
    })
    expect(await screen.findByText(/开发模式已启用固定账号：dev \/ dev-elysian/)).toBeInTheDocument()
  })

  it('devAccount 为 false 时不显示开发账号提示', async () => {
    renderApp('/login', { gateway: gatewayWithSession(anonymousSession()) })
    await screen.findByRole('heading', { level: 1, name: '登录 Elysian' })
    expect(screen.queryByText(/开发模式已启用固定账号/)).not.toBeInTheDocument()
  })

  it('已登录（probe 为 authed）访问 /login 直接回首页', async () => {
    renderApp('/login', {
      gateway: gatewayWithSession({
        canView: async () => true,
        status: async () => ({ mode: 'real', authenticated: true, devAccount: false }),
        login: async () => {},
        logout: async () => {},
      }),
    })
    expect(await screen.findByRole('heading', { level: 1, name: '仪表盘' })).toBeInTheDocument()
  })

  it('store 携带一次性提示时，登录页在表单上方以 role="status" 展示，且与开发账号提示互不排斥', async () => {
    const gateway = gatewayWithSession({
      ...anonymousSession(),
      status: async () => ({ mode: 'real', authenticated: false, devAccount: true }),
    })
    useSessionStore.setState({ notice: '密码已修改，请使用新密码重新登录' })
    renderApp('/login', { gateway })

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('密码已修改，请使用新密码重新登录')
    expect(screen.getByText(/开发模式已启用固定账号：dev \/ dev-elysian/)).toBeInTheDocument()
    expect(screen.getByLabelText('用户名')).toBeInTheDocument()
  })

  it('没有一次性提示时不渲染提示行', async () => {
    renderApp('/login', { gateway: gatewayWithSession(anonymousSession()) })
    await screen.findByRole('heading', { level: 1, name: '登录 Elysian' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('登录成功后清除一次性提示', async () => {
    const gateway = gatewayWithSession(anonymousSession())
    useSessionStore.setState({ notice: '密码已修改，请使用新密码重新登录' })
    const user = userEvent.setup()
    renderApp('/login', { gateway })

    await screen.findByRole('status')
    await user.type(await screen.findByLabelText('用户名'), 'admin')
    await user.type(screen.getByLabelText('密码'), 'new-secret')
    await user.click(screen.getByRole('button', { name: '登录' }))

    await waitFor(() => expect(useSessionStore.getState().notice).toBeNull())
    expect(useSessionStore.getState().phase).toBe('authed')
  })

  it('已登录且服务端裁决通过：渲染过渡态并 assign 回来源应用，不出现表单', async () => {
    const assign = stubLocationAssign()
    renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A5173%2Fprojects%2F42', {
      gateway: gatewayWithSession(adjudicatedSession('http://127.0.0.1:5173/projects/42', { authenticated: true })),
    })
    expect(await screen.findByText('正在返回刚才的应用…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5173/projects/42'))
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('未登录且裁决通过：只回显 origin，登录成功后 assign 且不做站内导航', async () => {
    const assign = stubLocationAssign()
    const user = userEvent.setup()
    const { router } = renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A5173%2Fprojects%2F42', {
      gateway: gatewayWithSession(adjudicatedSession('http://127.0.0.1:5173/projects/42')),
    })
    expect(await screen.findByText('登录后将返回 http://127.0.0.1:5173')).toBeInTheDocument()
    await user.type(screen.getByLabelText('用户名'), 'admin')
    await user.type(screen.getByLabelText('密码'), 'right-password')
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5173/projects/42'))
    expect(router.state.location.pathname).toBe('/login')
  })

  it('带 returnTo 但裁决为 null：显示被拦截提示，登录后留在站内', async () => {
    const assign = stubLocationAssign()
    const user = userEvent.setup()
    const { router } = renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A9999%2Fx', {
      gateway: gatewayWithSession(adjudicatedSession(null)),
    })
    expect(await screen.findByText('回跳地址不在允许名单，登录后将留在面板。')).toBeInTheDocument()
    await user.type(screen.getByLabelText('用户名'), 'admin')
    await user.type(screen.getByLabelText('密码'), 'right-password')
    await user.click(screen.getByRole('button', { name: '登录' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(assign).not.toHaveBeenCalled()
  })

  it('已登录但裁决为 null：按站内路径回落首页，不外跳', async () => {
    const assign = stubLocationAssign()
    renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A9999%2Fx', {
      gateway: gatewayWithSession(adjudicatedSession(null, { authenticated: true })),
    })
    await waitFor(() => expect(useSessionStore.getState().phase).toBe('authed'))
    expect(assign).not.toHaveBeenCalled()
  })

  it('不带 returnTo 时行为不变：已登录回首页、不呈现任何回跳提示、不 assign', async () => {
    const assign = stubLocationAssign()
    const { router } = renderApp('/login', {
      gateway: gatewayWithSession(adjudicatedSession(undefined, { authenticated: true })),
    })
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(screen.queryByText(/登录后将返回/)).not.toBeInTheDocument()
    expect(screen.queryByText(/回跳地址不在允许名单/)).not.toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('演示模式带 returnTo 也不外跳（mock 不回答裁决值）', async () => {
    const assign = stubLocationAssign()
    const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
    renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A5173%2Fx', { gateway: base })
    await waitFor(() => expect(useSessionStore.getState().mode).toBe('demo'))
    expect(assign).not.toHaveBeenCalled()
  })

  it('回跳地址只在探测请求里交给服务端，本组件不参与判定', async () => {
    // 裁决值只在收到原始参数时才回可用：页面漏传参数或改传字面量都会退化成被拦截提示。
    const status = vi.fn(async (returnTo?: string): Promise<SessionStatus> => ({
      mode: 'real',
      authenticated: false,
      devAccount: false,
      returnTo: returnTo === 'http://127.0.0.1:5173/projects/42' ? returnTo : null,
    }))
    renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A5173%2Fprojects%2F42', {
      gateway: gatewayWithSession({ ...adjudicatedSession(null), status }),
    })
    await waitFor(() => expect(status).toHaveBeenCalledWith('http://127.0.0.1:5173/projects/42'))
    expect(await screen.findByText('登录后将返回 http://127.0.0.1:5173')).toBeInTheDocument()
    expect(screen.queryByText('回跳地址不在允许名单，登录后将留在面板。')).not.toBeInTheDocument()
  })
})
