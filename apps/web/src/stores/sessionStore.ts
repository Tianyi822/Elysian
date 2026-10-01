import { create } from 'zustand'
import type { ElysianGateway, SessionMode } from '../contracts/adapters'
import { setUnauthorizedListener } from '../adapters/http/unauthorized'

/**
 * 会话生命周期：unknown（探测中）→ authed / anonymous，探测请求本身失败落 error。
 * 401 到达时经 `expire()` 置 anonymous，RequireSession 随即重定向 /login；
 * mode/devAccount 保留（expire 不清它们——模式与 dev 提示是服务端事实，与会话是否有效无关）。
 */
export type SessionPhase = 'unknown' | 'authed' | 'anonymous' | 'error'

type SessionStoreState = {
  phase: SessionPhase
  mode: SessionMode | undefined
  devAccount: boolean
  /**
   * 服务端裁决过的回跳地址：字符串 = 可用、null = 被拦截、undefined = 服务端未回答（未带参数或演示模式）。
   * 只有登录页读它并据此离开 SPA。
   */
  returnTo: string | null | undefined
  /**
   * 一次性提示（如改密成功后的「需用新密码重新登录」）：唯一写点是设置页改密成功，
   * 唯一清点是 login() 成功——改密后用户只能经登录页重新进入，提示在两次登录之间保持准确。
   * probe/logout/expire 不触碰它（登出或 401 不改变「密码刚改过」这一事实）。
   */
  notice: string | null
  setNotice(text: string | null): void
  /** 挂载时探测一次：authenticated → authed/anonymous；status() 抛错（服务不可达等）→ error。带 returnTo 时同时取回裁决值。 */
  probe(gateway: ElysianGateway, returnTo?: string): Promise<void>
  /** 成功置 authed 并清除一次性提示；失败向上抛中文错误，phase 不变。 */
  login(gateway: ElysianGateway, username: string, password: string): Promise<void>
  /** 置 anonymous（登出请求幂等，网络失败也回到登录页）。 */
  logout(gateway: ElysianGateway): Promise<void>
  /** 任意 401 到达时置 anonymous（不清 mode/devAccount 与 notice）。 */
  expire(): void
}

export const useSessionStore = create<SessionStoreState>((set) => ({
  phase: 'unknown',
  mode: undefined,
  devAccount: false,
  returnTo: undefined,
  notice: null,

  setNotice(notice) {
    set({ notice })
  },

  async probe(gateway, returnTo) {
    try {
      const status = await gateway.session.status(returnTo)
      set({
        phase: status.authenticated ? 'authed' : 'anonymous',
        mode: status.mode,
        devAccount: status.devAccount,
        // 未带参数探测时 status.returnTo 为 undefined，顺带清掉旧裁决值（跨页面不残留）。
        returnTo: status.returnTo,
      })
    } catch {
      set({ phase: 'error' })
    }
  },

  async login(gateway, username, password) {
    await gateway.session.login(username, password)
    // 登录成功即消费一次性提示：它只在「密码刚改过、还没重新登录」的窗口内成立。
    set({ phase: 'authed', notice: null })
  },

  async logout(gateway) {
    try {
      await gateway.session.logout()
    } finally {
      set({ phase: 'anonymous' })
    }
  },

  expire() {
    set({ phase: 'anonymous' })
  },
}))

/*
 * 共享 401 拦截的监听在模块顶层接好：任何 http 出口上报 401 都直接落到这里，
 * adapter→store 的依赖方向在仓库有先例（mock/gateway.ts 引 useContainersStore）。
 */
setUnauthorizedListener(() => useSessionStore.getState().expire())
