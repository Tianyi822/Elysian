import type { AgentRuntimeInfo } from '@elysian/contracts'

/** 模型设置使用的演示运行时报告。 */
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
    workflow: { available: false, reason: '工作流功能已退役' },
    wiki: { available: true },
    embedding: { available: true },
    workflowV2: { available: false, reason: '工作流功能已退役' },
    resourceLocks: { available: true },
    executionRuntimes: { available: true },
  }
}
