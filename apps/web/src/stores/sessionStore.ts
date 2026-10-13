import { create } from 'zustand'
import type { ElysianGateway, SessionMode } from '../contracts/adapters'
import { advanceAuthGeneration, setUnauthorizedListener } from '../adapters/http/unauthorized'
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
  /** 当前登录代次的 401 到达时置 anonymous（不清 mode/devAccount 与 notice）。 */
  expire(): void
}

let sessionGeneration = 0
let authRevision = 0
let authMutation: Promise<void> | undefined
let probeRequest: { gateway: ElysianGateway; returnTo?: string; generation: number; promise: Promise<void> } | undefined
let validationRequest: { gateway: ElysianGateway; generation: number; promise: Promise<void> } | undefined
const invalidateChecks = () => { sessionGeneration += 1; probeRequest = undefined; validationRequest = undefined }

/** 登录与登出按调用顺序提交，避免迟到的 Set-Cookie 覆盖较新的会话操作。 */
function mutateAuthentication(action: () => Promise<void>): Promise<void> {
  const promise = authMutation ? authMutation.catch(() => {}).then(action) : (async () => action())()
  authMutation = promise
  void promise.finally(() => { if (authMutation === promise) authMutation = undefined }).catch(() => {})
  return promise
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

  probe(gateway, returnTo) {
    if (probeRequest?.gateway === gateway && probeRequest.returnTo === returnTo && probeRequest.generation === sessionGeneration) return probeRequest.promise
    const generation = ++sessionGeneration
    if (get().phase === 'error') set({ phase: 'unknown' })
    const promise = (async () => {
      try {
        // 鉴权写操作结束后才读取 Cookie；成功登录或登出会使这次旧探测失效。
        if (authMutation) await authMutation.catch(() => {})
        if (generation !== sessionGeneration) return
        const status = await gateway.session.status(returnTo)
        if (generation !== sessionGeneration) return
        if (get().phase !== (status.authenticated ? 'authed' : 'anonymous')) advanceAuthGeneration()
        if (!status.authenticated) useAgentChatStore.getState().clearDisplay()
        set({ phase: status.authenticated ? 'authed' : 'anonymous', mode: status.mode,
          devAccount: status.devAccount, returnTo: status.returnTo, returnToFor: returnTo })
      } catch {
        if (generation === sessionGeneration) set({ phase: 'error' })
      }
    })()
    probeRequest = { gateway, returnTo, generation, promise }
    void promise.finally(() => { if (probeRequest?.generation === generation) probeRequest = undefined })
    return promise
  },

  revalidate(gateway) {
    const current = get()
    if (current.phase !== 'authed' || current.mode !== 'real' || authMutation) return Promise.resolve()
    if (validationRequest?.gateway === gateway && validationRequest.generation === sessionGeneration) return validationRequest.promise
    const generation = sessionGeneration
    const promise = (async () => {
      try {
        const status = await gateway.session.status(undefined, { passive: true })
        if (generation !== sessionGeneration || get().phase !== 'authed' || status.authenticated) return
        advanceAuthGeneration()
        invalidateChecks()
        useAgentChatStore.getState().clearDisplay()
        set({ phase: 'anonymous', notice: get().notice ?? '登录状态已失效，请重新登录' })
      } catch {
        // 网络故障保留页面；真实 API 仍由服务端鉴权。
      }
    })()
    validationRequest = { gateway, generation, promise }
    void promise.finally(() => { if (validationRequest?.promise === promise) validationRequest = undefined })
    return promise
  },

  async login(gateway, username, password) {
    advanceAuthGeneration()
    invalidateChecks()
    const revision = ++authRevision
    await mutateAuthentication(() => gateway.session.login(username, password))
    if (revision !== authRevision) throw new Error('登录操作已被更新的会话操作替代，请重新登录。')
    advanceAuthGeneration()
    invalidateChecks()
    // 新登录恢复上次选中的会话，公开数据重新经过服务端鉴权读取。
    useAgentChatStore.getState().clearDisplay()
    // 登录成功即消费一次性提示：它只在「密码刚改过、还没重新登录」的窗口内成立。
    set({ phase: 'authed', notice: null })
  },

  async logout(gateway) {
    advanceAuthGeneration()
    invalidateChecks()
    const revision = ++authRevision
    useAgentChatStore.getState().clearDisplay()
    // 先关闭页面闸门，使仍在挂载的聊天组件没有机会重新读取公开内容。
    set({ phase: 'anonymous' })
    try {
      await mutateAuthentication(() => gateway.session.logout())
    } finally {
      if (revision === authRevision) {
        advanceAuthGeneration()
        invalidateChecks()
        useAgentChatStore.getState().clearDisplay()
        set({ phase: 'anonymous' })
      }
    }
  },

  expire() {
    advanceAuthGeneration()
    invalidateChecks()
    authRevision += 1
    useAgentChatStore.getState().clearDisplay()
    set({ phase: 'anonymous' })
  },
}))

/*
 * 共享 401 拦截的监听在模块顶层接好：任何 http 出口上报 401 都直接落到这里，
 * adapter→store 的依赖方向在仓库有先例（mock/gateway.ts 引 useContainersStore）。
 */
setUnauthorizedListener(() => useSessionStore.getState().expire())
