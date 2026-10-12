import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeCall, RuntimeEvent, RuntimePage } from '@elysian/contracts'
import type { ElysianGateway } from '../contracts/adapters'
import { AgentRunsMockAdapter, resetAgentRunsData } from '../adapters/mock/agent/agentRunsMockAdapter'
import { mergeCalls, mergeEvents, useAgentRunsStore } from './agentRunsStore'
import { resetAgentTestState } from '../test/agentTestUtils'

/*
 * 运行记录 store 的行为测试：过滤与分页（游标保持字符串）、事件乱序到达的
 * 去重与排序、切换 Run 丢弃过期响应、静默刷新不置 loading、取消写回详情、
 * 提交后列表可见。gateway 用 mock 实现（真实状态机），乱序事件用注入的
 * 假 gateway 模拟。
 */

function pageOf<T>(items: readonly T[], nextCursor = '', hasMore = false): RuntimePage<T> {
  return { items, nextCursor, hasMore }
}

/** 只含 agentRuns 域的网关假身：避免经共享 gateway 工厂牵连其他模块的在途文件。 */
function runsGateway(overrides?: Partial<ElysianGateway['agentRuns']>): ElysianGateway {
  const adapter = new AgentRunsMockAdapter()
  const agentRuns: ElysianGateway['agentRuns'] = {
    runtime: () => adapter.runtime(),
    submitBatch: (input) => adapter.submitBatch(input),
    listRuns: (query?, signal?) => adapter.listRuns(query, signal),
    getRun: (runId, signal?) => adapter.getRun(runId, signal),
    listRunCalls: (runId, query?, signal?) => adapter.listRunCalls(runId, query, signal),
    listRunEvents: (runId, query?, signal?) => adapter.listRunEvents(runId, query, signal),
    cancelRun: (runId) => adapter.cancelRun(runId),
    ...overrides,
  }
  return { agentRuns } as unknown as ElysianGateway
}

beforeEach(() => {
  vi.useRealTimers()
  resetAgentTestState()
  resetAgentRunsData()
  useAgentRunsStore.getState().reset()
})

describe('事件与调用合并', () => {
  it('乱序到达与重复投递按 seq 去重、数值升序', () => {
    const first: RuntimeEvent[] = [
      { runId: 'r', seq: '3', type: 'a', at: 't3' },
      { runId: 'r', seq: '1', type: 'a', at: 't1' },
    ]
    const second: RuntimeEvent[] = [
      { runId: 'r', seq: '9007199254740993', type: 'a', at: 't9' },
      { runId: 'r', seq: '2', type: 'a', at: 't2' },
      { runId: 'r', seq: '1', type: 'a', at: 't1' },
    ]
    expect(mergeEvents(first, second).map((event) => event.seq)).toEqual(['1', '2', '3', '9007199254740993'])
  })

  it('调用按 id 替换、stepIndex 升序', () => {
    const before: readonly RuntimeCall[] = [
      { id: 'c1', runId: 'r', tool: 't', status: 'running', stepIndex: 0, args: {}, truncated: false },
      { id: 'c2', runId: 'r', tool: 't', status: 'running', stepIndex: 1, args: {}, truncated: false },
    ]
    const after: readonly RuntimeCall[] = [
      { id: 'c2', runId: 'r', tool: 't', status: 'succeeded', stepIndex: 1, args: {}, truncated: false },
      { id: 'c0', runId: 'r', tool: 't', status: 'running', stepIndex: 2, args: {}, truncated: false },
    ]
    const merged = mergeCalls(before, after)
    expect(merged.map((call) => call.id)).toEqual(['c1', 'c2', 'c0'])
    expect(merged[1]?.status).toBe('succeeded')
  })
})

