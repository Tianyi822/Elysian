import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElysianGateway, SessionAdapter, SessionStatus } from '../contracts/adapters'
import { useSessionStore } from './sessionStore'
import { useAgentChatStore } from './agentChatStore'
import { fetchWithSession, reportUnauthorized } from '../adapters/http/unauthorized'

/*
 * 会话 store 的状态流转：probe（authed / anonymous / 抛错落 error）、login（成功置 authed、
 * 失败向上抛且 phase 不变）、logout（无论请求成败都回到 anonymous）、expire（只动 phase）。
 * notice 是一次性提示：setNotice 置位、login 成功清除、probe/logout/expire 不触碰。
 * store 是模块级单例，每条用例前重置回 unknown。
 */

function gatewayWithSession(session: Partial<SessionAdapter>): ElysianGateway {
  return { session: session as SessionAdapter } as unknown as ElysianGateway
}

function statusOf(partial: Partial<SessionStatus>): SessionStatus {
  return { mode: 'real', authenticated: false, devAccount: false, ...partial }
}

beforeEach(() => {
  useSessionStore.getState().expire()
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null, returnTo: undefined, returnToFor: undefined })
})
afterEach(() => vi.restoreAllMocks())

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('旧请求的 401 与重新登录', () => {
  it('登录前请求迟到的 401 不注销新会话，当前 401 仍会注销', async () => {
    const response = deferred<Response>()
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(response.promise)
      .mockResolvedValueOnce(new Response('', { status: 401 }))
    const oldRequest = fetchWithSession('/api/agent/sessions')
    await useSessionStore.getState().login(gatewayWithSession({ login: async () => {} }), 'dev', 'example')
    response.resolve(new Response('', { status: 401 }))
    expect(reportUnauthorized(await oldRequest)).toBe(true)
    expect(useSessionStore.getState().phase).toBe('authed')
    expect(reportUnauthorized(await fetchWithSession('/api/agent/sessions'))).toBe(true)
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })

  it('旧请求在登录进行时收到 401，不会使即将成功的登录被替代', async () => {
    const response = deferred<Response>()
    const login = deferred<void>()
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(response.promise)
    const oldRequest = fetchWithSession('/api/files')
    const loggingIn = useSessionStore.getState().login(gatewayWithSession({ login: () => login.promise }), 'dev', 'example')
    response.resolve(new Response('', { status: 401 }))
    expect(reportUnauthorized(await oldRequest)).toBe(true)
    login.resolve()
    await expect(loggingIn).resolves.toBeUndefined()
    expect(useSessionStore.getState().phase).toBe('authed')
  })

  it('登录进行期间发出的请求不能用迟到 401 注销成功后的会话', async () => {
    const response = deferred<Response>()
    const login = deferred<void>()
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(response.promise)
    const loggingIn = useSessionStore.getState().login(gatewayWithSession({ login: () => login.promise }), 'dev', 'example')
    const oldRequest = fetchWithSession('/api/files')
    login.resolve()
    await loggingIn
    response.resolve(new Response('', { status: 401 }))
    expect(reportUnauthorized(await oldRequest)).toBe(true)
    expect(useSessionStore.getState().phase).toBe('authed')
  })

  it('普通探测与后台验证不会让在途请求的真实 401 失效', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    const response = deferred<Response>()
    vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(response.promise)
    const request = fetchWithSession('/api/files')
    const gateway = gatewayWithSession({ status: async () => statusOf({ authenticated: true }) })
    await useSessionStore.getState().probe(gateway)
    await useSessionStore.getState().revalidate(gateway)
    response.resolve(new Response('', { status: 401 }))
    expect(reportUnauthorized(await request)).toBe(true)
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })
})

