import { act, screen, waitFor } from '@testing-library/react'
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
 * 带 returnTo 时探测未落地的首帧是「正在检查登录状态…」过渡态、全程不闪现表单；不带 returnTo 首帧仍是表单。
 */

function gatewayWithSession(session: Partial<SessionAdapter>): ElysianGateway {
  const base = createMockGateway({ eventIntervalMs: 60_000, eventStream: 'memory' })
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null, returnTo: undefined, returnToFor: undefined })
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
 * 探测在途的 session fake：status 挂起，直到 settle() 显式给出裁决值。
 * 用于把「probe 未落地的首帧」与「落地后的分支」钉在同一条用例里——
 * 表单是否只闪现一帧，只有靠这种手动放行才测得出来。
 */
function pendingProbeSession(): { session: SessionAdapter; settle: (status: SessionStatus) => void } {
  let resolve: ((status: SessionStatus) => void) | undefined
  let settled: SessionStatus | undefined
  const session: SessionAdapter = {
    ...adjudicatedSession(undefined),
    status: () =>
      new Promise<SessionStatus>((r) => {
        if (settled) r(settled)
        else resolve = r
      }),
  }
  return {
    session,
    settle(status) {
      settled = status
      resolve?.(status)
    },
  }
}

/**
 * 替换 window.location：jsdom 的 location.assign 不可重定义（vi.spyOn 抛 Cannot redefine property），
 * vi.stubGlobal 走 defineProperty 且由 afterEach 的 unstubAllGlobals 自动复原。
 * 字段按真实 location 补齐：protocol/host 是 ws adapter 拼地址的依据（缺值会静默拼出 ws://undefined），
 * replace 与 assign 同为整页跳转出口，缺值会在调用处直接抛 TypeError。
 */
function stubLocationAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn()
  vi.stubGlobal('location', {
    origin: 'http://127.0.0.1:48100',
    protocol: 'http:',
    host: '127.0.0.1:48100',
    href: 'http://127.0.0.1:48100/login',
    pathname: '/login',
    search: '',
    assign,
    replace: vi.fn(),
  })
  return assign
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null, returnTo: undefined, returnToFor: undefined })
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

  it('带 returnTo 且探测未落地：首帧不闪现表单，落地为已登录后才 assign 且全程无表单', async () => {
    const assign = stubLocationAssign()
    const { session, settle } = pendingProbeSession()
    renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A5173%2Fprojects%2F42', {
      gateway: gatewayWithSession(session),
    })
    // 探测在途：只有过渡态，表单（含「登录」按钮）一帧都不出现
    expect(screen.getByRole('status')).toHaveTextContent('正在检查登录状态…')
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()

    await act(async () => {
      settle({ mode: 'real', authenticated: true, devAccount: false, returnTo: 'http://127.0.0.1:5173/projects/42' })
    })
    expect(await screen.findByText('正在返回刚才的应用…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()
    await waitFor(() => expect(assign).toHaveBeenCalledWith('http://127.0.0.1:5173/projects/42'))
    expect(assign).toHaveBeenCalledTimes(1)
  })

  it('带 returnTo 且探测未落地：裁决为 null 时表单与被拦截提示随探测一起出现', async () => {
    const assign = stubLocationAssign()
    const { session, settle } = pendingProbeSession()
    renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A9999%2Fx', { gateway: gatewayWithSession(session) })
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()

    await act(async () => {
      settle({ mode: 'real', authenticated: false, devAccount: false, returnTo: null })
    })
    expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(screen.getByText('回跳地址不在允许名单，登录后将留在面板。')).toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
  })

  it('不带 returnTo 且探测未落地：首帧仍是表单，不新增加载帧', () => {
    const assign = stubLocationAssign()
    const { session } = pendingProbeSession()
    renderApp('/login', { gateway: gatewayWithSession(session) })
    expect(screen.getByRole('heading', { level: 1, name: '登录 Elysian' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument()
    expect(screen.queryByText('正在检查登录状态…')).not.toBeInTheDocument()
    expect(assign).not.toHaveBeenCalled()
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
    // 唯一出口在 effect：提交路径自身不再 assign，否则站内 navigate 与外站 assign 会抢同一次跳转。
    expect(assign).toHaveBeenCalledTimes(1)
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

  it('不带 returnTo 探测失败：渲染错误态与重试，不退回表单假装面板健康', async () => {
    const gateway = gatewayWithSession({
      ...anonymousSession(),
      status: vi.fn(async () => {
        throw new Error('登录状态检查失败：面板服务不可达')
      }),
    })
    renderApp('/login', { gateway })
    expect(await screen.findByText('登录状态检查失败')).toBeInTheDocument()
    expect(screen.getByText('无法连接面板服务，请确认服务已启动。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    // 错误态下表单整帧不出现（不呈现「像健康」的登录框）。
    expect(screen.queryByRole('heading', { level: 1, name: '登录 Elysian' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()
  })

  it('带 returnTo 探测失败：同一故障同一呈现，也是错误态而非表单', async () => {
    const gateway = gatewayWithSession({
      ...anonymousSession(),
      status: vi.fn(async () => {
        throw new Error('登录状态检查失败：面板服务不可达')
      }),
    })
    renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A5173%2Fx', { gateway })
    expect(await screen.findByText('登录状态检查失败')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '登录' })).not.toBeInTheDocument()
  })

  it('错误态点重试且探测成功：恢复正常分支（未登录回到表单）', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const gateway = gatewayWithSession({
      ...anonymousSession(),
      status: vi.fn(async (): Promise<SessionStatus> => {
        attempts += 1
        if (attempts === 1) throw new Error('登录状态检查失败：面板服务不可达')
        return { mode: 'real', authenticated: false, devAccount: false }
      }),
    })
    renderApp('/login', { gateway })
    expect(await screen.findByText('登录状态检查失败')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { level: 1, name: '登录 Elysian' })).toBeInTheDocument()
    // 首帧探测一次失败、重试再一次，共两次——没有隐藏的重复探测。
    await waitFor(() => expect(attempts).toBe(2))
  })

  it('错误态重试沿用同一个 returnTo 参数', async () => {
    const user = userEvent.setup()
    let attempts = 0
    const seen: (string | undefined)[] = []
    const gateway = gatewayWithSession({
      ...anonymousSession(),
      status: vi.fn(async (returnTo?: string): Promise<SessionStatus> => {
        attempts += 1
        seen.push(returnTo)
        if (attempts === 1) throw new Error('登录状态检查失败：面板服务不可达')
        return { mode: 'real', authenticated: false, devAccount: false, returnTo: returnTo ?? null }
      }),
    })
    renderApp('/login?returnTo=http%3A%2F%2F127.0.0.1%3A5173%2Fx', { gateway })
    expect(await screen.findByText('登录状态检查失败')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(screen.getByText('登录后将返回 http://127.0.0.1:5173')).toBeInTheDocument())
    // 两次探测都带同一个原始地址，不是重试时把它丢了。
    expect(seen).toEqual(['http://127.0.0.1:5173/x', 'http://127.0.0.1:5173/x'])
  })

  // 裁决必须绑回它裁决的那次请求：warm store 里那条裁决若不是本次 URL 的 returnTo，就当尚未裁决——
  // 重探、期间不跳转。下面两条钉住「换地址进来不会误跳上一个工具」「空手进来不会沿用陈旧裁决」。
  it('warm store 持有 X 的裁决，带 ?returnTo=Y 进入：以 Y 重探、送去 Y 且从不送去 X', async () => {
    const assign = stubLocationAssign()
    const X = 'http://127.0.0.1:5173/x'
    const Y = 'http://127.0.0.1:8080/y'
    // 服务端只裁决当前请求的地址：收到 Y 回 Y，收到别的回 null。
    const status = vi.fn(async (returnTo?: string): Promise<SessionStatus> => ({
      mode: 'real',
      authenticated: true,
      devAccount: false,
      returnTo: returnTo === Y ? Y : null,
    }))
    const gateway = gatewayWithSession({ ...adjudicatedSession(X, { authenticated: true }), status })
    // 预热：上一轮把 X 裁决成可用、浏览器已登录（phase 非 unknown），store 挂着 X 的裁决。
    useSessionStore.setState({ phase: 'authed', mode: 'real', returnTo: X, returnToFor: X })
    renderApp(`/login?returnTo=${encodeURIComponent(Y)}`, { gateway })
    // 必须带新地址 Y 再问一次，而不是拿旧裁决直接跳。
    await waitFor(() => expect(status).toHaveBeenCalledWith(Y))
    await waitFor(() => expect(assign).toHaveBeenCalledWith(Y))
    expect(assign).not.toHaveBeenCalledWith(X)
  })

  it('warm store 持有 X 的裁决，空手进入 /login：清掉陈旧裁决、绝不把浏览器送去 X', async () => {
    const assign = stubLocationAssign()
    const X = 'http://127.0.0.1:5173/x'
    // 无 returnTo 参数时服务端不回答裁决（真实形状）：status 收到 undefined 就回 undefined。
    const status = vi.fn(async (returnTo?: string): Promise<SessionStatus> => ({
      mode: 'real',
      authenticated: true,
      devAccount: false,
      returnTo: returnTo === undefined ? undefined : null,
    }))
    const gateway = gatewayWithSession({ ...adjudicatedSession(X, { authenticated: true }), status })
    useSessionStore.setState({ phase: 'authed', mode: 'real', returnTo: X, returnToFor: X })
    const { router } = renderApp('/login', { gateway })
    // 已登录且无参数：按站内路径回落首页；store 里挂着的 X 从不外送。
    await waitFor(() => expect(router.state.location.pathname).toBe('/'))
    expect(assign).not.toHaveBeenCalled()
    expect(useSessionStore.getState().returnToFor).toBeUndefined()
  })
})
