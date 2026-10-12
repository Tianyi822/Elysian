import { create } from 'zustand'
import type { AgentRuntimeInfo } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'

/*
 * 模型设置使用的 Agent 运行时能力报告：先判定内核可用性与
 * 12 个能力位。读取走 gateway.agentRuntime.runtime()（GET /api/agent/runtime，唯一在
 * 内核不可用时也可读的端点）；闭包 sequence 丢弃过期响应。静默重载不整块白屏，
 * 只刷新 info——是否盖遮罩由调用方决定。
 */

export type AgentRuntimeState = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  info?: AgentRuntimeInfo
  errorMessage?: string
  /** 仅内核级 503；分项扩展故障留在对应页面，不遮挡其他能力。 */
  unavailableReason?: string
  /** 就绪后的再读取：旧报告留在屏上，只标记刷新中。 */
  reloading: boolean
  load(gateway: ElysianGateway, options?: { silent?: boolean; signal?: AbortSignal }): Promise<void>
  reportUnavailable(reason: string): void
  /** 测试复位：回到未加载状态。 */
  reset(): void
}

export const useAgentRuntimeStore = create<AgentRuntimeState>((set, get) => {
  let loadSequence = 0
  let unavailableVersion = 0
  return {
    status: 'idle',
    reloading: false,
    async load(gateway, options) {
      const sequence = ++loadSequence
      const observedUnavailableVersion = unavailableVersion
      const inPlace = get().status === 'ready'
      if (!options?.silent) {
        set(inPlace
          ? { reloading: true, errorMessage: undefined }
          : { status: 'loading', reloading: false, errorMessage: undefined })
      }
      try {
        const info = await gateway.agentRuntime.runtime(options?.signal)
        if (sequence !== loadSequence || options?.signal?.aborted) return
        set({
          status: 'ready', info, reloading: false, errorMessage: undefined,
          ...(observedUnavailableVersion === unavailableVersion ? { unavailableReason: undefined } : {}),
        })
      } catch (error) {
        if (sequence !== loadSequence || options?.signal?.aborted) return
        set({
          status: 'error',
          reloading: false,
          errorMessage: error instanceof Error ? error.message : '读取 Agent 运行时报告失败',
        })
        if (options?.silent) throw error
      }
    },
    reportUnavailable(reason) {
      unavailableVersion += 1
      set({ unavailableReason: reason })
    },
    reset() {
      loadSequence += 1
      unavailableVersion += 1
      set({ status: 'idle', info: undefined, errorMessage: undefined, unavailableReason: undefined, reloading: false })
    },
  }
})

/** 内核不可用判定：/runtime 明示 available:false，或能力位缺 reason 之外的异常。 */
export function selectAgentUnavailable(info: AgentRuntimeInfo | undefined): boolean {
  return info !== undefined && !info.available
}