describe('sessionStore.probe', () => {
  it('同网关与回跳参数的在途探测共用一次请求，完成后允许重新读取', async () => {
    const response = deferred<SessionStatus>()
    const status = vi.fn<SessionAdapter['status']>().mockReturnValue(response.promise)
    const gateway = gatewayWithSession({ status })
    const first = useSessionStore.getState().probe(gateway)
    const second = useSessionStore.getState().probe(gateway)
    expect(first).toBe(second)
    expect(status).toHaveBeenCalledTimes(1)
    response.resolve(statusOf({ authenticated: true }))
    await first
    await useSessionStore.getState().probe(gateway)
    expect(status).toHaveBeenCalledTimes(2)
  })

  it('新的回跳探测覆盖旧请求，旧请求迟到时不篡改裁决', async () => {
    const old = deferred<SessionStatus>()
    const current = deferred<SessionStatus>()
    const status = vi.fn<SessionAdapter['status']>().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const gateway = gatewayWithSession({ status })
    const first = useSessionStore.getState().probe(gateway, 'http://localhost:4000/old')
    const second = useSessionStore.getState().probe(gateway, 'http://localhost:4000/current')
    current.resolve(statusOf({ authenticated: true, returnTo: 'http://localhost:4000/current' }))
    await second
    old.resolve(statusOf({ authenticated: false, returnTo: null }))
    await first
    expect(useSessionStore.getState()).toMatchObject({ phase: 'authed', returnTo: 'http://localhost:4000/current', returnToFor: 'http://localhost:4000/current' })
  })

  it('同步抛错的适配器不会留下无法重试的在途标记', async () => {
    const status = vi.fn<SessionAdapter['status']>().mockImplementationOnce(() => { throw new Error('探测失败') }).mockResolvedValue(statusOf({ authenticated: true }))
    const gateway = gatewayWithSession({ status })
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().phase).toBe('error')
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().phase).toBe('authed')
    expect(status).toHaveBeenCalledTimes(2)
  })

  it.each(['resolve', 'reject'] as const)('失效后旧探测 %s 不能重新打开页面或改成错误态', async (outcome) => {
    const response = deferred<SessionStatus>()
    const checking = useSessionStore.getState().probe(gatewayWithSession({ status: () => response.promise }))
    useSessionStore.getState().expire()
    if (outcome === 'resolve') response.resolve(statusOf({ authenticated: true }))
    else response.reject(new Error('旧请求失败'))
    await checking
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })

  it('authenticated 为 true 时落 authed，并记录 mode 与 devAccount', async () => {
    const gateway = gatewayWithSession({
      status: async () => statusOf({ mode: 'real', authenticated: true, devAccount: true }),
    })
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().phase).toBe('authed')
    expect(useSessionStore.getState().mode).toBe('real')
    expect(useSessionStore.getState().devAccount).toBe(true)
  })

  it('authenticated 为 false 时落 anonymous', async () => {
    const gateway = gatewayWithSession({
      status: async () => statusOf({ authenticated: false }),
    })
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })

  it('status() 抛错（服务不可达、坏 JSON）时落 error，不装作已登录', async () => {
    const gateway = gatewayWithSession({
      status: async () => {
        throw new Error('登录状态检查失败：面板服务不可达')
      },
    })
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().phase).toBe('error')
  })

  it('带 returnTo 探测时保存服务端裁决值，并原样把参数交给 adapter', async () => {
    const seen: (string | undefined)[] = []
    const gateway = gatewayWithSession({
      status: async (returnTo) => {
        seen.push(returnTo)
        return statusOf({ authenticated: true, returnTo: 'http://127.0.0.1:5173/x' })
      },
    })
    await useSessionStore.getState().probe(gateway, 'http://127.0.0.1:5173/x')
    expect(seen).toEqual(['http://127.0.0.1:5173/x'])
    expect(useSessionStore.getState().returnTo).toBe('http://127.0.0.1:5173/x')
  })

  it('探测记录裁决所对应的请求值，供登录页判定这条裁决属于哪次请求', async () => {
    const gateway = gatewayWithSession({ status: async () => statusOf({ authenticated: true, returnTo: 'http://127.0.0.1:5173/x' }) })
    await useSessionStore.getState().probe(gateway, 'http://127.0.0.1:5173/x')
    expect(useSessionStore.getState().returnToFor).toBe('http://127.0.0.1:5173/x')
    // 换一次请求（不同地址）探测：请求值随裁决一起更新，旧值不留存。
    await useSessionStore.getState().probe(gateway, 'http://127.0.0.1:8080/y')
    expect(useSessionStore.getState().returnToFor).toBe('http://127.0.0.1:8080/y')
  })

  it('不带参数探测时把请求值一并清成 undefined（与裁决值同形，不残留上一次）', async () => {
    useSessionStore.setState({ returnTo: 'http://127.0.0.1:5173/x', returnToFor: 'http://127.0.0.1:5173/x' })
    const gateway = gatewayWithSession({ status: async () => statusOf({ authenticated: true }) })
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().returnTo).toBeUndefined()
    expect(useSessionStore.getState().returnToFor).toBeUndefined()
  })

  it('探测抛错落 error 时既不动裁决值也不动请求值', async () => {
    useSessionStore.setState({ returnTo: 'http://127.0.0.1:5173/x', returnToFor: 'http://127.0.0.1:5173/x' })
    const gateway = gatewayWithSession({
      status: async () => {
        throw new Error('登录状态检查失败：面板服务不可达')
      },
    })
    await useSessionStore.getState().probe(gateway, 'http://127.0.0.1:9999/z')
    expect(useSessionStore.getState().phase).toBe('error')
    expect(useSessionStore.getState().returnTo).toBe('http://127.0.0.1:5173/x')
    expect(useSessionStore.getState().returnToFor).toBe('http://127.0.0.1:5173/x')
  })

  it('服务端回答 null（被拦截）时保存 null，与未回答的 undefined 可区分', async () => {
    const gateway = gatewayWithSession({ status: async () => statusOf({ authenticated: false, returnTo: null }) })
    await useSessionStore.getState().probe(gateway, 'http://evil.example')
    expect(useSessionStore.getState().returnTo).toBeNull()
  })

  it('不带参数探测时清掉旧的裁决值', async () => {
    useSessionStore.setState({ returnTo: 'http://127.0.0.1:5173/x' })
    const gateway = gatewayWithSession({ status: async () => statusOf({ authenticated: true }) })
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().returnTo).toBeUndefined()
  })

  it('expire 与 logout 都不清 returnTo（它是服务端事实，与会话有效性无关）', async () => {
    useSessionStore.setState({ returnTo: 'http://127.0.0.1:5173/x' })
    useSessionStore.getState().expire()
    expect(useSessionStore.getState().returnTo).toBe('http://127.0.0.1:5173/x')
    await useSessionStore.getState().logout(gatewayWithSession({ logout: async () => {} }))
    expect(useSessionStore.getState().returnTo).toBe('http://127.0.0.1:5173/x')
  })

  it('探测抛错落 error 时不动 returnTo', async () => {
    useSessionStore.setState({ returnTo: 'http://127.0.0.1:5173/x' })
    const gateway = gatewayWithSession({
      status: async () => {
        throw new Error('登录状态检查失败：面板服务不可达')
      },
    })
    await useSessionStore.getState().probe(gateway)
    expect(useSessionStore.getState().phase).toBe('error')
    expect(useSessionStore.getState().returnTo).toBe('http://127.0.0.1:5173/x')
  })
})

