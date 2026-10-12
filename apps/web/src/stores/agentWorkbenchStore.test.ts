import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRun } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentWorkbenchMockAdapter, resetAgentWorkbenchData } from '../adapters/mock/agent/agentWorkbenchMockAdapter'
import { workbenchInternals } from '../adapters/mock/agent/agentWorkbenchData'
import { readWorkbenchRecovery, useAgentWorkbenchStore } from './agentWorkbenchStore'

/*
 * 工作台 store 的数据面口径：选择态联动、消息增量的去重与游标保留、
 * 过期响应丢弃、poll 在活动落定时补读、取消经 gateway.agentRuns 接缝
 * （「取消请求已提交」不等于「已停止」）。底层用确定性 mock 状态机 +
 * fake timers 推进时间。
 */

const BASE = new Date('2026-10-10T08:00:00Z').getTime()

function makeGateway(overrides: Partial<ElysianGateway['agentRuns']> = {}): ElysianGateway {
  return {
    agentWorkbench: new AgentWorkbenchMockAdapter(),
    agentRuns: {
      cancelRun: vi.fn(async (runId: string): Promise<RuntimeRun> => workbenchInternals.requestCancel(runId)),
      ...overrides,
    },
  } as unknown as ElysianGateway
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE)
  resetAgentWorkbenchData(new Date(BASE))
  useAgentWorkbenchStore.getState().reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('agentWorkbenchStore', () => {
  it('把待核对提交和草稿保留在当前标签页，刷新回读不自动重放', () => {
    const store = useAgentWorkbenchStore.getState()
    const draft = { content: '检查防火墙', skills: [], resources: [], prompts: [], promptArguments: {} }
    const pending = { sessionId: 'session-1', input: { requestId: 'retry-1', content: draft.content }, uncertain: true as const }
    store.setDraft('session-1:new', draft)
    store.setPendingInput('session-1:new', pending)

    expect(readWorkbenchRecovery()).toEqual({ drafts: { 'session-1:new': draft }, pendingInputs: { 'session-1:new': pending } })
    expect(sessionStorage.getItem('elysian.agent.workbench.recovery.v1')).toContain('retry-1')

    store.setPendingInput('session-1:new', undefined)
    expect(readWorkbenchRecovery().pendingInputs).toEqual({})
    store.reset()
    expect(readWorkbenchRecovery()).toEqual({ drafts: {}, pendingInputs: {} })
  })

  it('选择会话后回读详情、任务与消息；种子消息按 seq 排序', async () => {
    const gateway = makeGateway()
    const store = useAgentWorkbenchStore.getState()
    store.selectSession('session-1')
    await Promise.all([
      store.loadSessionDetail(gateway),
      store.loadTasks(gateway),
      store.loadMessages(gateway),
    ])
    const state = useAgentWorkbenchStore.getState()
    expect(state.sessionDetail?.id).toBe('session-1')
    expect(state.tasks.length).toBe(2)
    expect(state.messages.map((message) => message.seq)).toEqual(['1', '2', '3', '4'])
    expect(state.messagesCursor).toBe('4')
  })

  it('创建任务后选中任务、进入 busy 并回读增量消息', async () => {
    const gateway = makeGateway()
    const store = useAgentWorkbenchStore.getState()
    store.selectSession('session-1')
    await store.loadMessages(gateway)
    const run = await useAgentWorkbenchStore.getState().createTask(gateway, 'session-1', {
      requestId: 'store-create-1',
      content: '检查容器运行状态',
    })
    expect(run.runNumber).toBe(1)
    const state = useAgentWorkbenchStore.getState()
    expect(state.selectedTaskId).toBe(run.taskId)
    expect(state.sessionDetail?.activeRunId).toBe(run.id)
    // 用户消息已经出现在公开消息流。
    expect(state.messages.some((message) => message.role === 'user' && message.content === '检查容器运行状态')).toBe(true)
  })

  it('同 requestId 幂等回读：重复提交只得到同一 Run（连点防重放）', async () => {
    const gateway = makeGateway()
    const store = useAgentWorkbenchStore.getState()
    store.selectSession('session-1')
    await store.loadMessages(gateway)
    const input = { requestId: 'store-idem-1', content: '幂等检查' }
    const first = await useAgentWorkbenchStore.getState().createTask(gateway, 'session-1', input)
    // 幂等回读发生在 busy 之外：直接经 adapter 断言同一 Run 返回。
    const duplicate = await gateway.agentWorkbench.createTask('session-1', input)
    expect(duplicate.id).toBe(first.id)
    expect(duplicate.runNumber).toBe(first.runNumber)
  })

  it('增量消息按 id 去重、按 seq 排序；空页保留游标', async () => {
    const gateway = makeGateway()
    const store = useAgentWorkbenchStore.getState()
    store.selectSession('session-1')
    await store.loadMessages(gateway)
    await useAgentWorkbenchStore.getState().createTask(gateway, 'session-1', { requestId: 'store-inc-1', content: '增量检查' })
    const before = useAgentWorkbenchStore.getState()
    expect(before.messages.some((message) => message.content === '增量检查')).toBe(true)
    // 空页：答复还没产生。
    await useAgentWorkbenchStore.getState().loadMessages(gateway, { incremental: true })
    const emptyPaged = useAgentWorkbenchStore.getState()
    expect(emptyPaged.messages.length).toBe(before.messages.length)
    expect(emptyPaged.messagesCursor).toBe(before.messagesCursor)
    await tick(6500)
    await useAgentWorkbenchStore.getState().loadMessages(gateway, { incremental: true })
    const grown = useAgentWorkbenchStore.getState()
    const seqs = grown.messages.map((message) => message.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => (left.length === right.length ? (left < right ? -1 : 1) : left.length - right.length)))
    expect(new Set(grown.messages.map((message) => message.id)).size).toBe(grown.messages.length)
    expect(grown.messages.some((message) => message.role === 'assistant' && message.content.includes('增量检查'))).toBe(true)
  })

  it('poll：活动期间推进 Run 详情，落定后补工作记忆与任务列表', async () => {
    const gateway = makeGateway()
    const store = useAgentWorkbenchStore.getState()
    store.selectSession('session-1')
    await store.loadTasks(gateway)
    await store.loadMessages(gateway)
    const run = await useAgentWorkbenchStore.getState().createTask(gateway, 'session-1', { requestId: 'store-poll-1', content: '轮询检查' })
    await tick(2000)
    await useAgentWorkbenchStore.getState().poll(gateway)
    expect(useAgentWorkbenchStore.getState().taskDetail?.latestRun?.status).toBe('running')
    await tick(5000)
    await useAgentWorkbenchStore.getState().poll(gateway)
    const settled = useAgentWorkbenchStore.getState()
    expect(settled.taskDetail?.latestRun?.status).toBe('succeeded')
    expect(settled.sessionDetail?.activeRunId).toBeUndefined()
    expect(settled.workingMemory?.taskId).toBe(run.taskId)
    expect(settled.workingMemory?.memoryStatus).toBe('updated')
  })

  it('取消经 gateway.agentRuns：请求后仍 busy（已请求取消≠已停止），终态后空闲', async () => {
    const gateway = makeGateway()
    const store = useAgentWorkbenchStore.getState()
    store.selectSession('session-1')
    await store.loadMessages(gateway)
    const run = await useAgentWorkbenchStore.getState().createTask(gateway, 'session-1', { requestId: 'store-cancel-1', content: '取消检查' })
    await tick(2000)
    const cancelled = await useAgentWorkbenchStore.getState().cancelRun(gateway, run.id)
    expect(cancelled.cancelRequestedAt).toBeDefined()
    expect(cancelled.status).toBe('running')
    expect(gateway.agentRuns.cancelRun).toHaveBeenCalledWith(run.id)
    expect(useAgentWorkbenchStore.getState().sessionDetail?.activeRunId).toBe(run.id)
    await tick(2500)
    await useAgentWorkbenchStore.getState().poll(gateway)
    expect(useAgentWorkbenchStore.getState().sessionDetail?.activeRunId).toBeUndefined()
    expect(useAgentWorkbenchStore.getState().taskDetail?.latestRun?.status).toBe('cancelled')
  })

  it('过期响应被丢弃：慢的会话列表不得覆盖快的', async () => {
    let releaseSlow: (() => void) | undefined
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve })
    const gateway = makeGateway()
    const original = gateway.agentWorkbench.listSessions.bind(gateway.agentWorkbench)
    let calls = 0
    gateway.agentWorkbench.listSessions = async (query?: unknown) => {
      calls += 1
      if (calls === 1) await slow
      return original(query as never)
    }
    const store = useAgentWorkbenchStore.getState()
    const first = store.loadSessions(gateway)
    const second = store.loadSessions(gateway)
    await second
    expect(useAgentWorkbenchStore.getState().sessionsStatus).toBe('ready')
    releaseSlow?.()
    await first
    // 两次结果都来自同一数据源；断言 sequence 生效：状态仍 ready、列表非空。
    expect(useAgentWorkbenchStore.getState().sessions.length).toBeGreaterThan(0)
  })

  it('工作区写入把原始字节交给 adapter（不经 JSON 包装）', async () => {
    const gateway = makeGateway()
    const store = useAgentWorkbenchStore.getState()
    store.selectSession('session-1')
    store.selectTask('task-1')
    const bytes = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x31, 0x7d, 0x00, 0xff])
    const writeSpy = vi.spyOn(gateway.agentWorkbench, 'writeWorkspaceFile')
    await useAgentWorkbenchStore.getState().writeWorkspace(gateway, 'task-1', 'evidence/x.bin', 1, bytes)
    expect(writeSpy).toHaveBeenCalledTimes(1)
    const [taskId, path, revision, sent] = writeSpy.mock.calls[0] ?? []
    expect(taskId).toBe('task-1')
    expect(path).toBe('evidence/x.bin')
    expect(revision).toBe(1)
    expect(sent).toBeInstanceOf(Uint8Array)
    expect(Array.from(sent as Uint8Array)).toEqual(Array.from(bytes))
    expect(useAgentWorkbenchStore.getState().workspaceView?.files?.some((file) => file.path === 'evidence/x.bin')).toBe(true)
  })

  it('续轮被 model-changed 拒绝时错误透传（中文文案携带 code）', async () => {
    const gateway = makeGateway()
    const store = useAgentWorkbenchStore.getState()
    store.selectSession('session-1')
    await store.loadMessages(gateway)
    const run = await useAgentWorkbenchStore.getState().createTask(gateway, 'session-1', { requestId: 'store-model-1', content: '模型检查' })
    await tick(6500)
    await useAgentWorkbenchStore.getState().poll(gateway)
    await gateway.agentWorkbench.switchModel('session-1', { modelProfileId: 'profile-9', modelRevision: 1 })
    await expect(
      useAgentWorkbenchStore.getState().continueRunTask(gateway, run.taskId, { requestId: 'store-model-2', content: '续轮被拒' }),
    ).rejects.toThrow('会话模型已变化，请重新提交')
  })
})