describe('列表：过滤、分页与静默刷新', () => {
  it('加载首页并按 status 单值过滤', async () => {
    const gateway = runsGateway()
    await useAgentRunsStore.getState().setFilters(gateway, { status: 'succeeded' })
    const list = useAgentRunsStore.getState().list
    expect(list.status).toBe('ready')
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.every((run) => run.status === 'succeeded')).toBe(true)
  })

  it('翻页保留首页顺序且游标为字符串', async () => {
    const base = new AgentRunsMockAdapter()
    // 种子共 14 条、服务端默认每页 50 条；注入小页宽让翻页路径真实走通。
    const gateway = runsGateway({
      listRuns: (query?, signal?) => base.listRuns({ ...query, limit: 6 }, signal),
    })
    const store = useAgentRunsStore.getState()
    await store.setFilters(gateway, {})
    const first = useAgentRunsStore.getState().list
    const firstIds = first.items.map((run) => run.id)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toMatch(/^(0|[1-9][0-9]*)$/)
    await store.loadMore(gateway)
    const second = useAgentRunsStore.getState().list
    expect(second.items.slice(0, firstIds.length).map((run) => run.id)).toEqual(firstIds)
    expect(second.items.length).toBeGreaterThan(firstIds.length)
  })

  it('静默刷新不置 refreshing/loading，失败保留内容并向轮询报告', async () => {
    let failNext = false
    const base = new AgentRunsMockAdapter()
    const gateway = runsGateway({
      listRuns: async (query?: never, signal?: AbortSignal) => {
        if (failNext) throw new Error('网络中断')
        return base.listRuns(query, signal)
      },
    })
    await useAgentRunsStore.getState().loadList(gateway)
    await useAgentRunsStore.getState().loadList(gateway, { silent: true })
    expect(useAgentRunsStore.getState().list.refreshing).toBe(false)
    expect(useAgentRunsStore.getState().list.status).toBe('ready')
    failNext = true
    await expect(useAgentRunsStore.getState().loadList(gateway, { silent: true })).rejects.toThrow('网络中断')
    expect(useAgentRunsStore.getState().list.status).toBe('ready')
    expect(useAgentRunsStore.getState().list.items.length).toBeGreaterThan(0)
  })

  it('静默首页回读保留已展开列表和后续页游标', async () => {
    const base = new AgentRunsMockAdapter()
    const gateway = runsGateway({
      listRuns: (query?, signal?) => base.listRuns({ ...query, limit: 6 }, signal),
    })
    const store = useAgentRunsStore.getState()
    await store.loadList(gateway)
    await store.loadMore(gateway)
    const expanded = useAgentRunsStore.getState().list
    expect(expanded.items).toHaveLength(12)
    expect(expanded.hasMore).toBe(true)

    await store.loadList(gateway, { silent: true })
    const refreshed = useAgentRunsStore.getState().list
    expect(refreshed.items.map((run) => run.id)).toEqual(expanded.items.map((run) => run.id))
    expect(refreshed.nextCursor).toBe(expanded.nextCursor)
    expect(refreshed.hasMore).toBe(true)

    await store.loadMore(gateway)
    const complete = useAgentRunsStore.getState().list
    expect(complete.hasMore).toBe(false)
    await store.loadList(gateway, { silent: true })
    expect(useAgentRunsStore.getState().list.items).toHaveLength(complete.items.length)
    expect(useAgentRunsStore.getState().list.hasMore).toBe(false)
  })
})

