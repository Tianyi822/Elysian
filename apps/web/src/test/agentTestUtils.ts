import { vi } from 'vitest'
import type { RuntimePage } from '@elysian/contracts'
import { resetAgentWorkbenchData } from '../adapters/mock/agent/agentWorkbenchMockAdapter'
import { resetAgentApprovalsData } from '../adapters/mock/agent/agentApprovalsMockAdapter'
import { resetAgentRunsData } from '../adapters/mock/agent/agentRunsMockAdapter'
import { resetAgentWorkflowsData } from '../adapters/mock/agent/agentWorkflowsMockAdapter'
import { resetAgentCapabilitiesData } from '../adapters/mock/agent/agentCapabilitiesMockAdapter'
import { resetAgentExtensionsData } from '../adapters/mock/agent/agentExtensionsMockAdapter'
import { resetAgentMemoryData } from '../adapters/mock/agent/agentMemoryMockAdapter'
import { useAgentRuntimeStore } from '../stores/agentRuntimeStore'

/*
 * Agent 域测试工具：Page 信封 fetch stub、fake-timers 轮询推进与各域种子复位
 * 聚合出口。renderApp 复用既有 test/renderApp.tsx；轮询断言一律经 advancePoll
 * 推进 fake timers，不真等时间。
 */

/** 构造 Page 信封（items/nextCursor/hasMore）。 */
export function agentPageEnvelope<T>(items: readonly T[], nextCursor = '', hasMore = false): RuntimePage<T> {
  return { items, nextCursor, hasMore }
}

function urlOf(input: unknown): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  if (input instanceof Request) return input.url
  return String(input)
}

/**
 * 按路径（忽略查询串）返回预置 JSON 的 fetch stub；未登记路径回 404 错误体，
 * 让「请求落错端点」在断言前就显形。用 vi.stubGlobal('fetch', stub) 挂上。
 */
export function stubAgentJsonFetch(routes: Readonly<Record<string, unknown>>): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown) => {
    const url = urlOf(input)
    const path = url.split('?')[0]
    const hit = Object.entries(routes).find(([route]) => route === path)
    if (hit === undefined) {
      return new Response(JSON.stringify({ error: `测试未登记的 Agent 端点：${url}`, code: 'not-stubbed' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(hit[1]), { headers: { 'content-type': 'application/json' } })
  })
}

/** 推进 fake timers 并让已排定的微任务跑完；轮询节奏断言统一走这里。 */
export async function advancePoll(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

/** 七域演示种子复位（mock 数据集当前恒定，聚合出口供后续模块挂真实种子复位）。 */
export function resetAgentSeeds(): void {
  resetAgentWorkbenchData()
  resetAgentApprovalsData()
  resetAgentRunsData()
  resetAgentWorkflowsData()
  resetAgentCapabilitiesData()
  resetAgentExtensionsData()
  resetAgentMemoryData()
}

/** 种子＋共享运行时 store 一并复位；beforeEach 的统一入口。 */
export function resetAgentTestState(): void {
  resetAgentSeeds()
  useAgentRuntimeStore.getState().reset()
}
