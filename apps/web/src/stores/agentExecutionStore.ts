import { create } from 'zustand'
import type { AgentExecutionGrant, AgentExecutionGrantInput, AgentExecutionProfile, AgentExecutionProfileInput } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentHttpError } from '../adapters/http/agent/agentShared'
import { captureAuthGeneration } from '../adapters/http/unauthorized'
import { useNotificationStore } from './notificationStore'

export type ExecutionKind = 'profiles' | 'grants'
export type ExecutionItem = AgentExecutionProfile | AgentExecutionGrant
export type ExecutionSaveResult = { status: 'saved' | 'error' | 'unknown' | 'stale'; message?: string; latest?: ExecutionItem }
type Catalog<T> = { items: readonly T[]; status: 'idle' | 'loading' | 'ready' | 'error'; refreshing: boolean; error?: string }
type State = {
  profiles: Catalog<AgentExecutionProfile>
  grants: Catalog<AgentExecutionGrant>
  busy: readonly string[]
  epoch: number
  load(gateway: ElysianGateway, kind: ExecutionKind): Promise<void>
  saveProfile(gateway: ElysianGateway, input: AgentExecutionProfileInput, id?: string): Promise<ExecutionSaveResult>
  saveGrant(gateway: ElysianGateway, input: AgentExecutionGrantInput, id?: string): Promise<ExecutionSaveResult>
  toggle(gateway: ElysianGateway, kind: ExecutionKind, item: ExecutionItem, enabled: boolean): Promise<ExecutionSaveResult>
  reset(): void
}
const empty = <T>(): Catalog<T> => ({ items: [], status: 'idle', refreshing: false })
const message = (cause: unknown) => cause instanceof Error ? cause.message : '执行配置操作失败'

export const useAgentExecutionStore = create<State>((set, get) => {
  let epoch = 0
  const reads = { profiles: 0, grants: 0 }
  const replace = (kind: ExecutionKind, item: ExecutionItem) => {
    if (kind === 'profiles') set(state => ({ profiles: { ...state.profiles, status: 'ready', refreshing: false, error: undefined, items: [...state.profiles.items.filter(p => p.id !== item.id), item as AgentExecutionProfile] } }))
    else set(state => ({ grants: { ...state.grants, status: 'ready', refreshing: false, error: undefined, items: [...state.grants.items.filter(g => g.id !== item.id), item as AgentExecutionGrant] } }))
  }
  const mutate = async (gateway: ElysianGateway, kind: ExecutionKind, id: string | undefined, call: () => Promise<ExecutionItem>): Promise<ExecutionSaveResult> => {
    const key = `${kind}:${id ?? 'new'}`
    if (get().busy.includes(key)) return { status: 'error', message: '该操作正在提交，请稍候。' }
    const owner = epoch, auth = captureAuthGeneration()
    const current = () => owner === epoch && auth === captureAuthGeneration()
    set(state => ({ busy: [...state.busy, key] }))
    try {
      const item = await call()
      if (!current()) return { status: 'stale' }
      // 使提交前发出的列表请求失效，避免旧列表覆盖已确认回执。
      reads[kind] += 1
      replace(kind, item)
      useNotificationStore.getState().notify({ tone: 'success', message: `${kind === 'profiles' ? '执行配置' : '资源授权'}已保存（修订 ${item.revision}）。` })
      return { status: 'saved' }
    } catch (cause) {
      if (!current()) return { status: 'stale' }
      let latest: ExecutionItem | undefined
      // 核对只读，不自动重放。新建无 requestId，不能根据同名条目推断成功。
      await get().load(gateway, kind)
      if (!current()) return { status: 'stale' }
      if (id) {
        try { latest = kind === 'profiles' ? await gateway.agentExecution.getProfile(id) : await gateway.agentExecution.getGrant(id) } catch { /* 草稿继续保留。 */ }
      }
      if (!current()) return { status: 'stale' }
      if (latest) replace(kind, latest)
      const unknown = !(cause instanceof AgentHttpError) || cause.status === undefined || cause.status >= 500
      return { status: unknown ? 'unknown' : 'error', message: unknown ? `${message(cause)}。提交结果尚未确认，请核对列表与最新修订；不会自动重试。` : message(cause), latest }
    } finally { if (current()) set(state => ({ busy: state.busy.filter(item => item !== key) })) }
  }
  return {
    profiles: empty(), grants: empty(), busy: [], epoch,
    async load(gateway, kind) {
      const owner = epoch, auth = captureAuthGeneration(), seq = ++reads[kind]
      const current = () => owner === epoch && seq === reads[kind] && auth === captureAuthGeneration()
      const previous = get()[kind]
      set({ [kind]: { ...previous, status: previous.status === 'ready' ? 'ready' : 'loading', refreshing: previous.status === 'ready', error: undefined } })
      try {
        const items = kind === 'profiles' ? await gateway.agentExecution.listProfiles() : await gateway.agentExecution.listGrants()
        if (current()) set({ [kind]: { items, status: 'ready', refreshing: false } })
      } catch (cause) {
        if (current()) set({ [kind]: { ...previous, status: previous.status === 'ready' ? 'ready' : 'error', refreshing: false, error: message(cause) } })
      }
    },
    saveProfile: (gateway, input, id) => mutate(gateway, 'profiles', id, () => id ? gateway.agentExecution.updateProfile(id, input) : gateway.agentExecution.createProfile(input)),
    saveGrant: (gateway, input, id) => mutate(gateway, 'grants', id, () => id ? gateway.agentExecution.updateGrant(id, input) : gateway.agentExecution.createGrant(input)),
    toggle: (gateway, kind, item, enabled) => mutate(gateway, kind, item.id, () => kind === 'profiles' ? gateway.agentExecution.setProfileEnabled(item.id, item.revision, enabled) : gateway.agentExecution.setGrantEnabled(item.id, item.revision, enabled)),
    reset() { epoch += 1; reads.profiles += 1; reads.grants += 1; set({ profiles: empty(), grants: empty(), busy: [], epoch }) },
  }
})