describe('详情：切换、增量与取消', () => {
  it('openRun 读取 Run + 事件 + 调用；事件按 seq 递增', async () => {
    const gateway = runsGateway()
    await useAgentRunsStore.getState().openRun(gateway, 'run-batch-ok')
    const detail = useAgentRunsStore.getState().detail
    expect(detail?.status).toBe('ready')
    expect(detail?.run?.id).toBe('run-batch-ok')
    expect(detail?.events.map((event) => event.seq)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
    expect(detail?.calls.map((call) => call.stepIndex)).toEqual([0, 1, 2, 3])
    expect(detail?.eventsCursor).toBe('11')
  })

  it('切换 Run 丢弃旧 Run 的过期响应', async () => {
    const gateway = runsGateway()
    await useAgentRunsStore.getState().openRun(gateway, 'run-batch-ok')
    await useAgentRunsStore.getState().openRun(gateway, 'run-agent-live')
    const detail = useAgentRunsStore.getState().detail
    expect(detail?.runId).toBe('run-agent-live')
    expect(detail?.events.every((event) => event.runId === 'run-agent-live')).toBe(true)
  })

  it('调用翻页使用服务端 nextCursor，静默回读不重置已展开范围', async () => {
    const base = new AgentRunsMockAdapter()
    const requestedCursors: (string | undefined)[] = []
    const gateway = runsGateway({
      getRun: async (runId, signal) => ({ ...await base.getRun(runId, signal), status: 'running' as const }),
      listRunCalls: (runId, query, signal) => {
        requestedCursors.push(query?.cursor)
        return base.listRunCalls(runId, { ...query, limit: 1 }, signal)
      },
    })
    const store = useAgentRunsStore.getState()
    await store.openRun(gateway, 'run-batch-ok')
    expect(useAgentRunsStore.getState().detail?.callsCursor).toBe('1')
    await store.loadMoreCalls(gateway)
    const expanded = useAgentRunsStore.getState().detail
    expect(requestedCursors).toEqual([undefined, '1'])
    expect(expanded?.calls.map((call) => call.stepIndex)).toEqual([0, 1])
    expect(expanded?.callsCursor).toBe('2')

    await store.refreshRun(gateway, { silent: true })
    expect(useAgentRunsStore.getState().detail?.callsCursor).toBe('2')
    expect(useAgentRunsStore.getState().detail?.callsHasMore).toBe(true)
    await store.loadMoreCalls(gateway)
    expect(requestedCursors).toEqual([undefined, '1', undefined, '2'])
    expect(useAgentRunsStore.getState().detail?.calls.map((call) => call.stepIndex)).toEqual([0, 1, 2])
  })

  it('详情静默读取失败保留事实并向轮询报告', async () => {
    const base = new AgentRunsMockAdapter()
    let fail = false
    const gateway = runsGateway({
      getRun: async (runId, signal) => {
        if (fail) throw new Error('连接中断')
        return base.getRun(runId, signal)
      },
    })
    const store = useAgentRunsStore.getState()
    await store.openRun(gateway, 'run-agent-live')
    const previous = useAgentRunsStore.getState().detail
    fail = true
    await expect(store.refreshRun(gateway, { silent: true })).rejects.toThrow('连接中断')
    expect(useAgentRunsStore.getState().detail?.run).toEqual(previous?.run)
    expect(useAgentRunsStore.getState().detail?.calls).toEqual(previous?.calls)
  })

  it('乱序到达的事件页合并后仍严格递增无重复', async () => {
    const base = new AgentRunsMockAdapter()
    let shuffledOnce = false
    const gateway = runsGateway({
      listRunEvents: async (runId: string, query?: { after?: string; limit?: number }, signal?: AbortSignal) => {
        const page = await base.listRunEvents(runId, query, signal)
        if (!shuffledOnce) {
          shuffledOnce = true
          return pageOf([...page.items].reverse(), page.nextCursor, page.hasMore)
        }
        return page
      },
    })
    await useAgentRunsStore.getState().openRun(gateway, 'run-batch-ok')
    const events = useAgentRunsStore.getState().detail?.events ?? []
    const seqs = events.map((event) => event.seq)
    expect(seqs).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('queued Run 取消立即写回 cancelled；running Run 取消写回请求时间', async () => {
    const gateway = runsGateway()
    const store = useAgentRunsStore.getState()
    // 种子 run-batch-queued 是冻结的排队 Run：取消立即生效。
    await store.openRun(gateway, 'run-batch-queued')
    const cancelled = await store.cancelRun(gateway, 'run-batch-queued')
    expect(cancelled.status).toBe('cancelled')
    expect(useAgentRunsStore.getState().detail?.run?.status).toBe('cancelled')

    // 提交新批次推进到 running 后取消：只写请求时间，不伪造终态。
    const bare = new AgentRunsMockAdapter()
    const submitted = await store.submitBatch(gateway, {
      requestId: 'store-cancel', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view', args: {} }, { tool: 'docker_images_list', args: {} }],
    })
    await bare.getRun(submitted.id) // 一拍：queued → running（裸读，不经 store 的多请求回读）
    const requested = await useAgentRunsStore.getState().cancelRun(gateway, submitted.id)
    expect(requested.status).toBe('running')
    expect(requested.cancelRequestedAt).toBeDefined()
    await bare.getRun(submitted.id) // 一拍：取消宽限后裁决
    const verdict = await bare.getRun(submitted.id)
    expect(verdict.status).toBe('cancelled')
    expect(verdict.endReason).toBe('cancelled')
  })

  it('提交后按 requestId 过滤只见一个 Run', async () => {
    const gateway = runsGateway()
    const store = useAgentRunsStore.getState()
    const first = await store.submitBatch(gateway, {
      requestId: 'store-dup', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view', args: {} }],
    })
    const second = await store.submitBatch(gateway, {
      requestId: 'store-dup', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view', args: {} }],
    })
    expect(second.id).toBe(first.id)
    await store.setFilters(gateway, { requestId: 'store-dup' })
    expect(useAgentRunsStore.getState().list.items).toHaveLength(1)
  })
})
