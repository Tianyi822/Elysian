import { create } from 'zustand'
import type { AgentRuntimeInfo } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { messageOf } from '../utils/errorMessage'
import { createRequestGuard } from './requestGuard'

/*
 * 模型设置使用的 Agent 运行时能力报告：先判定内核可用性与
 * 12 个能力位。读取走 gateway.agentRuntime.runtime()（GET /api/agent/runtime，唯一在
 * 内核不可用时也可读的端点）；请求守卫丢弃过期响应。静默重载不整块白屏，
 * 只刷新 info，读取失败保留上次报告。
 */

export type AgentRuntimeState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  info?: AgentRuntimeInfo
  errorMessage?: string
  /** 仅内核级 503；分项扩展故障留在对应页面，不遮挡其他能力。 */
  unavailableReason?: string
  /** 轮询用 throwOnError 接收失败并退避；silent 只控制读取开始时的显示状态。 */
  load(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal; throwOnError?: boolean }): Promise<void>
  reportUnavailable(reason: string): void
  /** 清空当前会话的报告和禁写状态。 */
  reset(): void
}

export const useAgentRuntimeStore = create<AgentRuntimeState>((set, get) => {
  const loadGuard = createRequestGuard()
  let unavailableVersion = 0
  return {
    status: 'idle',
    async load(gateway, options) {
      const isCurrent = loadGuard.replace()
      const observedUnavailableVersion = unavailableVersion
      const inPlace = get().status === 'ready'
      if (!options?.silent) {
        set({ status: inPlace ? 'ready' : 'loading', errorMessage: undefined })
      }
      try {
        const info = await gateway.agentRuntime.runtime(options?.signal)
        if (!isCurrent() || options?.signal?.aborted) return
        set({
          status: 'ready', info, errorMessage: undefined,
          ...(observedUnavailableVersion === unavailableVersion ? { unavailableReason: undefined } : {}),
        })
      } catch (error) {
        if (!isCurrent() || options?.signal?.aborted) return
        set({
          status: inPlace ? 'ready' : 'error',
          errorMessage: messageOf(error, '读取 Agent 运行时报告失败'),
        })
        if (options?.throwOnError) throw error
      }
    },
    reportUnavailable(reason) {
      unavailableVersion += 1
      set({ unavailableReason: reason })
    },
    reset() {
      loadGuard.invalidate()
      unavailableVersion += 1
      set({ status: 'idle', info: undefined, errorMessage: undefined, unavailableReason: undefined })
    },
  }
})

/** 内核不可用判定：/runtime 明示 available:false，或能力位缺 reason 之外的异常。 */
export function selectAgentUnavailable(info: AgentRuntimeInfo | undefined): boolean {
  return info !== undefined && !info.available
}
