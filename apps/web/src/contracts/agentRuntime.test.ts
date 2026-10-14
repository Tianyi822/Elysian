import { describe, expect, it } from 'vitest'
import {
  RUNTIME_RUN_STATUSES,
  RUNTIME_RUN_STATUS_LABELS,
  RUNTIME_TOOL_NAMES,
  runtimeRunIsActive,
} from '@elysian/contracts'
import type {
  AgentCreateSessionInput,
  AgentInput,
  AgentMessage,
  AgentModelProfile,
  AgentModelProfileInput,
  AgentModelRequestRecord,
  AgentModelUsage,
  AgentRuntimeInfo,
  AgentSession,
  AgentSwitchModelInput,
  AgentUpdateModelProfileInput,
  AgentWorkingMemory,
  RuntimeAgentTask,
  RuntimeCall,
  RuntimeEvent,
  RuntimeFailure,
  RuntimeInfo,
  RuntimeLimits,
  RuntimePage,
  RuntimeRun,
  RuntimeSubmitInput,
  RuntimeTask,
} from '@elysian/contracts'
import fixture from '../../../../packages/foundation/contracts/fixtures/agent-runtime.json'
import agentFixture from '../../../../packages/foundation/contracts/fixtures/agent-session.json'

/** 与 Go harness/routes_test.go 读取同一 JSON，锚定字段、空数组和字符串序号。 */
describe('真实任务运行共享契约', () => {
  it('活动状态不包含已中断或任何终态，全部状态有中文标签', () => {
    expect(Object.keys(RUNTIME_RUN_STATUS_LABELS)).toEqual([...RUNTIME_RUN_STATUSES])
    expect(RUNTIME_RUN_STATUSES.filter(runtimeRunIsActive)).toEqual(['queued', 'running', 'waiting-approval', 'waiting-resource', 'recovery-required'])
    expect(RUNTIME_RUN_STATUSES.filter((state) => !runtimeRunIsActive(state)))
      .toEqual(['succeeded', 'failed', 'cancelled', 'interrupted'])
    for (const label of Object.values(RUNTIME_RUN_STATUS_LABELS)) expect(label).toMatch(/[\u4e00-\u9fff]/)
  })

  it('批处理白名单保持四个无参数 Docker 查询', () => {
    expect(RUNTIME_TOOL_NAMES).toEqual([
      'docker_containers_list', 'docker_images_list', 'docker_policy_view', 'docker_self_container',
    ])
  })

  it('同一 fixture 与 TypeScript 输入、状态、结果和事件类型逐字段对齐', () => {
    const limits: RuntimeLimits = {
      concurrency: 2, queueCapacity: 32, maxSteps: 16, inputBytes: 65536,
      callTimeoutSeconds: 30, runTimeoutSeconds: 300, resultBytes: 262144,
      runResultBytes: 2097152, logBytes: 1048576, frameBytes: 524288,
      retentionDays: 30, cancelGraceSeconds: 5,
    }
    const input: RuntimeSubmitInput = {
      requestId: 'diagnostic-request-1', kind: 'tool-batch',
      steps: [{ tool: 'docker_containers_list', args: {} }],
    }
    const task: RuntimeTask = {
      id: 'task-1', ...input, driverVersion: 'v1', createdAt: '2026-10-10T00:00:00Z',
    }
    const run: RuntimeRun = {
      id: 'run-1', taskId: 'task-1', status: 'succeeded',
      createdAt: '2026-10-10T00:00:00Z', startedAt: '2026-10-10T00:00:01Z', endedAt: '2026-10-10T00:00:02Z',
      endReason: 'completed', task, limits, usage: { calls: 1, resultBytes: 2 }, lastSeq: '9007199254740993',
    }
    const call: RuntimeCall = {
      id: 'call-1', runId: 'run-1', tool: 'docker_containers_list', status: 'succeeded',
      startedAt: '2026-10-10T00:00:01Z', endedAt: '2026-10-10T00:00:02Z', stepIndex: 0,
      args: {}, result: [], truncated: false,
    }
    const event: RuntimeEvent = {
      runId: 'run-1', seq: '9007199254740993', type: 'call/finished', at: '2026-10-10T00:00:02Z',
      callId: 'call-1', stepIndex: 0, data: { status: 'succeeded', resultBytes: 2 },
    }
    const info: RuntimeInfo = {
      available: true, worker: 'ready', storage: 'ready',
      tools: [{ name: 'docker_containers_list', description: '列出容器视图', parameters: {
        type: 'object', additionalProperties: false, properties: {},
      } }], limits, queueDepth: 0,
      batch: { available: true }, agent: { available: false }, skills: { available: false },
      mcp: { available: false }, containerExecution: { available: false }, approvals: { available: false },
      workflow: { available: false },
      wiki: { available: false }, embedding: { available: false }, workflowV2: { available: false },
      resourceLocks: { available: false }, executionRuntimes: { available: false },
    }
    const failure: RuntimeFailure = { code: 'interrupted', message: '运行已中断，未自动重放' }
    const emptyPage: RuntimePage<RuntimeRun> = { items: [], nextCursor: '', hasMore: false }
    expect(fixture).toEqual({ input, task, run, call, event, info, failure, emptyPage })
    expect(JSON.parse(JSON.stringify(fixture)).event.seq).toBe('9007199254740993')
  })

  it('动态 Agent fixture 锚定会话、固定模型、工具提议与带证据的工作记忆', () => {
    const createdAt = '2026-10-10T00:00:00Z'
    const endedAt = '2026-10-10T00:00:05Z'
    const seq = '9007199254740993'
    const model: AgentModelProfile = {
      id: 'profile-1', revision: 2, baseUrl: 'https://model.example.test/v1',
      model: 'test-model', provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 65536, outputTokens: 4096,
      capabilities: { text: true, tools: true, source: '用户配置' }, active: true, hasCredential: true,
    }
    const createSession: AgentCreateSessionInput = { title: '容器检查', modelProfileId: model.id, modelRevision: 2 }
    const switchModel: AgentSwitchModelInput = { modelProfileId: model.id, modelRevision: 2 }
    const input: AgentInput = { requestId: 'agent-request-1', content: '检查容器运行状态' }
    const session: AgentSession = {
      id: 'session-1', title: '容器检查', createdAt, lastActivityAt: endedAt,
      modelProfileId: model.id, modelRevision: 2, lastSeq: seq,
      notices: ['历史答复保留各轮固定模型版本'],
      modelChange: {
        before: { ...model, revision: 1, provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 32768, outputTokens: 2048 },
        after: model,
        differences: ['上下文 token 容量', '单次输出 token 上限'],
        notices: [
          '模型能力可能变化，请核对文本、工具调用和上下文容量',
          '切换后的首轮缓存命中率可能下降，实际取决于模型与供应商',
          '切换可能改变响应速度与调用成本，实际取决于模型与供应商',
        ],
      },
    }
    const task: RuntimeAgentTask = {
      id: 'task-agent-1', requestId: input.requestId, kind: 'agent', driverVersion: 'v1', createdAt,
      sessionId: session.id, goal: input.content, steps: null,
    }
    const limits: RuntimeLimits = {
      concurrency: 2, queueCapacity: 32, maxSteps: 16, inputBytes: 65536,
      callTimeoutSeconds: 30, runTimeoutSeconds: 600, resultBytes: 262144,
      runResultBytes: 2097152, logBytes: 1048576, frameBytes: 524288,
      retentionDays: 30, cancelGraceSeconds: 5, maxModelRequests: 16, modelTimeoutSeconds: 60,
      tokenBudget: 196608, userBytes: 32768, memoryBytes: 16384, modelResponseBytes: 2097152,
    }
    const run: RuntimeRun = {
      id: 'run-agent-1', taskId: task.id, sessionId: session.id, runNumber: 1,
      requestId: input.requestId, input: input.content, model, historySeq: seq, initialMemoryRevision: 1,
      phase: 'completed', memoryStatus: 'updated', status: 'succeeded', createdAt,
      startedAt: '2026-10-10T00:00:01Z', endedAt, endReason: 'completed', task, limits,
      usage: { calls: 1, resultBytes: 2, modelRequests: 3, tokens: 1200, estimatedTokens: 2000, actualTokens: 1200 },
      lastSeq: seq,
    }
    const latestRun: RuntimeRun = { ...run }
    delete latestRun.task
    const publicTask: RuntimeAgentTask = { ...task, latestRun, memoryStatus: 'updated' }
    const call: RuntimeCall = {
      id: 'call-agent-1', runId: run.id, modelRequestId: 'model-request-1', modelCallId: 'proposal-1',
      tool: 'docker_containers_list', status: 'succeeded', startedAt: '2026-10-10T00:00:02Z',
      endedAt: '2026-10-10T00:00:03Z', stepIndex: 0, args: {}, result: [], truncated: false,
    }
    const modelRequest: AgentModelRequestRecord = {
      wikiSources: [{ pageId: 'wiki-page-1', revision: 1, digest: 'wiki-page-digest' }],
      contextItemIds: ['context-agent-1'],
      id: 'model-request-1', runId: run.id, index: 0, purpose: 'inference', status: 'succeeded',
      startedAt: '2026-10-10T00:00:01Z', endedAt: '2026-10-10T00:00:02Z',
      contextRefs: [{ runId: run.id, eventSeq: '1' }], memoryRevision: 1,
      response: {
        content: '', toolCalls: [{ id: 'proposal-1', name: 'docker_containers_list', arguments: {} }],
        finishReason: 'tool_calls', usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      estimatedTokens: 256, eventSeq: '3', historySeq: seq,
    }
    const memory: AgentWorkingMemory = {
      memoryStatus: 'updated',
      taskId: task.id, revision: 2, updatedAt: endedAt, coverage: { runNumber: 1, eventSeq: seq },
      objective: task.goal, constraints: ['仅执行只读查询'],
      facts: [{ text: '容器列表为空', sources: [{ runId: run.id, eventSeq: seq }] }],
      todos: [], openQuestions: [], summary: '容器检查完成。',
    }
    const message: AgentMessage = {
      quarantined: true,
      wikiSources: [{ pageId: 'wiki-page-1', revision: 1, digest: 'wiki-page-digest' }],
      id: 'message-1', sessionId: session.id, taskId: task.id, runId: run.id, seq,
      role: 'assistant', content: '查询结果中没有容器。', createdAt: endedAt, runStatus: 'succeeded',
    }
    const event: RuntimeEvent = {
      runId: run.id, seq, type: 'memory/updated', at: endedAt, data: { revision: 2, coverage: memory.coverage },
    }
    const info: AgentRuntimeInfo = {
      available: true, worker: 'ready', storage: 'ready', tools: [], limits, queueDepth: 0,
      batch: { available: true }, agent: { available: true },
      skills: { available: false }, mcp: { available: false }, containerExecution: { available: false }, approvals: { available: false },
      workflow: { available: false },
      wiki: { available: false }, embedding: { available: false }, workflowV2: { available: false },
      resourceLocks: { available: false }, executionRuntimes: { available: false },
    }
    const emptyPage: RuntimePage<AgentMessage> = { items: [], nextCursor: seq, hasMore: false }
    expect(agentFixture).toEqual({ createSession, switchModel, input, session, task: publicTask, run, call, modelRequest, memory, message, event, info, emptyPage })
    expect(JSON.parse(JSON.stringify(agentFixture)).memory.coverage.eventSeq).toBe(seq)
    expect(agentFixture.run.model).not.toHaveProperty('credential')
    expect(agentFixture.session.modelChange.before).not.toHaveProperty('credential')
    expect(agentFixture.session.modelChange.after).not.toHaveProperty('credential')
    expect(agentFixture.task.latestRun).not.toHaveProperty('task')
    expect(agentFixture.message).not.toHaveProperty('toolCalls')
    expect(agentFixture.message).not.toHaveProperty('memory')
  })

  it('未知缓存用量与明确零命中不同，凭据更新区分省略和清除', () => {
    const unknown: AgentModelUsage = {}
    const reported: AgentModelUsage = { cachedTokens: 0 }
    expect(unknown).not.toHaveProperty('cachedTokens')
    expect(reported.cachedTokens).toBe(0)
    expect(agentFixture.run.usage).not.toHaveProperty('cachedTokens')
    expect(agentFixture.modelRequest.response.usage).not.toHaveProperty('cachedTokens')
    const input: AgentModelProfileInput = {
      baseUrl: 'https://model.example.test/v1', model: 'test-model',
      provider: 'openai-compatible' as const, apiFormat: 'chat-completions' as const, contextTokens: 65536, outputTokens: 4096, capabilities: { text: true, tools: true, source: '用户配置' }, active: true,
    }
    const clearCredential: AgentUpdateModelProfileInput = { ...input, expectedRevision: 2, credential: '' }
    expect(input).not.toHaveProperty('credential')
    expect(clearCredential.credential).toBe('')
    expect(clearCredential.expectedRevision).toBe(2)
  })
})