describe('sessionStore.revalidate', () => {
  it('后台校验在途复用，修改提示不妨碍有效的失效响应生效', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    const response = deferred<SessionStatus>()
    const status = vi.fn<SessionAdapter['status']>().mockReturnValue(response.promise)
    const gateway = gatewayWithSession({ status })
    const first = useSessionStore.getState().revalidate(gateway)
    const second = useSessionStore.getState().revalidate(gateway)
    expect(first).toBe(second)
    useSessionStore.getState().setNotice('请保存当前草稿')
    response.resolve(statusOf({ authenticated: false }))
    await first
    expect(status).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState()).toMatchObject({ phase: 'anonymous', notice: '请保存当前草稿' })
  })

  it('旧会话失效时退出并显示重新登录提示，保留 SSO 裁决', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real', returnTo: 'http://localhost:5173/tool' })
    const status = vi.fn(async () => statusOf({ authenticated: false }))
    await useSessionStore.getState().revalidate(gatewayWithSession({ status }))
    expect(status).toHaveBeenCalledWith(undefined, { passive: true })
    expect(useSessionStore.getState()).toMatchObject({ phase: 'anonymous', notice: '登录状态已失效，请重新登录', returnTo: 'http://localhost:5173/tool' })
  })

  it('临时网络故障保留当前页面，恢复后继续检查', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    const status = vi.fn<SessionAdapter['status']>()
      .mockRejectedValueOnce(new Error('面板服务不可达'))
      .mockResolvedValueOnce(statusOf({ authenticated: false }))
    const gateway = gatewayWithSession({ status })
    await useSessionStore.getState().revalidate(gateway)
    expect(useSessionStore.getState().phase).toBe('authed')
    await useSessionStore.getState().revalidate(gateway)
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })

  it('旧检查迟到的失效响应不能挤掉重新登录后的会话', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    let resolve!: (status: SessionStatus) => void
    const gateway = gatewayWithSession({
      status: () => new Promise((done) => { resolve = done }),
      login: async () => {},
    })
    const pending = useSessionStore.getState().revalidate(gateway)
    useSessionStore.getState().expire()
    await useSessionStore.getState().login(gateway, 'dev', 'dev-elysian')
    resolve(statusOf({ authenticated: false }))
    await pending
    expect(useSessionStore.getState()).toMatchObject({ phase: 'authed', notice: null })
  })

  it('演示模式与未登录状态不轮询，失效时不覆盖改密提示', async () => {
    const status = vi.fn(async () => statusOf({ authenticated: false }))
    const gateway = gatewayWithSession({ status })
    await useSessionStore.getState().revalidate(gateway)
    useSessionStore.setState({ phase: 'authed', mode: 'demo' })
    await useSessionStore.getState().revalidate(gateway)
    expect(status).not.toHaveBeenCalled()
    useSessionStore.setState({ mode: 'real', notice: '密码已修改，请使用新密码重新登录' })
    await useSessionStore.getState().revalidate(gateway)
    expect(useSessionStore.getState()).toMatchObject({ phase: 'anonymous', notice: '密码已修改，请使用新密码重新登录' })
  })
})

