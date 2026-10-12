import { create } from 'zustand'
import type { ElysianGateway, SessionMode } from '../contracts/adapters'
import { setUnauthorizedListener } from '../adapters/http/unauthorized'
import { useAgentChatStore } from './agentChatStore'

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
   * 只有登录页读它并据此离开 SPA。它回答的是「服务端最近裁决了什么」，
   * 是否与当前请求同一条由 `returnToFor` 判定，二者一起才构成「这次 ?returnTo= 的裁决」。
   */
  returnTo: string | null | undefined
  /**
   * `returnTo` 这次裁决所对应的**请求值**（probe 的第二个入参原样记录）：
   * 登录页据此判断裁决是否属于当前 URL 上的 `?returnTo=`，不等即视为「尚未裁决」——重探、期间不跳转也不显示裁决派生提示。
   * 这是把裁决绑回它裁决的那次请求，不在前端做 origin 比对或再裁决（客户端不得参与安全判定）。
   */
  returnToFor: string | undefined
  /**
   * 一次性提示（如改密成功或后台检查发现会话失效），login() 成功清除。
   * probe/logout/expire 不触碰它，后台失效提示不覆盖已有的改密提示。
   */
  notice: string | null
  setNotice(text: string | null): void
  /** 挂载时探测一次：authenticated → authed/anonymous；status() 抛错（服务不可达等）→ error。带 returnTo 时同时取回裁决值。 */
  probe(gateway: ElysianGateway, returnTo?: string): Promise<void>
  /** 静默检查已登录会话；失效时退出，网络故障保留页面，后台检查不延长空闲期限。 */
  revalidate(gateway: ElysianGateway): Promise<void>
  /** 成功置 authed 并清除一次性提示；失败向上抛中文错误，phase 不变。 */
  login(gateway: ElysianGateway, username: string, password: string): Promise<void>
  /** 置 anonymous（登出请求幂等，网络失败也回到登录页）。 */
  logout(gateway: ElysianGateway): Promise<void>
  /** 任意 401 到达时置 anonymous（不清 mode/devAccount 与 notice）。 */
  expire(): void
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  phase: 'unknown',
  mode: undefined,
  devAccount: false,
  returnTo: undefined,
  returnToFor: undefined,
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
        // 把请求值一并记下：登录页据此确认这条裁决就是它这次 ?returnTo= 的答案，而非上一次请求的残留。
        returnToFor: returnTo,
      })
    } catch {
      set({ phase: 'error' })
    }
  },

  async revalidate(gateway) {
    const current = get()
    if (current.phase !== 'authed' || current.mode !== 'real') return
    try {
      const status = await gateway.session.status(undefined, { passive: true })
      // 请求期间发生登出、新登录或其他会话状态变化时，丢弃旧响应。
      if (get() !== current || status.authenticated) return
      set({ phase: 'anonymous', notice: current.notice ?? '登录状态已失效，请重新登录' })
    } catch {
      // 暂时断网不等同于会话失效，下一轮检查继续确认；实际 API 仍由服务端鉴权。
    }
  },

  async login(gateway, username, password) {
    await gateway.session.login(username, password)
    // 只有成功的新登录开启新会话；普通页面恢复、状态探测与失败登录保留本地对话。
    void useAgentChatStore.getState().newSession()
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
