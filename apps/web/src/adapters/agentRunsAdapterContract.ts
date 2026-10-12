import { describe, expect, it } from 'vitest'
import type { AgentRunsAdapter } from '../contracts/adapters'

/**
 * 运行记录 adapter 的可复用契约断言（照 sessionAdapterContract 先例）：只依赖
 * AgentRunsAdapter 接口本身，对 mock 与 HTTP 两个实现各跑一遍同一套——这就是
 * 「mock 可替换」的验证方式。两个实现各自准备一个满足 world 约定的数据世界
 * （mock 用种子，HTTP 用带查询语义的 fetch stub）。
 */

export type AgentRunsContractWorld = {
  /** 已存在的成功 Run；详情、事件与调用断言以它为基准。 */
  succeededRunId: string
  /** 已存在的 interrupted Run；终态取消幂等断言以它为基准。 */
  interruptedRunId: string
  /** 列表里数量 ≥ 5、可按 limit=2 翻至少两页。 */
  enoughRunsForPaging: boolean
}

const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/

function compareCursors(a: string, b: string): number {
  const canon = (value: string) => value.replace(/^0+(?=\d)/, '')
  const left = canon(a)
  const right = canon(b)
  if (left === right) return 0
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left < right ? -1 : 1
}

export function runAgentRunsAdapterContract(
  name: string,
  make: () => AgentRunsAdapter,
  world: AgentRunsContractWorld,
): void {
  describe(`${name}：AgentRunsAdapter 契约`, () => {
    it('runtime() 给出 available 与 12 个能力位', async () => {
      const info = await make().runtime()
      expect(typeof info.available).toBe('boolean')
      for (const key of ['batch', 'agent', 'skills', 'mcp', 'containerExecution', 'approvals',
        'workflow', 'wiki', 'embedding', 'workflowV2', 'resourceLocks', 'executionRuntimes'] as const) {
        expect(typeof info[key]?.available).toBe('boolean')
      }
      expect(typeof info.worker).toBe('string')
      expect(typeof info.storage).toBe('string')
      expect(typeof info.queueDepth).toBe('number')
    })

    it('listRuns() 返回 Page 信封：条目有 id/status，lastSeq 为规范十进制字符串', async () => {
      const page = await make().listRuns()
      expect(page.items.length).toBeGreaterThan(0)
      expect(typeof page.nextCursor).toBe('string')
      expect(typeof page.hasMore).toBe('boolean')
      for (const run of page.items) {
        expect(typeof run.id).toBe('string')
        expect(typeof run.status).toBe('string')
        expect(CANONICAL_DECIMAL.test(run.lastSeq)).toBe(true)
      }
    })

    it('status 单值过滤：只返回该状态的 Run（多状态过滤不在此页实现）', async () => {
      const page = await make().listRuns({ status: 'succeeded' })
      expect(page.items.length).toBeGreaterThan(0)
      for (const run of page.items) expect(run.status).toBe('succeeded')
    })

    it('requestId 精确过滤：命中的 Run 携带该 requestId', async () => {
      const all = await make().listRuns()
      const hit = all.items.find((run) => run.requestId !== undefined)
      expect(hit).toBeDefined()
      const page = await make().listRuns({ requestId: hit?.requestId })
      expect(page.items.length).toBeGreaterThan(0)
      for (const run of page.items) expect(run.requestId).toBe(hit?.requestId)
    })

    it('非法入参在发出前拒绝：limit 越界、status 非法、游标带前导零', async () => {
      const adapter = make()
      await expect(adapter.listRuns({ limit: 0 })).rejects.toThrow('每页条数必须在 1 到 200 之间')
      await expect(adapter.listRuns({ limit: 201 })).rejects.toThrow('每页条数必须在 1 到 200 之间')
      await expect(adapter.listRuns({ status: 'bogus' as never })).rejects.toThrow('运行状态无效')
      await expect(adapter.listRuns({ cursor: '01' })).rejects.toThrow(/分页游标/)
      await expect(adapter.listRunEvents(world.succeededRunId, { after: '00' })).rejects.toThrow('事件序号')
    })

    it('分页游标保持十进制字符串且两页不重叠', async () => {
      const first = await make().listRuns({ limit: 2 })
      expect(first.items.length).toBeGreaterThan(0)
      expect(first.items.length).toBeLessThanOrEqual(2)
      if (!first.hasMore) return
      expect(CANONICAL_DECIMAL.test(first.nextCursor)).toBe(true)
      const second = await make().listRuns({ limit: 2, cursor: first.nextCursor })
      expect(second.items.length).toBeGreaterThan(0)
      const firstIds = new Set(first.items.map((run) => run.id))
      for (const run of second.items) expect(firstIds.has(run.id)).toBe(false)
    })

    it('getRun 回读已知 Run；未知 Run 抛中文错误', async () => {
      const run = await make().getRun(world.succeededRunId)
      expect(run.id).toBe(world.succeededRunId)
      expect(run.status).toBe('succeeded')
      await expect(make().getRun('run-does-not-exist')).rejects.toThrow(/不存在/)
    })

    it('事件流：after=0 首读 seq 严格递增无重复；after=lastSeq 只回更晚的事件', async () => {
      const first = await make().listRunEvents(world.succeededRunId, { after: '0' })
      expect(first.items.length).toBeGreaterThan(0)
      let previous = '0'
      const seen = new Set<string>()
      for (const event of first.items) {
        expect(CANONICAL_DECIMAL.test(event.seq)).toBe(true)
        expect(compareCursors(event.seq, previous)).toBeGreaterThan(0)
        expect(seen.has(event.seq)).toBe(false)
        seen.add(event.seq)
        previous = event.seq
      }
      const lastEvent = first.items[first.items.length - 1]
      expect(lastEvent).toBeDefined()
      const latest = lastEvent?.seq ?? '0'
      const tail = await make().listRunEvents(world.succeededRunId, { after: latest })
      for (const event of tail.items) {
        expect(compareCursors(event.seq, latest)).toBeGreaterThan(0)
      }
    })

    it('事件游标越过 lastSeq 报 future-cursor 口径的中文错误', async () => {
      const run = await make().getRun(world.succeededRunId)
      await expect(make().listRunEvents(world.succeededRunId, { after: String(BigInt(run.lastSeq) + 1n) }))
        .rejects.toThrow('事件游标超过当前运行进度')
    })

    it('调用列表：stepIndex 不减；argumentsJson 存在时是字符串原文', async () => {
      const page = await make().listRunCalls(world.succeededRunId, {})
      let previous = -1
      for (const call of page.items) {
        expect(call.stepIndex).toBeGreaterThanOrEqual(previous)
        previous = call.stepIndex
        if (call.argumentsJson !== undefined) expect(typeof call.argumentsJson).toBe('string')
      }
    })

    it('批次提交：requestId 幂等回读同一 Run，不同输入 409 口径中文错误', async () => {
      const adapter = make()
      const steps = [{ tool: 'docker_containers_list' as const, args: {} as Record<string, never> }]
      const submitted = await adapter.submitBatch({ requestId: 'contract-batch-1', kind: 'tool-batch', steps })
      expect(submitted.requestId).toBe('contract-batch-1')
      expect(['queued', 'running', 'succeeded']).toContain(submitted.status)
      const again = await adapter.submitBatch({ requestId: 'contract-batch-1', kind: 'tool-batch', steps })
      expect(again.id).toBe(submitted.id)
      await expect(adapter.submitBatch({
        requestId: 'contract-batch-1',
        kind: 'tool-batch',
        steps: [{ tool: 'docker_images_list' as const, args: {} as Record<string, never> }],
      })).rejects.toThrow('请求标识已用于不同的任务输入')
      const readBack = await adapter.getRun(submitted.id)
      expect(readBack.id).toBe(submitted.id)
    })

    it('批次提交白名单：未获准工具与非空参数在发出前拒绝', async () => {
      const adapter = make()
      const steps = [{ tool: 'docker_containers_list' as const, args: {} as Record<string, never> }]
      await expect(adapter.submitBatch({
        requestId: 'contract-batch-2',
        kind: 'tool-batch',
        steps: [{ tool: 'docker_restart' as never, args: {} as Record<string, never> }],
      })).rejects.toThrow('任务包含未获准的工具')
      await expect(adapter.submitBatch({
        requestId: 'contract-batch-2',
        kind: 'tool-batch',
        steps: [{ tool: 'docker_containers_list', args: { all: true } as never }],
      })).rejects.toThrow('首版只读工具不接受参数')
      await expect(adapter.submitBatch({
        requestId: 'bad request',
        kind: 'tool-batch',
        steps,
      } as never)).rejects.toThrow(/requestId|请求标识/)
      await expect(adapter.submitBatch({
        requestId: 'contract-batch-2',
        kind: 'agent' as never,
        steps,
      })).rejects.toThrow('只支持 tool-batch')
    })

    it('取消语义：终态 Run 取消幂等不变；queued Run 取消立即 cancelled', async () => {
      const adapter = make()
      const terminal = await adapter.cancelRun(world.interruptedRunId)
      expect(terminal.id).toBe(world.interruptedRunId)
      expect(terminal.status).toBe('interrupted')
      const submitted = await adapter.submitBatch({
        requestId: 'contract-batch-cancel',
        kind: 'tool-batch',
        steps: [{ tool: 'docker_policy_view' as const, args: {} as Record<string, never> }],
      })
      expect(['queued', 'running']).toContain(submitted.status)
      if (submitted.status === 'queued') {
        const cancelled = await adapter.cancelRun(submitted.id)
        expect(cancelled.status).toBe('cancelled')
        expect(cancelled.cancelRequestedAt).toBeDefined()
        expect(cancelled.endReason).toBe('cancelled')
      } else {
        // running：只落请求时间，返回仍非终态（「已请求取消」≠「已停止」）。
        const requested = await adapter.cancelRun(submitted.id)
        expect(requested.cancelRequestedAt).toBeDefined()
        expect(['running', 'cancelled']).toContain(requested.status)
      }
    })
  })
}