describe('sessionStore.login', () => {
  it('重新登录保留选中会话与草稿，公开内容清空后从服务端重新读取', async () => {
    await useAgentChatStore.getState().newSession()
    useAgentChatStore.getState().setDraft('下次继续编辑')
    const previous = useAgentChatStore.getState().session!
    useAgentChatStore.setState({
      messages: [{ id: 'm', sessionId: 'remote', taskId: 'task', runId: 'run', seq: '1', role: 'assistant', content: '旧公开答复', createdAt: '2026-10-13T00:00:00Z' }],
      reasoning: { run: '旧思考' },
      liveOutput: { runId: 'run', responseId: 'r', reasoning: '旧思考', content: '旧增量', done: false },
    })
    const reset = vi.spyOn(useAgentChatStore.getState(), 'newSession')
    await useSessionStore.getState().login(gatewayWithSession({ login: async () => {} }), 'dev', 'dev-elysian')
    expect(reset).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState()).toMatchObject({ session: null, messages: [], reasoning: {}, liveOutput: null })
    await useAgentChatStore.getState().ensureSession()
    expect(useAgentChatStore.getState().session).toMatchObject({ id: previous.id, draft: '下次继续编辑' })
  })

  it('登录期间旧探测不能覆盖状态，主动探测等写操作完成后退出', async () => {
    useSessionStore.setState({ phase: 'anonymous', mode: 'real' })
    const old = deferred<SessionStatus>()
    const accepted = deferred<void>()
    const status = vi.fn<SessionAdapter['status']>().mockReturnValue(old.promise)
    const gateway = gatewayWithSession({ status, login: () => accepted.promise })
    const initialProbe = useSessionStore.getState().probe(gateway)
    const login = useSessionStore.getState().login(gateway, 'admin', 'secret')
    const duringLogin = useSessionStore.getState().probe(gateway)
    old.resolve(statusOf({ authenticated: false }))
    await initialProbe
    expect(status).toHaveBeenCalledTimes(1)
    accepted.resolve()
    await Promise.all([login, duringLogin])
    expect(useSessionStore.getState().phase).toBe('authed')
    expect(status).toHaveBeenCalledTimes(1)
  })

  it('登录后立即登出按顺序提交，迟到的登录成功不能回到已登录', async () => {
    const accepted = deferred<void>()
    const logout = vi.fn(async () => {})
    const gateway = gatewayWithSession({ login: () => accepted.promise, logout })
    const login = useSessionStore.getState().login(gateway, 'admin', 'secret')
    const superseded = expect(login).rejects.toThrow('登录操作已被更新的会话操作替代')
    const signingOut = useSessionStore.getState().logout(gateway)
    expect(useSessionStore.getState().phase).toBe('anonymous')
    expect(logout).not.toHaveBeenCalled()
    accepted.resolve()
    await Promise.all([superseded, signingOut])
    expect(logout).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })

  it('登录期间收到失效通知后，旧登录响应不能重新打开页面', async () => {
    const accepted = deferred<void>()
    const login = useSessionStore.getState().login(gatewayWithSession({ login: () => accepted.promise }), 'admin', 'secret')
    const superseded = expect(login).rejects.toThrow('登录操作已被更新的会话操作替代')
    useSessionStore.getState().expire()
    accepted.resolve()
    await superseded
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })

  it('成功置 authed', async () => {
    const login = vi.fn(async () => {})
    await useSessionStore.getState().login(gatewayWithSession({ login }), 'admin', 'secret')
    expect(login).toHaveBeenCalledWith('admin', 'secret')
    expect(useSessionStore.getState().phase).toBe('authed')
  })

  it('失败向上抛中文错误且 phase 不变（仍停在 anonymous）', async () => {
    useSessionStore.setState({ phase: 'anonymous' })
    const gateway = gatewayWithSession({
      login: async () => {
        throw new Error('用户名或密码错误')
      },
    })
    await expect(useSessionStore.getState().login(gateway, 'admin', 'wrong')).rejects.toThrow(
      '用户名或密码错误',
    )
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })
})

