import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeRunStatus } from '@elysian/contracts'
import {
  AGENT_RUNS_MOCK_BASE_TIME,
  agentRunsMockNow,
  agentRunsSeedSnapshot,
  mockCancelRun,
  mockGetRun,
  mockListRunCalls,
  mockListRunEvents,
  mockListRuns,
  mockSubmitBatch,
  resetAgentRunsData,
} from './agentRunsData'

/*
 * 确定性数据集与演示状态机的行为测试：种子复现（相对固定基准时间）、
 * rowid 降序分页（2^53 级游标保持字符串）、单值过滤、事件 after 增量、
 * submitBatch 幂等与 409 口径、取消语义（queued 立即 / running 先请求后裁决）、
 * 种子冻结（interrupted 不自动重跑）。
 */

beforeEach(() => {
  resetAgentRunsData()
})

describe('种子确定性', () => {
  it('两次复位后的种子快照完全一致（固定基准时间，无随机源）', () => {
    const first = agentRunsSeedSnapshot()
    resetAgentRunsData()
    const second = agentRunsSeedSnapshot()
    expect(second).toEqual(first)
  })

  it('虚拟时钟从固定基准出发，读取按 3 秒一拍推进', () => {
    expect(agentRunsMockNow()).toBe(AGENT_RUNS_MOCK_BASE_TIME)
    mockListRuns({})
    expect(agentRunsMockNow()).toBe('2026-10-10T08:00:03.000Z')
    mockGetRun('run-batch-ok')
    expect(agentRunsMockNow()).toBe('2026-10-10T08:00:06.000Z')
  })

  it('种子覆盖九种状态：冻结不因读取漂移（interrupted 不自动重跑）', () => {
    for (let index = 0; index < 30; index += 1) mockListRuns({})
    const statuses = new Set(agentRunsSeedSnapshot().map((run) => run.status))
    const expected = ['queued', 'running', 'waiting-approval', 'waiting-resource', 'recovery-required', 'succeeded', 'failed', 'cancelled', 'interrupted']
    for (const status of expected) {
      expect(statuses.has(status as RuntimeRunStatus)).toBe(true)
    }
    const interrupted = agentRunsSeedSnapshot().find((run) => run.status === 'interrupted')
    expect(interrupted?.endReason).toBe('panel-restarted')
  })
})

describe('Run 列表', () => {
  it('rowid 降序分页：游标保持十进制字符串，2^53 级数值不截断', () => {
    const first = mockListRuns({ limit: 6 })
    expect(first.items.map((run) => run.id)).toEqual([
      'run-batch-ok', 'run-batch-failed', 'run-batch-cancelled', 'run-agent-live', 'run-agent-approval', 'run-agent-resource',
    ])
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toBe('9007199254740995')
    expect(typeof first.nextCursor).toBe('string')
    // 9007199254740995 已越过 2^53；字符串原样保留、不经 number 往返。
    expect(String(BigInt(first.nextCursor))).toBe('9007199254740995')
    const second = mockListRuns({ limit: 6, cursor: first.nextCursor })
    expect(second.items.map((run) => run.id)).toEqual([
      'run-agent-interrupted', 'run-agent-recovery', 'run-agent-done', 'run-workflow-ok', 'run-batch-history-2', 'run-batch-history-1',
    ])
    expect(second.hasMore).toBe(true)
    expect(second.nextCursor).toBe('7001')
    const third = mockListRuns({ limit: 6, cursor: second.nextCursor })
    expect(third.items.map((run) => run.id)).toEqual(['run-batch-history-0', 'run-batch-queued'])
    expect(third.hasMore).toBe(false)
    expect(third.nextCursor).toBe('')
  })

  it('status 单值过滤与 requestId/sessionId/taskId/workflowId 精确过滤', () => {
    const succeeded = mockListRuns({ status: 'succeeded' })
    expect(succeeded.items.length).toBe(6)
    expect(succeeded.items.every((run) => run.status === 'succeeded')).toBe(true)
    expect(mockListRuns({ requestId: 'req-agent-live' }).items.map((run) => run.id)).toEqual(['run-agent-live'])
    expect(mockListRuns({ sessionId: 'session-demo-1' }).items.map((run) => run.id)).toEqual(['run-agent-live', 'run-agent-approval', 'run-agent-done'])
    expect(mockListRuns({ taskId: 'task-workflow-ok' }).items.map((run) => run.id)).toEqual(['run-workflow-ok'])
    expect(mockListRuns({ workflowId: 'wf-demo-1' }).items.map((run) => run.id)).toEqual(['run-workflow-ok'])
    expect(mockListRuns({ requestId: 'req-missing' }).items).toEqual([])
  })

  it('非法入参按服务端口径拒绝：limit 越界、status 非法、游标带前导零', () => {
    expect(() => mockListRuns({ limit: 0 })).toThrow('每页条数必须在 1 到 200 之间')
    expect(() => mockListRuns({ limit: 201 })).toThrow('每页条数必须在 1 到 200 之间')
    expect(() => mockListRuns({ status: 'bogus' })).toThrow('运行状态无效')
    expect(() => mockListRuns({ cursor: '01' })).toThrow('分页游标无效')
  })
})

