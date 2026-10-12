import type {
  AgentRuntimeInfo,
  RuntimeCall,
  RuntimeEvent,
  RuntimeListQuery,
  RuntimePage,
  RuntimeRun,
  RuntimeSubmitInput,
} from '@elysian/contracts'
import type { AgentRunsAdapter } from '../../../contracts/adapters'
import {
  mockCancelRun,
  mockGetRun,
  mockListRunCalls,
  mockListRunEvents,
  mockListRuns,
  mockSubmitBatch,
  resetAgentRunsData,
} from './agentRunsData'
import { getWorkbenchRun, listWorkbenchRunRecords, workbenchInternals } from './agentWorkbenchData'

/*
 * Ely 运行记录域 mock：批次数据由 agentRunsData 管理，工作台 Run 与
 * agentWorkbenchData 共用事实，供跨页面查询和 requestId 核对。
 * 演示运行时报告保持地基口径（available:true、12 能力位全开）；Run 列表、
 * 详情、事件、调用、批次提交与取消按服务端语义实现（游标十进制字符串、
 * requestId 幂等回读、queued 取消立即生效、running 取消只落请求时间）。
 */

/** 演示运行时报告；限额与共享 fixture 的 Agent 默认值一致。 */
export function demoAgentRuntimeInfo(): AgentRuntimeInfo {
  return {
    available: true,
    worker: 'ready',
    storage: 'ready',
    tools: [],
    limits: {
      concurrency: 2, queueCapacity: 32, maxSteps: 16, inputBytes: 65536,
      callTimeoutSeconds: 30, runTimeoutSeconds: 600, resultBytes: 262144,
      runResultBytes: 2097152, logBytes: 1048576, frameBytes: 524288,
      retentionDays: 30, cancelGraceSeconds: 5, maxModelRequests: 16,
      modelTimeoutSeconds: 60, outputTokens: 4096, tokenBudget: 128000,
      userBytes: 32768, memoryBytes: 16384, modelResponseBytes: 524288,
    },
    queueDepth: 0,
    batch: { available: true },
    agent: { available: true },
    skills: { available: true },
    mcp: { available: true },
    containerExecution: { available: true },
    approvals: { available: true },
    workflow: { available: true },
    wiki: { available: true },
    embedding: { available: true },
    workflowV2: { available: true },
    resourceLocks: { available: true },
    executionRuntimes: { available: true },
  }
}

/** 复位到种子；agentTestUtils 的 resetAgentSeeds 聚合出口依赖此名字。 */
export { resetAgentRunsData }

export class AgentRunsMockAdapter implements AgentRunsAdapter {
  runtime(): Promise<AgentRuntimeInfo> {
    return Promise.resolve(demoAgentRuntimeInfo())
  }

  async submitBatch(input: RuntimeSubmitInput): Promise<RuntimeRun> {
    return mockSubmitBatch(input)
  }

  async listRuns(query?: RuntimeListQuery, _signal?: AbortSignal): Promise<RuntimePage<RuntimeRun>> {
    void _signal
    return mockListRuns(query ?? {}, listWorkbenchRunRecords())
  }

  async getRun(runId: string, _signal?: AbortSignal): Promise<RuntimeRun> {
    void _signal
    const workbenchRun = getWorkbenchRun(runId)
    if (workbenchRun !== undefined) return workbenchRun
    return mockGetRun(runId)
  }

  async listRunCalls(runId: string, query?: { cursor?: string; limit?: number }, _signal?: AbortSignal): Promise<RuntimePage<RuntimeCall>> {
    void _signal
    if (getWorkbenchRun(runId) !== undefined) return { items: [], nextCursor: '', hasMore: false }
    return mockListRunCalls(runId, query ?? {})
  }

  async listRunEvents(runId: string, query?: { after?: string; limit?: number }, _signal?: AbortSignal): Promise<RuntimePage<RuntimeEvent>> {
    void _signal
    if (getWorkbenchRun(runId) !== undefined) return { items: [], nextCursor: query?.after ?? '0', hasMore: false }
    return mockListRunEvents(runId, query ?? {})
  }

  async cancelRun(runId: string): Promise<RuntimeRun> {
    if (getWorkbenchRun(runId) !== undefined) return workbenchInternals.requestCancel(runId)
    return mockCancelRun(runId)
  }
}