describe('sessionStore.logout', () => {
  it('登出立即关闭页面并清空公开内容，旧探测和新探测都不能回灌', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    const accepted = deferred<void>()
    const old = deferred<SessionStatus>()
    const status = vi.fn<SessionAdapter['status']>().mockReturnValue(old.promise)
    const gateway = gatewayWithSession({ status, logout: () => accepted.promise })
    useAgentChatStore.setState({ reasoning: { run: '未登出前的思考' } })
    const oldProbe = useSessionStore.getState().probe(gateway)
    const signingOut = useSessionStore.getState().logout(gateway)
    expect(useSessionStore.getState().phase).toBe('anonymous')
    expect(useAgentChatStore.getState().reasoning).toEqual({})
    const duringLogout = useSessionStore.getState().probe(gateway)
    old.resolve(statusOf({ authenticated: true }))
    await oldProbe
    expect(useSessionStore.getState().phase).toBe('anonymous')
    accepted.resolve()
    await Promise.all([signingOut, duringLogout])
    expect(status).toHaveBeenCalledTimes(1)
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })

  it('登出未返回时的新登录等待原请求，较旧的登出不覆盖新登录', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    const accepted = deferred<void>()
    const login = vi.fn(async () => {})
    const gateway = gatewayWithSession({ logout: () => accepted.promise, login })
    const signingOut = useSessionStore.getState().logout(gateway)
    const signingIn = useSessionStore.getState().login(gateway, 'admin', 'secret')
    expect(login).not.toHaveBeenCalled()
    accepted.resolve()
    await Promise.all([signingOut, signingIn])
    expect(login).toHaveBeenCalledOnce()
    expect(useSessionStore.getState().phase).toBe('authed')
  })

  it('成功置 anonymous', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    await useSessionStore.getState().logout(gatewayWithSession({ logout: async () => {} }))
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })

  it('登出请求失败也回到 anonymous（幂等端点，不让用户卡在已登录壳里）', async () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real' })
    const gateway = gatewayWithSession({
      logout: async () => {
        throw new Error('退出登录失败：面板服务不可达')
      },
    })
    await expect(useSessionStore.getState().logout(gateway)).rejects.toThrow()
    expect(useSessionStore.getState().phase).toBe('anonymous')
  })
})

describe('sessionStore.expire', () => {
  it('任意 401 到达时只置 anonymous，不清 mode 与 devAccount', () => {
    useSessionStore.setState({ phase: 'authed', mode: 'real', devAccount: true })
    useSessionStore.getState().expire()
    expect(useSessionStore.getState()).toMatchObject({
      phase: 'anonymous',
      mode: 'real',
      devAccount: true,
    })
  })
})

describe('sessionStore.notice', () => {
  it('setNotice 置位，再置 null 清除', () => {
    useSessionStore.getState().setNotice('密码已修改，请使用新密码重新登录')
    expect(useSessionStore.getState().notice).toBe('密码已修改，请使用新密码重新登录')
    useSessionStore.getState().setNotice(null)
    expect(useSessionStore.getState().notice).toBeNull()
  })

  it('login 成功清除一次性提示', async () => {
    useSessionStore.getState().setNotice('密码已修改，请使用新密码重新登录')
    await useSessionStore.getState().login(gatewayWithSession({ login: async () => {} }), 'admin', 'new-secret')
    expect(useSessionStore.getState()).toMatchObject({ phase: 'authed', notice: null })
  })

  it('login 失败不触碰一次性提示（phase 也不变）', async () => {
    useSessionStore.getState().setNotice('密码已修改，请使用新密码重新登录')
    useSessionStore.setState({ phase: 'anonymous' })
    const gateway = gatewayWithSession({
      login: async () => {
        throw new Error('用户名或密码错误')
      },
    })
    await expect(useSessionStore.getState().login(gateway, 'admin', 'wrong')).rejects.toThrow()
    expect(useSessionStore.getState()).toMatchObject({
      phase: 'anonymous',
      notice: '密码已修改，请使用新密码重新登录',
    })
  })

  it('probe、logout、expire 都不触碰一次性提示', async () => {
    const notice = '密码已修改，请使用新密码重新登录'
    useSessionStore.getState().setNotice(notice)

    await useSessionStore.getState().probe(
      gatewayWithSession({ status: async () => statusOf({ authenticated: true }) }),
    )
    expect(useSessionStore.getState().notice).toBe(notice)

    await useSessionStore.getState().logout(gatewayWithSession({ logout: async () => {} }))
    expect(useSessionStore.getState().notice).toBe(notice)

    useSessionStore.getState().expire()
    expect(useSessionStore.getState().notice).toBe(notice)
  })
})
