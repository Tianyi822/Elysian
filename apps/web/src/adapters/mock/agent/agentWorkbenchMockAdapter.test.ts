import { afterEach, beforeEach } from 'vitest'
import { vi } from 'vitest'
import { runAgentWorkbenchAdapterContract } from '../../agentWorkbenchAdapterContract'
import { AgentWorkbenchMockAdapter, resetAgentWorkbenchData } from './agentWorkbenchMockAdapter'

/*
 * mock 实现对共享契约断言复跑（「mock 可替换」的验证方式之一）。
 * 时钟推进经 fake timers 注入：契约里的 clock.advance 即 advanceTimersByTimeAsync，
 * 状态机按 Date.now 相对时间推导（agentWorkbenchData 头注）。
 */

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-10T08:00:00Z'))
  resetAgentWorkbenchData(new Date())
})

afterEach(() => {
  vi.useRealTimers()
})

runAgentWorkbenchAdapterContract(
  'mock Ely 工作台',
  () => new AgentWorkbenchMockAdapter(),
  { advance: async (ms) => { await vi.advanceTimersByTimeAsync(ms) } },
)
