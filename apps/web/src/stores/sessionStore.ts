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
  /** 挂载时探测一次：authenticated → authed/anonymous；status() 抛错（服务不可达等）→ error。 */
  probe(gateway: ElysianGateway): Promise<void>
  /** 成功置 authed；失败向上抛中文错误，phase 不变。 */
  login(gateway: ElysianGateway, username: string, password: string): Promise<void>
  /** 置 anonymous（登出请求幂等，网络失败也回到登录页）。 */
  logout(gateway: ElysianGateway): Promise<void>
  /** 任意 401 到达时置 anonymous（不清 mode/devAccount）。 */
  expire(): void
}

export const useSessionStore = create<SessionStoreState>((set) => ({
  phase: 'unknown',
  mode: undefined,
  devAccount: false,

  async probe(gateway) {
    try {
      const status = await gateway.session.status()
      set({
        phase: status.authenticated ? 'authed' : 'anonymous',
        mode: status.mode,
        devAccount: status.devAccount,
      })
    } catch {
      set({ phase: 'error' })
    }
  },

  async login(gateway, username, password) {
    await gateway.session.login(username, password)
    set({ phase: 'authed' })
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
