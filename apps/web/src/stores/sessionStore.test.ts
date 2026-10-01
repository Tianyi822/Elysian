import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElysianGateway, SessionAdapter, SessionStatus } from '../contracts/adapters'
import { useSessionStore } from './sessionStore'

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
  useSessionStore.setState({ phase: 'unknown', mode: undefined, devAccount: false, notice: null, returnTo: undefined, returnToFor: undefined })
})

describe('sessionStore.probe', () => {
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

describe('sessionStore.login', () => {
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