describe('事件与调用', () => {
  it('events 按 after 增量：seq 严格递增、无重复；空页保留当前游标', () => {
    const first = mockListRunEvents('run-batch-ok', { after: '0' })
    expect(first.items.map((event) => event.seq)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
    expect(first.nextCursor).toBe('11')
    expect(first.hasMore).toBe(false)
    const empty = mockListRunEvents('run-batch-ok', { after: '11' })
    expect(empty.items).toEqual([])
    expect(empty.nextCursor).toBe('11')
  })

  it('events 游标越过 lastSeq 报 future-cursor 口径中文错误；非法 after 拒绝', () => {
    expect(() => mockListRunEvents('run-batch-ok', { after: '12' })).toThrow('事件游标超过当前运行进度')
    expect(() => mockListRunEvents('run-batch-ok', { after: '0x1' })).toThrow('事件序号必须为非负十进制字符串')
  })

  it('events 分页：limit 截断时 hasMore 且 nextCursor 为当页最后 seq', () => {
    const page = mockListRunEvents('run-batch-ok', { after: '0', limit: 4 })
    expect(page.items.map((event) => event.seq)).toEqual(['1', '2', '3', '4'])
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe('4')
    const rest = mockListRunEvents('run-batch-ok', { after: '4', limit: 100 })
    expect(rest.items.map((event) => event.seq)).toEqual(['5', '6', '7', '8', '9', '10', '11'])
  })

  it('calls 按 stepIndex 升序与游标翻页；未知 Run 抛中文错误', () => {
    const all = mockListRunCalls('run-batch-ok', {})
    expect(all.items.map((call) => call.stepIndex)).toEqual([0, 1, 2, 3])
    expect(all.items.map((call) => call.tool)).toEqual([
      'docker_containers_list', 'docker_images_list', 'docker_policy_view', 'docker_self_container',
    ])
    const paged = mockListRunCalls('run-batch-ok', { cursor: '2' })
    expect(paged.items.map((call) => call.stepIndex)).toEqual([2, 3])
    expect(() => mockListRunCalls('run-does-not-exist', {})).toThrow('演示数据中不存在 Run run-does-not-exist')
    expect(() => mockListRunEvents('run-does-not-exist', {})).toThrow('演示数据中不存在 Run run-does-not-exist')
  })
})

describe('批次提交状态机', () => {
  it('requestId 幂等：同键同步骤回读原 Run，不产生第二个 Run', () => {
    const before = mockListRuns({}).items.length
    const submitted = mockSubmitBatch({ requestId: 'req-1', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view' }] })
    expect(submitted.status).toBe('queued')
    expect(submitted.driverVersion).toBe('v1')
    const again = mockSubmitBatch({ requestId: 'req-1', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view' }] })
    expect(again.id).toBe(submitted.id)
    expect(mockListRuns({ requestId: 'req-1' }).items).toHaveLength(1)
    expect(mockListRuns({}).items.length).toBe(before + 1)
  })

  it('同键不同步骤报 409 口径中文错误；白名单与参数预检', () => {
    mockSubmitBatch({ requestId: 'req-2', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view' }] })
    expect(() => mockSubmitBatch({ requestId: 'req-2', kind: 'tool-batch', steps: [{ tool: 'docker_images_list' }] }))
      .toThrow('请求标识已用于不同的任务输入')
    expect(() => mockSubmitBatch({ requestId: 'req-2', kind: 'tool-batch', steps: [{ tool: 'rm-rf' }] }))
      .toThrow('任务包含未获准的工具')
    expect(() => mockSubmitBatch({ requestId: 'req-2', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view', args: { all: true } }] }))
      .toThrow('首版只读工具不接受参数')
    expect(() => mockSubmitBatch({ requestId: '空格 不合法', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view' }] }))
      .toThrow('请求标识必须为 1 到 128 位字母、数字或 ._:-')
    expect(() => mockSubmitBatch({ requestId: 'req-3', kind: 'agent', steps: [{ tool: 'docker_policy_view' }] }))
      .toThrow('只支持 tool-batch 顺序工具任务')
  })

  it('读取推进：queued → running（call/started）→ 逐步骤 finished → succeeded', () => {
    const submitted = mockSubmitBatch({
      requestId: 'req-flow',
      kind: 'tool-batch',
      steps: [{ tool: 'docker_containers_list' }, { tool: 'docker_self_container' }],
    })
    expect(submitted.lastSeq).toBe('1')
    // 第一拍：进入 running，步骤 0 开始。
    const running = mockGetRun(submitted.id)
    expect(running.status).toBe('running')
    expect(running.startedAt).toBeDefined()
    // 第二拍：步骤 0 完成、步骤 1 开始。
    mockGetRun(submitted.id)
    // 第三拍（事件读取也推进一拍）：步骤 1 完成。
    const events = mockListRunEvents(submitted.id, { after: '0' })
    expect(events.items.map((event) => event.type)).toEqual([
      'run/queued', 'run/started', 'call/started', 'call/finished', 'call/started', 'call/finished',
    ])
    // 第四拍：收尾成功。
    const done = mockGetRun(submitted.id)
    expect(done.status).toBe('succeeded')
    expect(done.endReason).toBe('completed')
    expect(done.usage.calls).toBe(2)
    expect(done.usage.resultBytes).toBeGreaterThan(0)
    const calls = mockListRunCalls(submitted.id, {})
    expect(calls.items.map((call) => call.status)).toEqual(['succeeded', 'succeeded'])
    expect(calls.items.map((call) => call.tool)).toEqual(['docker_containers_list', 'docker_self_container'])
  })

  it('queued 取消立即 cancelled；running 取消先落请求时间、下一拍裁决', () => {
    const queuedRun = mockSubmitBatch({ requestId: 'req-cancel-1', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view' }] })
    const cancelled = mockCancelRun(queuedRun.id)
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelRequestedAt).toBeDefined()
    expect(cancelled.endReason).toBe('cancelled')

    const runningRun = mockSubmitBatch({ requestId: 'req-cancel-2', kind: 'tool-batch', steps: [{ tool: 'docker_policy_view' }] })
    mockGetRun(runningRun.id) // 一拍：进入 running
    const requested = mockCancelRun(runningRun.id)
    expect(requested.status).toBe('running')
    expect(requested.cancelRequestedAt).toBeDefined()
    const verdict = mockGetRun(runningRun.id) // 一拍：宽限后裁决
    expect(verdict.status).toBe('cancelled')
    expect(verdict.endReason).toBe('cancelled')
    const events = mockListRunEvents(runningRun.id, { after: '0' })
    expect(events.items.map((event) => event.type)).toContain('run/cancel-requested')
    expect(events.items.map((event) => event.type)).toContain('run/cancelled')
  })

  it('终态 Run 取消幂等不变', () => {
    const before = mockGetRun('run-batch-ok')
    const after = mockCancelRun('run-batch-ok')
    expect(after.status).toBe('succeeded')
    expect(after.cancelRequestedAt).toBeUndefined()
    expect(after.endedAt).toBe(before.endedAt)
  })
})
