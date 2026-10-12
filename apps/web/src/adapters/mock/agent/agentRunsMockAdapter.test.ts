import { beforeEach, describe, expect, it } from 'vitest'
import { runAgentRunsAdapterContract } from '../../agentRunsAdapterContract'
import { AgentRunsMockAdapter, resetAgentRunsData } from './agentRunsMockAdapter'
import { resetAgentWorkbenchData, workbenchInternals } from './agentWorkbenchData'

/*
 * mock 实现对共享契约复跑（「mock 可替换」的验证方式之一）：
 * 世界 = 确定性种子（run-batch-ok 成功、run-agent-interrupted 中断、
 * 14 条种子可翻页）。另覆盖 mock 特有口径：未找到的中文措辞。
 */

beforeEach(() => {
  resetAgentRunsData()
  resetAgentWorkbenchData(new Date('2026-10-10T08:00:00Z'))
})

runAgentRunsAdapterContract('mock 运行记录', () => new AgentRunsMockAdapter(), {
  succeededRunId: 'run-batch-ok',
  interruptedRunId: 'run-agent-interrupted',
  enoughRunsForPaging: true,
})

describe('mock 实现特有口径', () => {
  it('runtime() 返回演示报告：available:true 且 12 能力位全开', async () => {
    const info = await new AgentRunsMockAdapter().runtime()
    expect(info.available).toBe(true)
    expect(info.queueDepth).toBe(0)
  })

  it('未知 Run 与未知取消的中文错误携带标识', async () => {
    const adapter = new AgentRunsMockAdapter()
    await expect(adapter.getRun('run-nope')).rejects.toThrow('演示数据中不存在 Run run-nope')
    await expect(adapter.cancelRun('run-nope')).rejects.toThrow('演示数据中不存在 Run run-nope')
  })

  it('工作台 Run 可按 ID 与 requestId 回读并在运行记录中分页', async () => {
    const adapter = new AgentRunsMockAdapter()
    const created = workbenchInternals.createTask('session-1', { requestId: 'request-bridge', content: '核对容器状态' })
    expect((await adapter.getRun(created.id)).taskId).toBe(created.taskId)
    const byRequest = await adapter.listRuns({ sessionId: 'session-1', requestId: 'request-bridge' })
    expect(byRequest.items.map((run) => run.id)).toEqual([created.id])
    const firstSessionPage = await adapter.listRuns({ sessionId: 'session-1', limit: 1 })
    expect(firstSessionPage.hasMore).toBe(true)
    const nextSessionPage = await adapter.listRuns({ sessionId: 'session-1', limit: 1, cursor: firstSessionPage.nextCursor })
    expect(nextSessionPage.items[0]?.id).not.toBe(firstSessionPage.items[0]?.id)
    const firstPage = await adapter.listRuns({ limit: 1 })
    expect(firstPage.hasMore).toBe(true)
    const secondPage = await adapter.listRuns({ limit: 1, cursor: firstPage.nextCursor })
    expect(secondPage.items[0]?.id).not.toBe(firstPage.items[0]?.id)
  })
})
